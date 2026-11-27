// @scry.entry
// id: sidecars.gatekeeper-main~1b0edeea
// kind: code
// summary: >-
//   Run the continuous Beads Gatekeeper sidecar loop for Dolt supervision, gate checks, and worker dispatch.
//   Also: sidecar, main, daemon, dolt-supervisor, gatekeeper, agent-manager
// status: active
// weight: 0.95
// tags: ["topic:sidecar", "sidecar", "scope:sidecars", "sidecars", "daemon", "beads"]
// rationale: >-
//   Coordinates workspace Dolt servers, deterministic gate evaluation, and hybrid agent workers in one process.
// applies: running sidecar daemon, executing single smoke cycle, draining queued UI commands
// seeded_questions:
//   - "How does main.ts run DoltSupervisor, GatekeeperEngine, and HybridAgentManager in one cycle?"
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
import { loadOptInConfig } from "./workspace-registry.js";

export interface SidecarCycleOptions {
  dataDir?: string;
  appDataDir?: string;
  doltSupervisor?: DoltSupervisor;
  gatekeeper?: GatekeeperEngine;
  agentManager?: HybridAgentManager;
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;

/**
 * Execute one deterministic sidecar reconciliation cycle and persist state.json.
 */
export async function runSidecarOnce(
  options: SidecarCycleOptions = {},
): Promise<SidecarStateSnapshot> {
  const dataDir = options.dataDir ?? resolvePluginDataDir();
  const stateStore = new SidecarStateStore(dataDir);
  const doltSupervisor = options.doltSupervisor ?? new DoltSupervisor();
  const gatekeeper = options.gatekeeper ?? new GatekeeperEngine();
  const agentManager =
    options.agentManager ??
    new HybridAgentManager({
      desktopAdapter: new DesktopAgentAdapter(),
      agyAdapter: new AgyCliAgentAdapter(),
      appDataDir: options.appDataDir,
    });

  const configPath = path.join(dataDir, "config.json");
  const config = await loadOptInConfig(configPath);
  const doltStates = await doltSupervisor.reconcileAll(config.workspaces);
  const gateStates = await gatekeeper.runAll(config.workspaces, doltStates);

  const commands = await stateStore.drainCommands();
  for (const command of commands) {
    if (command.type === "resolve_gate") {
      try {
        await gatekeeper.resolveHumanGate(command.workspacePath, command.gateId, command.reason);
      } catch {
        // Keep sidecar cycle active when one gate command fails.
      }
      continue;
    }

    if (command.type === "spawn_agent") {
      const workspaceCfg = config.workspaces.find(
        (ws) => path.resolve(ws.workspacePath).toLowerCase() === path.resolve(command.workspacePath).toLowerCase(),
      );
      const maxConcurrentWorkers = workspaceCfg?.maxConcurrentWorkers ?? 2;
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
    }
  }

  const agents = await agentManager.refreshHealth();
  const snapshot: SidecarStateSnapshot = {
    updatedAt: new Date().toISOString(),
    daemonPid: process.pid,
    doltStates,
    gateStates,
    agents,
  };
  await stateStore.writeState(snapshot);
  return snapshot;
}

/**
 * Start the continuous sidecar daemon loop with sequential scheduling and signal shutdown.
 */
export async function startSidecarDaemon(options: SidecarCycleOptions = {}): Promise<void> {
  const doltSupervisor = options.doltSupervisor ?? new DoltSupervisor();
  const gatekeeper = options.gatekeeper ?? new GatekeeperEngine();
  const agentManager =
    options.agentManager ??
    new HybridAgentManager({
      desktopAdapter: new DesktopAgentAdapter(),
      agyAdapter: new AgyCliAgentAdapter(),
      appDataDir: options.appDataDir,
    });

  const sharedOptions: SidecarCycleOptions = {
    ...options,
    doltSupervisor,
    gatekeeper,
    agentManager,
  };

  let stopping = false;
  let timer: NodeJS.Timeout | undefined;

  const shutdown = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    if (timer) {
      clearTimeout(timer);
    }
    await agentManager.stopAll();
    await doltSupervisor.stopAll();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
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
