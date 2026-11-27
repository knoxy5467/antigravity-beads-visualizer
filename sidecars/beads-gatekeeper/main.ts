// @scry.entry
// id: sidecars.gatekeeper-main~1b0edeea
// kind: code
// summary: >-
//   Run the continuous Beads Gatekeeper sidecar loop for Dolt supervision, gate checks, and worker dispatch.
//   Also: sidecar, main, daemon, dolt-supervisor, gatekeeper, agent-manager, workflow-driver
// status: active
// weight: 0.95
// tags: ["topic:sidecar", "sidecar", "scope:sidecars", "sidecars", "daemon", "beads"]
// rationale: >-
//   Coordinates workspace Dolt servers, deterministic gate evaluation, restart recovery, and workflow initiation.
// applies: running sidecar daemon, restoring monitored gates on restart, driving epics and hook recovery
// seeded_questions:
//   - "How does main.ts restore monitored gates and initiate workflow conversations after a restart?"
//   - "sidecars/beads-gatekeeper/main.ts runSidecarOnce"
// @scry.entry.end

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  AgyCliAgentAdapter,
  DesktopAgentAdapter,
  HybridAgentManager,
} from "./agent-manager.js";
import { DoltSupervisor } from "./dolt-supervisor.js";
import { GatekeeperEngine } from "./gatekeeper.js";
import { resolvePluginDataDir, SidecarStateStore } from "./state-store.js";
import type { SidecarStateSnapshot } from "./types.js";
import { WorkflowDriver } from "./workflow-driver.js";
import { loadOptInConfig } from "./workspace-registry.js";

