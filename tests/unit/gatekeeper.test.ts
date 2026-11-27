import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GatekeeperEngine } from '../../sidecars/beads-gatekeeper/gatekeeper.js';
import { SidecarStateStore } from '../../sidecars/beads-gatekeeper/state-store.js';
import type { DoltHealthState, OptInWorkspaceConfig } from '../../sidecars/beads-gatekeeper/types.js';

test('SidecarStateStore reads default snapshot, persists state atomically, and drains commands', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bv-store-'));
  try {
    const store = new SidecarStateStore(dataDir);
    const empty = await store.readState();
    assert.deepEqual(empty.doltStates, []);
    assert.deepEqual(empty.gateStates, []);
    assert.deepEqual(empty.agents, []);

    await store.writeState({
      updatedAt: '2026-11-27T00:00:00Z',
      daemonPid: 1234,
      doltStates: [],
      gateStates: [],
      agents: [],
    });
    const loaded = await store.readState();
    assert.equal(loaded.daemonPid, 1234);

    await store.appendCommand({
      type: 'resolve_gate',
      workspacePath: '/synthetic/repo',
      gateId: 'bv-gate-1',
      reason: 'Approved',
      requestedAt: '2026-11-27T00:00:01Z',
    });
    const firstDrain = await store.drainCommands();
    assert.equal(firstDrain.length, 1);
    assert.equal(firstDrain[0]?.type, 'resolve_gate');

    const secondDrain = await store.drainCommands();
    assert.equal(secondDrain.length, 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('GatekeeperEngine skips disabled or unhealthy workspaces and deduplicates waiter notifications', async () => {
  const wsConfig: OptInWorkspaceConfig = {
    workspacePath: '/synthetic/repo-a',
    autoStartDolt: true,
    autoCheckGates: true,
    pollIntervalMs: 10000,
    maxConcurrentWorkers: 2,
  };
  const disabledConfig: OptInWorkspaceConfig = {
    workspacePath: '/synthetic/repo-b',
    autoStartDolt: false,
    autoCheckGates: false,
    pollIntervalMs: 10000,
    maxConcurrentWorkers: 1,
  };

  const calls: string[] = [];
  const notifications: Array<{ waiter: string; gateId: string; status: string }> = [];

  const engine = new GatekeeperEngine({
    now: () => '2026-11-27T00:00:00Z',
    runBd: async (args, cwd) => {
      const cmd = args.join(' ');
      calls.push(`${cwd}:${cmd}`);
      if (cmd.startsWith('gate discover')) {
        return JSON.stringify([{ gate_id: 'bv-gate-ci' }]);
      }
      if (cmd.startsWith('gate check')) {
        return JSON.stringify({
          resolved: [{ id: 'bv-gate-ci', waiters: ['conv-101'] }],
          escalated: [{ id: 'bv-gate-fail', waiters: ['conv-202'], reason: 'CI failed' }],
        });
      }
      if (cmd.startsWith('mol ready')) {
        return JSON.stringify([{ id: 'bv-mol-1' }]);
      }
      if (cmd.startsWith('reclaim')) {
        return JSON.stringify([]);
      }
      if (cmd.startsWith('gate resolve')) {
        return JSON.stringify({ closed: true });
      }
      return '[]';
    },
    notifyWaiter: async (waiter, gateId, status) => {
      notifications.push({ waiter, gateId, status });
    },
  });

  const conflictHealth: DoltHealthState = {
    workspacePath: '/synthetic/repo-a',
    port: 3307,
    database: 'bv',
    status: 'port_conflict',
  };
  const skippedConflict = await engine.runCycleForWorkspace(wsConfig, conflictHealth);
  assert.equal(calls.length, 0);
  assert.match(skippedConflict.lastError || '', /port_conflict/i);

  const healthyDolt: DoltHealthState = {
    workspacePath: '/synthetic/repo-a',
    port: 3307,
    database: 'bv',
    status: 'running',
  };
  const state1 = await engine.runCycleForWorkspace(wsConfig, healthyDolt);
  assert.equal(state1.discoveredCount, 1);
  assert.deepEqual(state1.resolvedGates, ['bv-gate-ci']);
  assert.deepEqual(state1.escalatedGates, ['bv-gate-fail']);
  assert.deepEqual(state1.readyMolecules, ['bv-mol-1']);
  assert.equal(notifications.length, 2);

  // Second tick with identical results must not re-notify the same waiters
  await engine.runCycleForWorkspace(wsConfig, healthyDolt);
  assert.equal(notifications.length, 2);

  // Disabled autoCheckGates skips bd calls
  const disabledCallsBefore = calls.length;
  await engine.runCycleForWorkspace(disabledConfig, {
    workspacePath: '/synthetic/repo-b',
    port: 3308,
    database: 'bv',
    status: 'running',
  });
  assert.equal(calls.length, disabledCallsBefore);

  await engine.resolveHumanGate('/synthetic/repo-a', 'bv-gate-human', 'Approved by user');
  assert.ok(calls.some((c) => c.includes('gate resolve bv-gate-human --reason Approved by user --json')));
  await assert.rejects(() => engine.resolveHumanGate('/synthetic/repo-a', 'add', 'Bad ID'));
});
