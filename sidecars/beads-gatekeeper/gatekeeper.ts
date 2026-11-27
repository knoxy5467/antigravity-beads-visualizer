// @scry.entry
// id: sidecars.gatekeeper~9fb321cf
// kind: code
// summary: >-
//   Evaluate Beads gates, discover CI runs, detect ready molecules, and route waiter notifications.
//   Also: gatekeeper, bd-gate, discover, escalate, mol-ready, reclaim, sidecar
// status: active
// weight: 0.9
// tags: ["topic:sidecar", "sidecar", "scope:sidecars", "sidecars", "gates", "beads"]
// rationale: >-
//   Automates deterministic Beads gate checks in code and wakes waiters only when gates resolve or escalate.
// applies: running gate discovery, checking gates, resolving human gates, routing waiter alerts
// seeded_questions:
//   - "How does GatekeeperEngine run bd gate commands and deduplicate waiter notifications?"
//   - "sidecars/beads-gatekeeper/gatekeeper.ts GatekeeperEngine"
// @scry.entry.end

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  BD_EXEC_OPTIONS,
  isValidBeadId,
  parseBdJsonOutput,
  resolveBdExecutable,
} from '../../src/standalone/server.js';
import type {
  DoltHealthState,
  GateHookEvent,
  GateMonitorState,
  MonitoredGateRecord,
  OptInWorkspaceConfig,
  SidecarStateSnapshot,
} from './types.js';

const execFileAsync = promisify(execFile);

export type BdRunner = (args: string[], cwd: string) => Promise<string>;
export type WaiterNotifier = (
  waiter: string,
  gateId: string,
  status: 'resolved' | 'escalated',
  reason?: string
) => Promise<void>;

export interface GatekeeperEngineDeps {
  runBd?: BdRunner;
  notifyWaiter?: WaiterNotifier;
  now?: () => string;
  hookTimeoutMs?: number;
}

interface GateRecord {
  id?: string;
  gate_id?: string;
  title?: string;
  await_type?: string;
  status?: string;
  waiters?: string[];
  reason?: string;
}

interface GateCheckPayload {
  resolved?: Array<string | GateRecord>;
  escalated?: Array<string | GateRecord>;
}

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const MAX_HOOK_EVENTS = 50;

async function defaultRunBd(args: string[], cwd: string): Promise<string> {
  const bdExe = resolveBdExecutable();
  const { stdout } = await execFileAsync(bdExe, args, {
    cwd,
    ...BD_EXEC_OPTIONS,
  });
  return stdout;
}

function extractGateId(item: string | GateRecord): string {
  if (typeof item === 'string') return item;
  return item.id || item.gate_id || '';
}

function extractWaiters(item: string | GateRecord): string[] {
  if (typeof item === 'string' || !Array.isArray(item.waiters)) return [];
  return item.waiters.filter((w): w is string => typeof w === 'string' && w.trim().length > 0);
}

/**
 * Run deterministic Beads gate discovery, check, molecule readiness, and lease reclaim.
 */
export class GatekeeperEngine {
  readonly #runBd: BdRunner;
  readonly #notifyWaiter?: WaiterNotifier;
  readonly #now: () => string;
  readonly #hookTimeoutMs: number;
  readonly #notified = new Set<string>();
  readonly #states = new Map<string, GateMonitorState>();
  readonly #monitoredGates = new Map<string, MonitoredGateRecord>();
  #hookEvents: GateHookEvent[] = [];

