import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  AgyCliAgentAdapter,
  DesktopAgentAdapter,
  HybridAgentManager,
} from '../../sidecars/beads-gatekeeper/agent-manager.js';
import { DoltSupervisor } from '../../sidecars/beads-gatekeeper/dolt-supervisor.js';
import { GatekeeperEngine } from '../../sidecars/beads-gatekeeper/gatekeeper.js';
import { runSidecarOnce } from '../../sidecars/beads-gatekeeper/main.js';
import { SidecarStateStore } from '../../sidecars/beads-gatekeeper/state-store.js';
import type { DoltHealthState, GateMonitorState, OptInWorkspaceConfig } from '../../sidecars/beads-gatekeeper/types.js';
import { saveOptInConfig } from '../../sidecars/beads-gatekeeper/workspace-registry.js';
import { WorkflowDriver } from '../../sidecars/beads-gatekeeper/workflow-driver.js';

test('WorkflowDriver initiates conversations for ready work, resolved gates, failed hooks, and manual epics without duplicates', async () => {
  const spawned: Array<{ beadId: string; runtime: string; prompt: string }> = [];
  const desktopAdapter = new DesktopAgentAdapter({
    lsAddress: '',
    sidecarSdk: {
      startConversation: async (_ws, _prompt) => {
        const idx = spawned.length + 1;
        return { conversationId: `conv-auto-${idx}` };
      },
      sendMessage: async () => undefined,
    },
  });
  const agyAdapter = new AgyCliAgentAdapter();
  const agentManager = new HybridAgentManager({ desktopAdapter, agyAdapter });

  const originalSpawn = agentManager.spawnAgent.bind(agentManager);
  agentManager.spawnAgent = async (input) => {
    spawned.push({ beadId: input.beadId, runtime: input.runtime, prompt: input.prompt });
    return originalSpawn(input);
  };

  const driver = new WorkflowDriver({
    agentManager,
    now: () => '2026-11-27T04:00:00Z',
    runBd: async (args) => {
      if (args[0] === 'ready') {
        return JSON.stringify([
          { id: 'bv-ready-1', title: 'Implement feature A', issue_type: 'task', priority: 1 },
        ]);
      }
      return '[]';
    },
  });

  const wsConfig: OptInWorkspaceConfig = {
    workspacePath: '/synthetic/repo',
    autoStartDolt: true,
    autoCheckGates: true,
    autoDriveWorkflows: true,
    defaultWorkflowRuntime: 'desktop',
    pollIntervalMs: 10000,
    maxConcurrentWorkers: 4,
  };
  const doltHealth: DoltHealthState = {
    workspacePath: '/synthetic/repo',
    port: 3307,
    database: 'bv',
    status: 'running',
  };
  const gateState: GateMonitorState = {
    workspacePath: '/synthetic/repo',
    lastRunAt: '2026-11-27T04:00:00Z',
    discoveredCount: 1,
    resolvedGates: ['bv-gate-ci'],
    escalatedGates: [],
    readyMolecules: ['bv-mol-ready-1'],
    failedHooks: [
      {
        id: 'hk-fail-1',
        hookName: 'pre-push',
        workspacePath: '/synthetic/repo',
        gateId: 'bv-gate-ci',
        status: 'failed',
        exitCode: 1,
        detail: 'Typecheck failed.',
        timestamp: '2026-11-27T03:59:00Z',
      },
    ],
  };

  const firstDispatches = await driver.driveWorkspace(wsConfig, doltHealth, gateState);
  assert.equal(firstDispatches.length, 3);
  assert.ok(firstDispatches.some((d) => d.trigger === 'ready_work' && d.beadId === 'bv-ready-1'));
  assert.ok(firstDispatches.some((d) => d.trigger === 'gate_resolved' && d.beadId === 'bv-mol-ready-1'));
  assert.ok(firstDispatches.some((d) => d.trigger === 'gate_hook_failed' && d.beadId === 'bv-gate-ci'));

  // Second run with the same inputs must deduplicate dispatches
  const secondDispatches = await driver.driveWorkspace(wsConfig, doltHealth, gateState);
  assert.equal(secondDispatches.length, 0);

  // Manual epic drive initiates a conversation
  const epicDispatch = await driver.driveEpic({
    workspacePath: '/synthetic/repo',
    epicId: 'bv-epic-1',
    runtime: 'desktop',
    maxConcurrentWorkers: 4,
    prompt: 'Execute epic bv-epic-1.',
  });
  assert.equal(epicDispatch.trigger, 'manual_epic');
  assert.equal(epicDispatch.beadId, 'bv-epic-1');
  assert.equal(epicDispatch.status, 'dispatched');
  assert.ok(epicDispatch.conversationId?.startsWith('conv-auto-'));
});

