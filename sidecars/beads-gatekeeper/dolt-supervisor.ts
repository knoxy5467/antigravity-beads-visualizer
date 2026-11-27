// @scry.entry
// id: sidecars.dolt-supervisor~2f19e332
// kind: code
// summary: >-
//   Supervise Dolt SQL servers for opt-in Beads workspaces with port-conflict protection and backoff.
//   Also: dolt, supervisor, tcp-probe, port-conflict, backoff, sidecar
// status: active
// weight: 0.9
// tags: ["topic:sidecar", "sidecar", "scope:sidecars", "sidecars", "dolt", "supervisor"]
// rationale: >-
//   Starts missing Dolt servers for opt-in repositories without touching foreign processes on shared ports.
// applies: probing dolt ports, starting dolt sql-server, detecting port conflicts
// seeded_questions:
//   - "How does DoltSupervisor prevent killing foreign Dolt servers on port conflicts?"
//   - "sidecars/beads-gatekeeper/dolt-supervisor.ts DoltSupervisor"
// @scry.entry.end

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import type { DoltHealthState, OptInWorkspaceConfig } from './types.js';
import { readBeadsDoltMetadata } from './workspace-registry.js';

export interface DoltProcessHandle {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean;
}

export interface DoltSupervisorDeps {
  probePort?: (port: number, host?: string, timeoutMs?: number) => Promise<boolean>;
  spawnDolt?: (workspacePath: string, port: number) => DoltProcessHandle;
  now?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

interface BackoffTracker {
  failures: number;
  nextAttemptAt: number;
}

/**
 * Probe a TCP loopback port and return true when a listener accepts connections.
 */
export function probeTcpPort(port: number, host = '127.0.0.1', timeoutMs = 600): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Locate the local dolt executable path.
 */
export function resolveDoltExecutable(): string {
  if (process.env.DOLT_PATH) return process.env.DOLT_PATH;
  const winDefault = 'C:\\Program Files\\Dolt\\bin\\dolt.exe';
  if (process.platform === 'win32' && existsSync(winDefault)) {
    return winDefault;
  }
  return 'dolt';
}

function defaultSpawnDolt(workspacePath: string, port: number): DoltProcessHandle {
  const doltExe = resolveDoltExecutable();
  const absRepo = resolve(workspacePath);
  const doltDataDir = join(absRepo, '.beads', 'dolt');
  const configYaml = join(absRepo, '.beads', 'dolt-server-config.yaml');
  const args = existsSync(configYaml)
    ? ['sql-server', '--config', configYaml]
    : ['sql-server', '--host', '127.0.0.1', '--port', String(port), '--data-dir', doltDataDir];
  const child = spawn(doltExe, args, {
    cwd: existsSync(doltDataDir) ? doltDataDir : absRepo,
    stdio: 'ignore',
    detached: false,
  });
  return {
    pid: child.pid,
    kill: (signal?: NodeJS.Signals) => child.kill(signal),
  };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readWorkspaceDoltPid(workspacePath: string): Promise<number | undefined> {
  const pidFile = join(resolve(workspacePath), '.beads', 'dolt-server.pid');
  if (!existsSync(pidFile)) return undefined;
  try {
    const raw = (await readFile(pidFile, 'utf-8')).trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Supervise Dolt SQL server processes across explicit opt-in Beads workspaces.
 */
export class DoltSupervisor {
  readonly #probePort: (port: number, host?: string, timeoutMs?: number) => Promise<boolean>;
  readonly #spawnDolt: (workspacePath: string, port: number) => DoltProcessHandle;
  readonly #now: () => number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #managed = new Map<string, DoltProcessHandle>();
  readonly #backoff = new Map<string, BackoffTracker>();
  readonly #states = new Map<string, DoltHealthState>();

  constructor(deps: DoltSupervisorDeps = {}) {
    this.#probePort = deps.probePort ?? probeTcpPort;
    this.#spawnDolt = deps.spawnDolt ?? defaultSpawnDolt;
    this.#now = deps.now ?? (() => Date.now());
    this.#baseBackoffMs = deps.baseBackoffMs ?? 2000;
    this.#maxBackoffMs = deps.maxBackoffMs ?? 60000;
  }

  private normalizeKey(workspacePath: string): string {
    const abs = resolve(workspacePath);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }

  /**
   * Reconcile one opt-in workspace Dolt server and return its current health state.
   */
  async reconcileWorkspace(config: OptInWorkspaceConfig): Promise<DoltHealthState> {
    const key = this.normalizeKey(config.workspacePath);
    const meta = await readBeadsDoltMetadata(config.workspacePath);

    if (meta.doltMode !== 'server') {
      const state: DoltHealthState = {
        workspacePath: config.workspacePath,
        port: 0,
        database: meta.doltDatabase,
        status: 'running',
      };
      this.#states.set(key, state);
      return state;
    }

    if (!config.autoStartDolt) {
      const listening = await this.#probePort(meta.doltServerPort);
      const state: DoltHealthState = {
        workspacePath: config.workspacePath,
        port: meta.doltServerPort,
        database: meta.doltDatabase,
        status: listening ? 'running' : 'stopped',
      };
      this.#states.set(key, state);
      return state;
    }

    const managed = this.#managed.get(key);
    const listening = await this.#probePort(meta.doltServerPort);
    if (listening) {
      if (managed?.pid && isPidAlive(managed.pid)) {
        const state: DoltHealthState = {
          workspacePath: config.workspacePath,
          port: meta.doltServerPort,
          database: meta.doltDatabase,
          status: 'running',
          pid: managed.pid,
        };
        this.#states.set(key, state);
        return state;
      }

      const workspacePid = await readWorkspaceDoltPid(config.workspacePath);
      if (workspacePid && isPidAlive(workspacePid)) {
        const state: DoltHealthState = {
          workspacePath: config.workspacePath,
          port: meta.doltServerPort,
          database: meta.doltDatabase,
          status: 'running',
          pid: workspacePid,
        };
        this.#states.set(key, state);
        return state;
      }

      const conflict: DoltHealthState = {
        workspacePath: config.workspacePath,
        port: meta.doltServerPort,
        database: meta.doltDatabase,
        status: 'port_conflict',
        lastError: `Port ${meta.doltServerPort} is already bound by another process.`,
      };
      this.#states.set(key, conflict);
      return conflict;
    }

    const nowMs = this.#now();
    const tracker = this.#backoff.get(key);
    if (tracker && nowMs < tracker.nextAttemptAt) {
      const cached = this.#states.get(key);
      const state: DoltHealthState = {
        workspacePath: config.workspacePath,
        port: meta.doltServerPort,
        database: meta.doltDatabase,
        status: 'error',
        lastError: cached?.lastError ?? 'Waiting for Dolt restart backoff.',
      };
      this.#states.set(key, state);
      return state;
    }

    try {
      const handle = this.#spawnDolt(config.workspacePath, meta.doltServerPort);
      this.#managed.set(key, handle);
      this.#backoff.delete(key);
      const state: DoltHealthState = {
        workspacePath: config.workspacePath,
        port: meta.doltServerPort,
        database: meta.doltDatabase,
        status: 'running',
        pid: handle.pid,
      };
      this.#states.set(key, state);
      return state;
    } catch (err) {
      const failures = (tracker?.failures ?? 0) + 1;
      const delay = Math.min(this.#maxBackoffMs, this.#baseBackoffMs * 2 ** (failures - 1));
      this.#backoff.set(key, { failures, nextAttemptAt: nowMs + delay });
      const state: DoltHealthState = {
        workspacePath: config.workspacePath,
        port: meta.doltServerPort,
        database: meta.doltDatabase,
        status: 'error',
        lastError: err instanceof Error ? err.message : String(err),
      };
      this.#states.set(key, state);
      return state;
    }
  }

  /**
   * Reconcile all opt-in workspaces sequentially.
   */
  async reconcileAll(workspaces: OptInWorkspaceConfig[]): Promise<DoltHealthState[]> {
    const results: DoltHealthState[] = [];
    for (const ws of workspaces) {
      results.push(await this.reconcileWorkspace(ws));
    }
    return results;
  }

  /**
   * Return the latest known Dolt health states.
   */
  getStates(): DoltHealthState[] {
    return Array.from(this.#states.values());
  }

  /**
   * Stop every Dolt process started by this supervisor.
   */
  stopAll(): void {
    for (const handle of this.#managed.values()) {
      try {
        handle.kill('SIGTERM');
      } catch {
        // Ignore termination errors for already-exited processes.
      }
    }
    this.#managed.clear();
  }
}
