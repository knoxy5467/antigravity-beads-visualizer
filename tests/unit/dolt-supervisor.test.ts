import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DoltSupervisor,
  probeTcpPort,
} from '../../sidecars/beads-gatekeeper/dolt-supervisor.js';
import {
  isOptInWorkspace,
  loadOptInConfig,
  readBeadsDoltMetadata,
  saveOptInConfig,
} from '../../sidecars/beads-gatekeeper/workspace-registry.js';

function createTempRepo(withMetadata = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'bv-dolt-'));
  const beadsDir = join(dir, '.beads');
  mkdirSync(beadsDir, { recursive: true });
  if (withMetadata) {
    writeFileSync(
      join(beadsDir, 'metadata.json'),
      JSON.stringify({
        database: 'dolt',
        backend: 'dolt',
        dolt_mode: 'server',
        dolt_server_port: 3307,
        dolt_database: 'bv',
      }),
      'utf-8'
    );
  }
  return dir;
}

test('loadOptInConfig returns empty list when missing and saveOptInConfig persists valid entries', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bv-pdata-'));
  const repoDir = createTempRepo();
  const nonRepoDir = mkdtempSync(join(tmpdir(), 'bv-nonrepo-'));
  const configPath = join(dataDir, 'config.json');
  try {
    const initial = await loadOptInConfig(configPath);
    assert.deepEqual(initial.workspaces, []);

    await saveOptInConfig(configPath, {
      workspaces: [
        {
          workspacePath: repoDir,
          autoStartDolt: true,
          autoCheckGates: true,
          pollIntervalMs: 15000,
          maxConcurrentWorkers: 2,
        },
        {
          workspacePath: nonRepoDir,
          autoStartDolt: true,
          autoCheckGates: true,
          pollIntervalMs: 15000,
          maxConcurrentWorkers: 1,
        },
      ],
    });

    const reloaded = await loadOptInConfig(configPath);
    assert.equal(reloaded.workspaces.length, 1);
    assert.equal(reloaded.workspaces[0]?.workspacePath, repoDir);
    assert.equal(isOptInWorkspace(reloaded, repoDir), true);
    assert.equal(isOptInWorkspace(reloaded, nonRepoDir), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(nonRepoDir, { recursive: true, force: true });
  }
});

test('readBeadsDoltMetadata parses server mode and defaults embedded when metadata is missing', async () => {
  const repoDir = createTempRepo(true);
  const noMetaDir = createTempRepo(false);
  try {
    const meta = await readBeadsDoltMetadata(repoDir);
    assert.equal(meta.doltMode, 'server');
    assert.equal(meta.doltServerPort, 3307);
    assert.equal(meta.doltDatabase, 'bv');

    const fallback = await readBeadsDoltMetadata(noMetaDir);
    assert.equal(fallback.doltMode, 'embedded');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(noMetaDir, { recursive: true, force: true });
  }
});

test('probeTcpPort returns true on listening loopback server and false on closed port', async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as net.AddressInfo;
  try {
    assert.equal(await probeTcpPort(addr.port, '127.0.0.1', 500), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(await probeTcpPort(addr.port, '127.0.0.1', 300), false);
});

test('DoltSupervisor skips when autoStartDolt is false and detects port_conflict without killing foreign listener', async () => {
  const repoDir = createTempRepo(false);
  const freeProbe = net.createServer();
  await new Promise<void>((resolve) => freeProbe.listen(0, '127.0.0.1', resolve));
  const targetPort = (freeProbe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => freeProbe.close(() => resolve()));

  writeFileSync(
    join(repoDir, '.beads', 'metadata.json'),
    JSON.stringify({
      dolt_mode: 'server',
      dolt_server_port: targetPort,
      dolt_database: 'bv',
    }),
    'utf-8'
  );

  let spawnCount = 0;
  const supervisor = new DoltSupervisor({
    spawnDolt: () => {
      spawnCount += 1;
      return { pid: 99999, kill: () => true };
    },
  });

  const foreignServer = net.createServer();
  try {
    const skipped = await supervisor.reconcileWorkspace({
      workspacePath: repoDir,
      autoStartDolt: false,
      autoCheckGates: false,
      pollIntervalMs: 10000,
      maxConcurrentWorkers: 1,
    });
    assert.equal(skipped.status, 'stopped');
    assert.equal(spawnCount, 0);

    await new Promise<void>((resolve) => foreignServer.listen(targetPort, '127.0.0.1', resolve));
    const conflict = await supervisor.reconcileWorkspace({
      workspacePath: repoDir,
      autoStartDolt: true,
      autoCheckGates: true,
      pollIntervalMs: 10000,
      maxConcurrentWorkers: 1,
    });
    assert.equal(conflict.status, 'port_conflict');
    assert.equal(conflict.port, targetPort);
    assert.equal(spawnCount, 0);
    assert.equal(foreignServer.listening, true);
  } finally {
    if (foreignServer.listening) {
      await new Promise<void>((resolve) => foreignServer.close(() => resolve()));
    }
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('DoltSupervisor starts Dolt when port is free and applies exponential backoff on repeated failures', async () => {
  const repoDir = createTempRepo(false);
  const dummyServer = net.createServer();
  await new Promise<void>((resolve) => dummyServer.listen(0, '127.0.0.1', resolve));
  const freePort = (dummyServer.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => dummyServer.close(() => resolve()));

  writeFileSync(
    join(repoDir, '.beads', 'metadata.json'),
    JSON.stringify({
      dolt_mode: 'server',
      dolt_server_port: freePort,
      dolt_database: 'bv',
    }),
    'utf-8'
  );

  let nowMs = 1000;
  let attempts = 0;
  let shouldSucceed = false;
  let spawned = false;
  let killedPid = false;

  const supervisor = new DoltSupervisor({
    now: () => nowMs,
    probePort: async () => spawned,
    spawnDolt: () => {
      attempts += 1;
      if (!shouldSucceed) {
        throw new Error('dolt start failed');
      }
      spawned = true;
      return {
        pid: 43210,
        kill: () => {
          killedPid = true;
          return true;
        },
      };
    },
  });

  try {
    const entry = {
      workspacePath: repoDir,
      autoStartDolt: true,
      autoCheckGates: true,
      pollIntervalMs: 10000,
      maxConcurrentWorkers: 1,
    };

    const fail1 = await supervisor.reconcileWorkspace(entry);
    assert.equal(fail1.status, 'error');
    assert.equal(attempts, 1);

    // Backoff blocks immediate retry at nowMs = 1500
    nowMs = 1500;
    const backedOff = await supervisor.reconcileWorkspace(entry);
    assert.equal(backedOff.status, 'error');
    assert.equal(attempts, 1);

    // After backoff expires, allow startup to succeed
    nowMs = 10000;
    shouldSucceed = true;
    const running = await supervisor.reconcileWorkspace(entry);
    assert.equal(running.status, 'running');
    assert.equal(running.pid, 43210);
    assert.equal(attempts, 2);

    supervisor.stopAll();
    assert.equal(killedPid, true);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
