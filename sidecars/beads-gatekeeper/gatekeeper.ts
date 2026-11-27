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
import type { DoltHealthState, GateMonitorState, OptInWorkspaceConfig } from './types.js';

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
}

interface GateRecord {
  id?: string;
  gate_id?: string;
  waiters?: string[];
  reason?: string;
}

interface GateCheckPayload {
  resolved?: Array<string | GateRecord>;
  escalated?: Array<string | GateRecord>;
}

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
  readonly #notified = new Set<string>();
  readonly #states = new Map<string, GateMonitorState>();

  constructor(deps: GatekeeperEngineDeps = {}) {
    this.#runBd = deps.runBd ?? defaultRunBd;
    this.#notifyWaiter = deps.notifyWaiter;
    this.#now = deps.now ?? (() => new Date().toISOString());
  }

  private normalizeKey(workspacePath: string): string {
    const abs = resolve(workspacePath);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
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

      const state: GateMonitorState = {
        workspacePath: config.workspacePath,
        lastRunAt: timestamp,
        discoveredCount,
        resolvedGates,
        escalatedGates,
        readyMolecules,
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
}