  constructor(deps: GatekeeperEngineDeps = {}) {
    this.#runBd = deps.runBd ?? defaultRunBd;
    this.#notifyWaiter = deps.notifyWaiter;
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#hookTimeoutMs = deps.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  }

  private normalizeKey(workspacePath: string): string {
    const abs = resolve(workspacePath);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }

  private gateKey(workspacePath: string, gateId: string): string {
    return `${this.normalizeKey(workspacePath)}:${gateId}`;
  }

  /**
   * Restore monitored gates, hook events, and waiter deduplication keys after a sidecar restart.
   */
  hydrate(
    snapshot: Pick<SidecarStateSnapshot, 'monitoredGates' | 'hookEvents' | 'notifiedKeys'>
  ): void {
    for (const key of snapshot.notifiedKeys || []) {
      if (typeof key === 'string' && key) {
        this.#notified.add(key);
      }
    }
    for (const gate of snapshot.monitoredGates || []) {
      if (!gate?.gateId || gate.status !== 'monitoring') {
        continue;
      }
      this.#monitoredGates.set(this.gateKey(gate.workspacePath, gate.gateId), {
        ...gate,
        waiters: [...(gate.waiters || [])],
        rehydrated: true,
      });
    }
    if (Array.isArray(snapshot.hookEvents)) {
      this.#hookEvents = snapshot.hookEvents.slice(-MAX_HOOK_EVENTS).map((e) => ({ ...e }));
    }
  }

  /**
   * Merge newly drained hook events and mark stalled started hooks as timed_out.
   */
  ingestHookEvents(events: GateHookEvent[], nowMs: number = Date.now()): GateHookEvent[] {
    const byId = new Map<string, GateHookEvent>();
    for (const existing of this.#hookEvents) {
      byId.set(existing.id, { ...existing });
    }
    for (const incoming of events) {
      if (incoming?.id) {
        byId.set(incoming.id, { ...incoming });
      }
    }
    const merged = Array.from(byId.values());
    for (const item of merged) {
      if (item.status !== 'started') {
        continue;
      }
      const startedMs = Date.parse(item.timestamp);
      if (Number.isFinite(startedMs) && nowMs - startedMs > this.#hookTimeoutMs) {
        item.status = 'timed_out';
        item.detail = item.detail || `Hook timed out after ${this.#hookTimeoutMs} ms.`;
      }
    }
    this.#hookEvents = merged.slice(-MAX_HOOK_EVENTS);
    return this.getHookEvents();
  }

  private async dispatchWaiterNotifications(
    workspaceKey: string,
    items: Array<string | GateRecord>,
    status: 'resolved' | 'escalated'
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const item of items) {
      const gateId = extractGateId(item);
      if (!gateId) continue;
      ids.push(gateId);
      const reason = typeof item === 'string' ? undefined : item.reason;
      for (const waiter of extractWaiters(item)) {
        const dedupeKey = `${workspaceKey}:${status}:${gateId}:${waiter}`;
        if (this.#notified.has(dedupeKey)) continue;
        this.#notified.add(dedupeKey);
        if (this.#notifyWaiter) {
          await this.#notifyWaiter(waiter, gateId, status, reason);
        }
      }
    }
    return ids;
  }

  /**
   * Run one deterministic gate maintenance cycle for a single opt-in workspace.
   */
  async runCycleForWorkspace(
    config: OptInWorkspaceConfig,
    doltHealth: DoltHealthState
  ): Promise<GateMonitorState> {
    const key = this.normalizeKey(config.workspacePath);
    const timestamp = this.#now();

    if (!config.autoCheckGates) {
      const skipped: GateMonitorState = {
        workspacePath: config.workspacePath,
        lastRunAt: timestamp,
        discoveredCount: 0,
        resolvedGates: [],
        escalatedGates: [],
        readyMolecules: [],
      };
      this.#states.set(key, skipped);
      return skipped;
    }

    if (doltHealth.status !== 'running') {
      const blocked: GateMonitorState = {
        workspacePath: config.workspacePath,
        lastRunAt: timestamp,
        discoveredCount: 0,
        resolvedGates: [],
        escalatedGates: [],
        readyMolecules: [],
        lastError: `Skipped gate checks because Dolt status is ${doltHealth.status}.`,
      };
      this.#states.set(key, blocked);
      return blocked;
    }

    try {
      const discoverRaw = await this.#runBd(['gate', 'discover', '--json'], config.workspacePath);
      const discovered = parseBdJsonOutput(discoverRaw);
      const discoveredCount = Array.isArray(discovered) ? discovered.length : 0;

      const listRaw = await this.#runBd(['gate', 'list', '--json'], config.workspacePath).catch(() => '[]');
      const listed = parseBdJsonOutput(listRaw);
      const openGates = Array.isArray(listed) ? (listed as GateRecord[]) : [];
      const activeIds = new Set<string>();
      for (const gate of openGates) {
        const gateId = extractGateId(gate);
        if (!gateId) continue;
        activeIds.add(gateId);
        const gk = this.gateKey(config.workspacePath, gateId);
        const existing = this.#monitoredGates.get(gk);
        this.#monitoredGates.set(gk, {
          workspacePath: config.workspacePath,
          gateId,
          title: gate.title ?? existing?.title,
          awaitType: gate.await_type ?? existing?.awaitType,
          status: 'monitoring',
          waiters: extractWaiters(gate),
          lastCheckedAt: timestamp,
          rehydrated: existing?.rehydrated,
        });
      }

      const checkRaw = await this.#runBd(
        ['gate', 'check', '--escalate', '--json'],
        config.workspacePath
      );
      const checkParsed = parseBdJsonOutput(checkRaw) as GateCheckPayload | unknown[];
      const checkObj: GateCheckPayload = Array.isArray(checkParsed) ? {} : checkParsed;
      const resolvedGates = await this.dispatchWaiterNotifications(
        key,
        checkObj.resolved || [],
        'resolved'
      );
      const escalatedGates = await this.dispatchWaiterNotifications(
        key,
        checkObj.escalated || [],
        'escalated'
      );

      for (const id of resolvedGates) {
        const rec = this.#monitoredGates.get(this.gateKey(config.workspacePath, id));
        if (rec) {
          rec.status = 'resolved';
          rec.lastCheckedAt = timestamp;
        }
      }
      for (const id of escalatedGates) {
        const rec = this.#monitoredGates.get(this.gateKey(config.workspacePath, id));
        if (rec) {
          rec.status = 'escalated';
          rec.lastCheckedAt = timestamp;
        }
      }

      const molRaw = await this.#runBd(['mol', 'ready', '--gated', '--json'], config.workspacePath);
      const molParsed = parseBdJsonOutput(molRaw);
      const readyMolecules = Array.isArray(molParsed)
        ? molParsed
            .map((entry) =>
              typeof entry === 'object' && entry !== null
                ? String((entry as { id?: unknown }).id || '')
                : ''
            )
            .filter(Boolean)
        : [];

      await this.#runBd(['reclaim', '--json'], config.workspacePath).catch(() => '[]');

      const workspaceMonitored = this.getMonitoredGates().filter(
        (g) => this.normalizeKey(g.workspacePath) === key && (g.status === 'monitoring' || activeIds.has(g.gateId))
      );
      const failedHooks = this.getHookEvents().filter(
        (h) =>
          this.normalizeKey(h.workspacePath) === key &&
          (h.status === 'failed' || h.status === 'timed_out')
      );

      const state: GateMonitorState = {
        workspacePath: config.workspacePath,
        lastRunAt: timestamp,
        discoveredCount,
        resolvedGates,
        escalatedGates,
        readyMolecules,
        monitoredGates: workspaceMonitored,
        failedHooks,
      };
      this.#states.set(key, state);
      return state;
    } catch (err) {
      const failed: GateMonitorState = {
        workspacePath: config.workspacePath,
        lastRunAt: timestamp,
        discoveredCount: 0,
        resolvedGates: [],
        escalatedGates: [],
        readyMolecules: [],
        lastError: err instanceof Error ? err.message : String(err),
      };
      this.#states.set(key, failed);
      return failed;
    }
  }

  /**
   * Run one gate maintenance cycle across all opt-in workspaces.
   */
  async runAll(
    workspaces: OptInWorkspaceConfig[],
    doltStates: DoltHealthState[]
  ): Promise<GateMonitorState[]> {
    const byKey = new Map<string, DoltHealthState>(
      doltStates.map((s) => [this.normalizeKey(s.workspacePath), s])
    );
    const results: GateMonitorState[] = [];
    for (const ws of workspaces) {
      const dolt = byKey.get(this.normalizeKey(ws.workspacePath)) ?? {
        workspacePath: ws.workspacePath,
        port: 0,
        database: 'beads',
        status: 'stopped' as const,
      };
      results.push(await this.runCycleForWorkspace(ws, dolt));
    }
    return results;
  }

  /**
   * Resolve a human approval gate through the Beads CLI.
   */
  async resolveHumanGate(workspacePath: string, gateId: string, reason: string): Promise<void> {
    if (!isValidBeadId(gateId)) {
      throw new Error(`Invalid gate ID: ${gateId}`);
    }
    const cleanReason = reason.trim() || 'Approved from Beads Visualizer.';
    await this.#runBd(['gate', 'resolve', gateId, '--reason', cleanReason, '--json'], workspacePath);
  }

  /**
   * Return the latest gate monitor state for every tracked workspace.
   */
  getStates(): GateMonitorState[] {
    return Array.from(this.#states.values());
  }

  /**
   * Return all monitored gate records across tracked workspaces.
   */
  getMonitoredGates(): MonitoredGateRecord[] {
    return Array.from(this.#monitoredGates.values()).map((g) => ({
      ...g,
      waiters: [...g.waiters],
    }));
  }

  /**
   * Return retained gate hook events.
   */
  getHookEvents(): GateHookEvent[] {
    return this.#hookEvents.map((e) => ({ ...e }));
  }

  /**
   * Return waiter deduplication keys for persistence across restarts.
   */
  getNotifiedKeys(): string[] {
    return Array.from(this.#notified);
  }
}
