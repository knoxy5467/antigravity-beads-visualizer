// @scry.entry
// id: sidecars.workflow-driver~cf25a2d7
// kind: code
// summary: >-
//   Initiate Antigravity conversations and agy workers to drive Beads epics, ready work, and hook failures.
//   Also: workflow-driver, epic, conversation, ready-work, gate-resolved, hook-failed, sidecar
// status: active
// weight: 0.9
// tags: ["topic:sidecar", "sidecar", "scope:sidecars", "sidecars", "workflows", "beads"]
// rationale: >-
//   Turns ready Beads work, resolved gates, and failed gate hooks into deduplicated agent conversations.
// applies: driving ready beads work, kicking off epics, recovering from failed gate hooks
// seeded_questions:
//   - "How does WorkflowDriver initiate conversations for ready work and deduplicate dispatches?"
//   - "sidecars/beads-gatekeeper/workflow-driver.ts WorkflowDriver"
// @scry.entry.end

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  BD_EXEC_OPTIONS,
  isValidBeadId,
  parseBdJsonOutput,
  resolveBdExecutable,
} from '../../src/standalone/server.js';
import type { HybridAgentManager } from './agent-manager.js';
import type { BdRunner } from './gatekeeper.js';
import type {
  DoltHealthState,
  GateMonitorState,
  ManagedAgentRuntime,
  OptInWorkspaceConfig,
  WorkflowDispatchRecord,
  WorkflowTrigger,
} from './types.js';

const execFileAsync = promisify(execFile);
const MAX_WORKFLOW_RUNS = 50;

export interface WorkflowDriverDeps {
  agentManager: HybridAgentManager;
  runBd?: BdRunner;
  now?: () => string;
}

export interface DriveEpicInput {
  workspacePath: string;
  epicId: string;
  runtime: ManagedAgentRuntime;
  maxConcurrentWorkers: number;
  prompt?: string;
}

interface ReadyBeadItem {
  id?: string;
  title?: string;
  issue_type?: string;
  priority?: number;
}

async function defaultRunBd(args: string[], cwd: string): Promise<string> {
  const bdExe = resolveBdExecutable();
  const { stdout } = await execFileAsync(bdExe, args, {
    cwd,
    ...BD_EXEC_OPTIONS,
  });
  return stdout;
}

/**
 * Initiate Antigravity conversations to drive Beads epics, ready tasks, and hook recovery.
 */
export class WorkflowDriver {
  readonly #agentManager: HybridAgentManager;
  readonly #runBd: BdRunner;
  readonly #now: () => string;
  readonly #dispatchedKeys = new Set<string>();
  #workflowRuns: WorkflowDispatchRecord[] = [];

  constructor(deps: WorkflowDriverDeps) {
    this.#agentManager = deps.agentManager;
    this.#runBd = deps.runBd ?? defaultRunBd;
    this.#now = deps.now ?? (() => new Date().toISOString());
  }

  private normalizeKey(workspacePath: string): string {
    const abs = resolve(workspacePath);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }

  private dedupeKey(workspacePath: string, trigger: WorkflowTrigger, targetId: string): string {
    return `${this.normalizeKey(workspacePath)}:${trigger}:${targetId}`;
  }

  /**
   * Restore prior workflow dispatch history and deduplication keys after a sidecar restart.
   */
  hydrate(workflowRuns: WorkflowDispatchRecord[]): void {
    this.#workflowRuns = workflowRuns.slice(-MAX_WORKFLOW_RUNS).map((r) => ({ ...r }));
    for (const run of this.#workflowRuns) {
      this.#dispatchedKeys.add(this.dedupeKey(run.workspacePath, run.trigger, run.beadId));
    }
  }