test('runSidecarOnce restores monitored gates after restart, drains hook events, and processes drive_epic commands', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bv-sidecar-restart-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'bv-sidecar-repo-'));
  mkdirSync(join(repoDir, '.beads'), { recursive: true });
  writeFileSync(join(repoDir, '.beads', 'metadata.json'), JSON.stringify({ dolt_mode: 'embedded' }), 'utf8');

  try {
    const store = new SidecarStateStore(dataDir);
    await saveOptInConfig(store.configPath, {
      workspaces: [
        {
          workspacePath: repoDir,
          autoStartDolt: false,
          autoCheckGates: true,
          autoDriveWorkflows: false,
          defaultWorkflowRuntime: 'desktop',
          pollIntervalMs: 10000,
          maxConcurrentWorkers: 2,
        },
      ],
    });

    await store.writeState({
      updatedAt: '2026-11-27T03:00:00Z',
      daemonPid: 1111,
      doltStates: [],
      gateStates: [],
      agents: [
        {
          id: 'agent-prev-1',
          runtime: 'desktop',
          beadId: 'bv-old-task',
          workspacePath: repoDir,
          status: 'running',
          conversationId: 'conv-prev-1',
          startedAt: '2026-11-27T02:50:00Z',
          updatedAt: '2026-11-27T03:00:00Z',
        },
      ],
      monitoredGates: [
        {
          workspacePath: repoDir,
          gateId: 'bv-gate-prev',
          status: 'monitoring',
          waiters: ['conv-prev-1'],
          lastCheckedAt: '2026-11-27T02:59:00Z',
        },
      ],
      hookEvents: [],
      workflowRuns: [],
      notifiedKeys: [],
    });

    await store.appendHookEvent({
      id: 'hk-restart-1',
      hookName: 'pre-push',
      workspacePath: repoDir,
      gateId: 'bv-gate-prev',
      status: 'passed',
      exitCode: 0,
      timestamp: '2026-11-27T03:01:00Z',
    });

    await store.appendCommand({
      type: 'drive_epic',
      workspacePath: repoDir,
      epicId: 'bv-epic-restart',
      runtime: 'desktop',
      prompt: 'Drive epic after restart.',
      requestedAt: '2026-11-27T03:01:05Z',
    });

    const desktopAdapter = new DesktopAgentAdapter({
      lsAddress: '',
      sidecarSdk: {
        startConversation: async () => ({ conversationId: 'conv-new-epic' }),
        sendMessage: async () => undefined,
      },
    });
    const agyAdapter = new AgyCliAgentAdapter();
    const agentManager = new HybridAgentManager({ desktopAdapter, agyAdapter });

    const doltSupervisor = {
      reconcileAll: async () => [
        {
          workspacePath: repoDir,
          port: 3307,
          database: 'bv',
          status: 'running' as const,
        },
      ],
      stopAll: async () => undefined,
    } as unknown as DoltSupervisor;

    const gatekeeper = new GatekeeperEngine({
      runBd: async (args) => {
        if (args[0] === 'gate' && args[1] === 'list') {
          return JSON.stringify([
            { id: 'bv-gate-prev', title: 'CI Gate', await_type: 'gh:run', status: 'open', waiters: ['conv-prev-1'] },
          ]);
        }
        return '[]';
      },
    });

    const workflowDriver = new WorkflowDriver({
      agentManager,
      runBd: async () => '[]',
    });

    const snapshot = await runSidecarOnce({
      dataDir,
      doltSupervisor,
      gatekeeper,
      agentManager,
      workflowDriver,
    });

    assert.ok(snapshot.restartedAt);
    assert.equal(snapshot.monitoredGates?.some((g) => g.gateId === 'bv-gate-prev' && g.rehydrated), true);
    assert.equal(snapshot.hookEvents?.some((e) => e.id === 'hk-restart-1' && e.status === 'passed'), true);
    assert.equal(snapshot.agents.some((a) => a.conversationId === 'conv-prev-1'), true);
    assert.equal(snapshot.workflowRuns?.some((r) => r.beadId === 'bv-epic-restart' && r.conversationId === 'conv-new-epic'), true);
    assert.equal(resolve(snapshot.doltStates[0]?.workspacePath ?? ''), resolve(repoDir));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});