export interface SidecarCycleOptions {
  dataDir?: string;
  appDataDir?: string;
  doltSupervisor?: DoltSupervisor;
  gatekeeper?: GatekeeperEngine;
  agentManager?: HybridAgentManager;
  workflowDriver?: WorkflowDriver;
  hydrated?: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;

/**
 * Execute one deterministic sidecar reconciliation cycle, hydrate restart state, and persist state.json.
 */
export async function runSidecarOnce(
  options: SidecarCycleOptions = {},
): Promise<SidecarStateSnapshot> {
  const dataDir = options.dataDir ?? resolvePluginDataDir();
  const stateStore = new SidecarStateStore(dataDir);
  const previous = await stateStore.readState();
  const nowIso = new Date().toISOString();

  const agentManager =
    options.agentManager ??
    new HybridAgentManager({
      desktopAdapter: new DesktopAgentAdapter(),
      agyAdapter: new AgyCliAgentAdapter(),
      appDataDir: options.appDataDir,
    });

  const doltSupervisor = options.doltSupervisor ?? new DoltSupervisor();
  const gatekeeper =
    options.gatekeeper ??
    new GatekeeperEngine({
      notifyWaiter: async (waiter, gateId, status, reason) => {
        if (!waiter || waiter.startsWith("bv-")) {
          return;
        }
        try {
          await agentManager.sendMessageToAgent(
            waiter,
            `Gate ${gateId} is now ${status}.${reason ? ` Reason: ${reason}` : ""}`,
          );
        } catch {
          // Keep gatekeeper cycle resilient when a waiter conversation is closed.
        }
      },
    });
  const workflowDriver =
    options.workflowDriver ??
    new WorkflowDriver({
      agentManager,
    });

  if (!options.hydrated) {
    gatekeeper.hydrate({
      monitoredGates: previous.monitoredGates,
      hookEvents: previous.hookEvents,
      notifiedKeys: previous.notifiedKeys,
    });
    agentManager.hydrateAgents(previous.agents || []);
    workflowDriver.hydrate(previous.workflowRuns || []);
  }

  const drainedHooks = await stateStore.drainHookEvents();
  const hookEvents = gatekeeper.ingestHookEvents(drainedHooks);

  const configPath = path.join(dataDir, "config.json");
  const config = await loadOptInConfig(configPath);
  const doltStates = await doltSupervisor.reconcileAll(config.workspaces);
  const gateStates = await gatekeeper.runAll(config.workspaces, doltStates);

  for (let i = 0; i < config.workspaces.length; i += 1) {
    const ws = config.workspaces[i];
    const dolt = doltStates[i] ?? {
      workspacePath: ws.workspacePath,
      port: 0,
      database: "beads",
      status: "stopped" as const,
    };
    const gate = gateStates[i];
    if (gate) {
      await workflowDriver.driveWorkspace(ws, dolt, gate);
    }
  }

  const commands = await stateStore.drainCommands();
  for (const command of commands) {
    const workspaceCfg = config.workspaces.find(
      (ws) => path.resolve(ws.workspacePath).toLowerCase() === path.resolve(command.workspacePath).toLowerCase(),
    );
    const maxConcurrentWorkers = workspaceCfg?.maxConcurrentWorkers ?? 2;

    if (command.type === "resolve_gate") {
      try {
        await gatekeeper.resolveHumanGate(command.workspacePath, command.gateId, command.reason);
      } catch {
        // Keep sidecar cycle active when one gate command fails.
      }
      continue;
    }

    if (command.type === "spawn_agent") {
      try {
        await agentManager.spawnAgent({
          workspacePath: command.workspacePath,
          beadId: command.beadId,
          runtime: command.runtime,
          prompt: command.prompt,
          maxConcurrentWorkers,
        });
      } catch {
        // Keep sidecar cycle active when worker dispatch hits concurrency or adapter limits.
      }
      continue;
    }

    if (command.type === "drive_epic") {
      try {
        await workflowDriver.driveEpic({
          workspacePath: command.workspacePath,
          epicId: command.epicId,
          runtime: command.runtime,
          maxConcurrentWorkers,
          prompt: command.prompt,
        });
      } catch {
        // Keep sidecar cycle active when epic kickoff hits concurrency or adapter limits.
      }
    }
  }

  const agents = await agentManager.refreshHealth();
  const restartedAt =
    previous.daemonPid && previous.daemonPid !== process.pid
      ? nowIso
      : previous.restartedAt ?? (previous.daemonPid ? undefined : nowIso);

  const snapshot: SidecarStateSnapshot = {
    updatedAt: nowIso,
    daemonPid: process.pid,
    restartedAt,
    doltStates,
    gateStates,
    agents,
    monitoredGates: gatekeeper.getMonitoredGates(),
    hookEvents,
    workflowRuns: workflowDriver.getWorkflowRuns(),
    notifiedKeys: gatekeeper.getNotifiedKeys(),
  };
  await stateStore.writeState(snapshot);
  return snapshot;
}

/**
 * Start the continuous sidecar daemon loop with restart hydration and signal shutdown.
 */
export async function startSidecarDaemon(options: SidecarCycleOptions = {}): Promise<void> {
  const dataDir = options.dataDir ?? resolvePluginDataDir();
  const stateStore = new SidecarStateStore(dataDir);
  const previous = await stateStore.readState();

  const doltSupervisor = options.doltSupervisor ?? new DoltSupervisor();
  const agentManager =
    options.agentManager ??
    new HybridAgentManager({
      desktopAdapter: new DesktopAgentAdapter(),
      agyAdapter: new AgyCliAgentAdapter(),
      appDataDir: options.appDataDir,
    });
  const gatekeeper =
    options.gatekeeper ??
    new GatekeeperEngine({
      notifyWaiter: async (waiter, gateId, status, reason) => {
        if (!waiter || waiter.startsWith("bv-")) {
          return;
        }
        try {
          await agentManager.sendMessageToAgent(
            waiter,
            `Gate ${gateId} is now ${status}.${reason ? ` Reason: ${reason}` : ""}`,
          );
        } catch {
          // Keep gatekeeper cycle resilient when a waiter conversation is closed.
        }
      },
    });
  const workflowDriver =
    options.workflowDriver ??
    new WorkflowDriver({
      agentManager,
    });

  gatekeeper.hydrate({
    monitoredGates: previous.monitoredGates,
    hookEvents: previous.hookEvents,
    notifiedKeys: previous.notifiedKeys,
  });
  agentManager.hydrateAgents(previous.agents || []);
  workflowDriver.hydrate(previous.workflowRuns || []);

  const sharedOptions: SidecarCycleOptions = {
    ...options,
    dataDir,
    doltSupervisor,
    gatekeeper,
    agentManager,
    workflowDriver,
    hydrated: true,
  };

  let stopping = false;
  let timer: NodeJS.Timeout | undefined;

  const shutdown = async (exitCode = 0) => {
    if (stopping) {
      return;
    }
    stopping = true;
    if (timer) {
      clearTimeout(timer);
    }
    await agentManager.stopAll();
    await doltSupervisor.stopAll();
    process.exit(exitCode);
  };

  process.once("SIGINT", () => {
    void shutdown(0);
  });
  process.once("SIGTERM", () => {
    void shutdown(0);
  });
  process.once("uncaughtException", (err) => {
    process.stderr.write(`Uncaught sidecar exception: ${err.message}\n`);
    void shutdown(1);
  });
  process.once("unhandledRejection", (reason) => {
    process.stderr.write(`Unhandled sidecar rejection: ${String(reason)}\n`);
    void shutdown(1);
  });

  const scheduleNext = () => {
    if (stopping) {
      return;
    }
    timer = setTimeout(async () => {
      try {
        await runSidecarOnce(sharedOptions);
      } catch {
        // Keep daemon alive across transient poll errors.
      }
      scheduleNext();
    }, DEFAULT_POLL_INTERVAL_MS);
  };

  await runSidecarOnce(sharedOptions);
  scheduleNext();
}

const isEntrypoint =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  if (process.argv.includes("--once")) {
    void runSidecarOnce()
      .then(() => {
        process.exit(0);
      })
      .catch((err) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      });
  } else {
    void startSidecarDaemon().catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
  }
}