  /**
   * Initiate conversations for ready work, resolved gates, and failed gate hooks in one workspace.
   */
  async driveWorkspace(
    config: OptInWorkspaceConfig,
    doltHealth: DoltHealthState,
    gateState: GateMonitorState
  ): Promise<WorkflowDispatchRecord[]> {
    if (!config.autoDriveWorkflows || doltHealth.status !== 'running') {
      return [];
    }

    const runtime = config.defaultWorkflowRuntime ?? 'desktop';
    const created: WorkflowDispatchRecord[] = [];

    // 1. Drive unblocked ready work from bd ready --json.
    try {
      const readyRaw = await this.#runBd(['ready', '--json'], config.workspacePath);
      const parsed = parseBdJsonOutput(readyRaw);
      const readyItems = Array.isArray(parsed) ? (parsed as ReadyBeadItem[]) : [];
      for (const item of readyItems) {
        const beadId = typeof item.id === 'string' ? item.id.trim() : '';
        if (!beadId || !isValidBeadId(beadId)) continue;
        const dispatch = await this.dispatchOnce({
          workspacePath: config.workspacePath,
          beadId,
          trigger: 'ready_work',
          runtime,
          maxConcurrentWorkers: config.maxConcurrentWorkers,
          prompt: `Drive Beads task ${beadId} (${item.title || 'untitled'}) to completion under strict TDD.`,
        });
        if (dispatch) created.push(dispatch);
      }
    } catch {
      // Keep workflow loop resilient when bd ready fails transiently.
    }

    // 2. Drive molecules or workflows unblocked by resolved gates.
    if (gateState.resolvedGates.length > 0) {
      for (const molId of gateState.readyMolecules) {
        if (!isValidBeadId(molId)) continue;
        const dispatch = await this.dispatchOnce({
          workspacePath: config.workspacePath,
          beadId: molId,
          trigger: 'gate_resolved',
          runtime,
          maxConcurrentWorkers: config.maxConcurrentWorkers,
          prompt: `Resume Beads workflow ${molId} because its blocking gate resolved.`,
        });
        if (dispatch) created.push(dispatch);
      }
    }

    // 3. Initiate remediation conversations for failed or timed-out gate hooks.
    for (const hook of gateState.failedHooks || []) {
      const targetId = hook.gateId || hook.beadId || hook.id;
      const key = this.dedupeKey(config.workspacePath, 'gate_hook_failed', hook.id);
      if (this.#dispatchedKeys.has(key)) continue;
      const dispatch = await this.dispatchWithKey(key, {
        workspacePath: config.workspacePath,
        beadId: targetId,
        trigger: 'gate_hook_failed',
        runtime,
        maxConcurrentWorkers: config.maxConcurrentWorkers,
        prompt: `Investigate and fix failed Beads hook ${hook.hookName} (${hook.status}): ${hook.detail || 'no details'}.`,
      });
      if (dispatch) created.push(dispatch);
    }

    return created;
  }

  /**
   * Initiate an on-demand conversation to drive a specific Beads epic or task.
   */
  async driveEpic(input: DriveEpicInput): Promise<WorkflowDispatchRecord> {
    if (!isValidBeadId(input.epicId)) {
      throw new Error(`Invalid epic ID: ${input.epicId}`);
    }
    const prompt =
      input.prompt?.trim() ||
      `Initiate workflow and drive Beads epic ${input.epicId} to verified completion.`;
    const agent = await this.#agentManager.spawnAgent({
      workspacePath: input.workspacePath,
      beadId: input.epicId,
      runtime: input.runtime,
      prompt,
      maxConcurrentWorkers: input.maxConcurrentWorkers,
    });
    const record: WorkflowDispatchRecord = {
      id: `wf-${crypto.randomUUID().slice(0, 8)}`,
      workspacePath: input.workspacePath,
      beadId: input.epicId,
      trigger: 'manual_epic',
      runtime: input.runtime,
      conversationId: agent.conversationId,
      pid: agent.pid,
      status: 'dispatched',
      createdAt: this.#now(),
    };
    this.recordDispatch(record);
    return { ...record };
  }

  /**
   * Return retained workflow dispatch records.
   */
  getWorkflowRuns(): WorkflowDispatchRecord[] {
    return this.#workflowRuns.map((r) => ({ ...r }));
  }

  private hasActiveAgentForBead(workspacePath: string, beadId: string): boolean {
    const normWs = this.normalizeKey(workspacePath);
    return this.#agentManager
      .getAgents()
      .some(
        (a) =>
          this.normalizeKey(a.workspacePath) === normWs &&
          a.beadId === beadId &&
          (a.status === 'running' || a.status === 'stalled')
      );
  }

  private async dispatchOnce(params: {
    workspacePath: string;
    beadId: string;
    trigger: WorkflowTrigger;
    runtime: ManagedAgentRuntime;
    maxConcurrentWorkers: number;
    prompt: string;
  }): Promise<WorkflowDispatchRecord | null> {
    const key = this.dedupeKey(params.workspacePath, params.trigger, params.beadId);
    return this.dispatchWithKey(key, params);
  }

  private async dispatchWithKey(
    key: string,
    params: {
      workspacePath: string;
      beadId: string;
      trigger: WorkflowTrigger;
      runtime: ManagedAgentRuntime;
      maxConcurrentWorkers: number;
      prompt: string;
    }
  ): Promise<WorkflowDispatchRecord | null> {
    if (this.#dispatchedKeys.has(key) || this.hasActiveAgentForBead(params.workspacePath, params.beadId)) {
      return null;
    }
    this.#dispatchedKeys.add(key);
    try {
      const agent = await this.#agentManager.spawnAgent({
        workspacePath: params.workspacePath,
        beadId: params.beadId,
        runtime: params.runtime,
        prompt: params.prompt,
        maxConcurrentWorkers: params.maxConcurrentWorkers,
      });
      const record: WorkflowDispatchRecord = {
        id: `wf-${crypto.randomUUID().slice(0, 8)}`,
        workspacePath: params.workspacePath,
        beadId: params.beadId,
        trigger: params.trigger,
        runtime: params.runtime,
        conversationId: agent.conversationId,
        pid: agent.pid,
        status: 'dispatched',
        createdAt: this.#now(),
      };
      this.recordDispatch(record);
      return { ...record };
    } catch (err) {
      const failed: WorkflowDispatchRecord = {
        id: `wf-${crypto.randomUUID().slice(0, 8)}`,
        workspacePath: params.workspacePath,
        beadId: params.beadId,
        trigger: params.trigger,
        runtime: params.runtime,
        status: 'failed',
        createdAt: this.#now(),
        detail: err instanceof Error ? err.message : String(err),
      };
      this.recordDispatch(failed);
      return { ...failed };
    }
  }

  private recordDispatch(record: WorkflowDispatchRecord): void {
    this.#workflowRuns.push(record);
    if (this.#workflowRuns.length > MAX_WORKFLOW_RUNS) {
      this.#workflowRuns = this.#workflowRuns.slice(-MAX_WORKFLOW_RUNS);
    }
  }
}
