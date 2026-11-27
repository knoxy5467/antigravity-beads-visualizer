// @scry.entry
// id: sidecars.agent-manager~1c314f30
// kind: code
// summary: >-
//   Manage Antigravity Desktop and agy CLI workers, enforce concurrency limits, and inspect transcript health.
//   Also: agent-manager, desktop-adapter, agy-adapter, transcript-health, sidecar
// status: active
// weight: 0.9
// tags: ["topic:sidecar", "sidecar", "scope:sidecars", "sidecars", "agents"]
// rationale: >-
//   Runs hybrid agent dispatch and deterministic health checks without LLM polling.
// applies: spawning desktop or agy workers, cancelling worker processes, classifying transcript health
// seeded_questions:
//   - "How does HybridAgentManager enforce maxConcurrentWorkers across desktop and agy workers?"
//   - "sidecars/beads-gatekeeper/agent-manager.ts HybridAgentManager"
// @scry.entry.end

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ManagedAgentRecord,
  ManagedAgentRuntime,
  ManagedAgentStatus,
} from "./types.js";

const DEFAULT_STALL_THRESHOLD_MS = 5 * 60 * 1000;

const QUOTA_PATTERNS = [
  /RESOURCE_EXHAUSTED/i,
  /quota_exhausted/i,
  /rate_limit_exceeded/i,
  /quota exceeded/i,
  /insufficient_quota/i,
  /\bHTTP\s*429\b/i,
  /"status"\s*:\s*429/,
];

/**
 * Inspect a local transcript log to classify worker health without an LLM call.
 */
export function inspectTranscriptHealth(options: TranscriptHealthOptions): ManagedAgentStatus {
  const nowMs = options.nowMs ?? Date.now();
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;

  if (!fs.existsSync(options.transcriptPath)) {
    return options.isRunning ? "running" : "idle";
  }

  const raw = fs.readFileSync(options.transcriptPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const recentText = lines.slice(-20).join("\n");

  for (const pattern of QUOTA_PATTERNS) {
    if (pattern.test(recentText)) {
      return "quota_exhausted";
    }
  }

  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]) as { status?: string; type?: string };
      if (parsed.status === "failed" || parsed.type === "ERROR_MESSAGE") {
        return "failed";
      }
    } catch {
      // Ignore malformed lines in partial log writes.
    }
  }

  if (options.isRunning) {
    const stat = fs.statSync(options.transcriptPath);
    if (nowMs - stat.mtimeMs > stallThresholdMs) {
      return "stalled";
    }
    return "running";
  }

  return "idle";
}

export interface TranscriptHealthOptions {
  transcriptPath: string;
  isRunning: boolean;
  nowMs?: number;
  stallThresholdMs?: number;
}

export interface SidecarSdkBridge {
  startConversation?: (workspacePath: string, prompt: string) => Promise<{ conversationId?: string }>;
  sendMessage?: (conversationId: string, prompt: string) => Promise<void>;
}

export interface DesktopAgentAdapterOptions {
  lsAddress?: string;
  csrfToken?: string;
  fetchFn?: typeof fetch;
  sidecarSdk?: SidecarSdkBridge;
}

export interface AgentSpawnInput {
  workspacePath: string;
  beadId: string;
  prompt: string;
}

export interface AgyCliAgentAdapterOptions {
  agyExecutable?: string;
  baseArgs?: string[];
  timeoutMs?: number;
  spawnFn?: typeof spawn;
}

export interface AgyWorkerHandle {
  pid: number;
  done: Promise<{ status: ManagedAgentStatus; lastError?: string }>;
}

export interface HybridAgentManagerOptions {
  desktopAdapter: DesktopAgentAdapter;
  agyAdapter: AgyCliAgentAdapter;
  appDataDir?: string;
  stallThresholdMs?: number;
  nowFn?: () => number;
  isPidAlive?: (pid: number) => boolean;
}

export interface SpawnManagedAgentInput extends AgentSpawnInput {
  runtime: ManagedAgentRuntime;
  maxConcurrentWorkers: number;
}

/**
 * Manage Antigravity Desktop agent conversations through ConversationService and sidecar_sdk.
 */
export class DesktopAgentAdapter {
  private readonly lsAddress: string;
  private readonly csrfToken: string;
  private readonly fetchFn: typeof fetch;
  private readonly sidecarSdk?: SidecarSdkBridge;

  public constructor(options: DesktopAgentAdapterOptions = {}) {
    this.lsAddress = options.lsAddress ?? process.env.ANTIGRAVITY_LS_ADDRESS ?? "";
    this.csrfToken = options.csrfToken ?? process.env.ANTIGRAVITY_CSRF_TOKEN ?? "";
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.sidecarSdk = options.sidecarSdk;
  }

  public async spawn(input: AgentSpawnInput): Promise<{ conversationId: string }> {
    if (this.lsAddress) {
      const data = await this.postConversationRpc<{ conversationId?: string; id?: string }>(
        "CreateConversation",
        {
          workspaceUri: pathToFileURL(input.workspacePath).toString(),
          prompt: input.prompt,
        },
      );
      const conversationId = data.conversationId ?? data.id;
      if (!conversationId) {
        throw new Error("ConversationService CreateConversation returned no conversationId.");
      }
      if (this.sidecarSdk?.sendMessage) {
        await this.sidecarSdk.sendMessage(conversationId, input.prompt);
      }
      return { conversationId };
    }

    if (this.sidecarSdk?.startConversation) {
      const result = await this.sidecarSdk.startConversation(input.workspacePath, input.prompt);
      if (result.conversationId) {
        return { conversationId: result.conversationId };
      }
    }

    throw new Error("ANTIGRAVITY_LS_ADDRESS is missing and sidecarSdk cannot start a conversation.");
  }

  public async getStatus(conversationId: string): Promise<ManagedAgentStatus> {
    if (!this.lsAddress) {
      return "idle";
    }
    const data = await this.postConversationRpc<{ runState?: string; status?: string }>(
      "GetConversation",
      { conversationId },
    );
    const state = (data.runState ?? data.status ?? "").toUpperCase();
    if (state.includes("RUNNING") || state.includes("IN_PROGRESS")) {
      return "running";
    }
    if (state.includes("FAILED") || state.includes("ERROR")) {
      return "failed";
    }
    return "idle";
  }

  public async sendMessage(conversationId: string, prompt: string): Promise<void> {
    if (this.sidecarSdk?.sendMessage) {
      await this.sidecarSdk.sendMessage(conversationId, prompt);
      return;
    }
    if (this.lsAddress) {
      await this.postConversationRpc("SendUserCascadeMessage", {
        conversationId,
        items: [{ text: prompt }],
      });
      return;
    }
    throw new Error("Cannot send message: ANTIGRAVITY_LS_ADDRESS and sidecarSdk are unavailable.");
  }

  private async postConversationRpc<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchFn(
      `http://${this.lsAddress}/product.v1.ConversationService/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-antigravity-csrf-token": this.csrfToken,
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(`ConversationService ${method} failed with HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  }
}

/**
 * Manage headless agy CLI worker processes with NDJSON stream I/O and PID cancellation.
 */
export class AgyCliAgentAdapter {
  private readonly agyExecutable: string;
  private readonly baseArgs: string[];
  private readonly timeoutMs?: number;
  private readonly spawnFn: typeof spawn;
  private readonly children = new Map<number, ChildProcess>();
  private readonly cancelledPids = new Set<number>();

  public constructor(options: AgyCliAgentAdapterOptions = {}) {
    this.agyExecutable = options.agyExecutable ?? "agy";
    this.baseArgs = options.baseArgs ?? [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
    ];
    this.timeoutMs = options.timeoutMs;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  public spawn(input: AgentSpawnInput): AgyWorkerHandle {
    const child = this.spawnFn(this.agyExecutable, this.baseArgs, {
      cwd: input.workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const pid = child.pid ?? 0;
    if (pid > 0) {
      this.children.set(pid, child);
    }

    let timedOut = false;
    let lastStatus: ManagedAgentStatus | undefined;
    let stderrText = "";
    let stdoutBuffer = "";

    const timeoutHandle =
      this.timeoutMs && this.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, this.timeoutMs)
        : undefined;

    if (child.stdin) {
      child.stdin.write(`${JSON.stringify({ type: "user_message", content: input.prompt })}\n`);
      child.stdin.end();
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const parts = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as { status?: string; type?: string; message?: string };
          if (parsed.status === "idle" || parsed.status === "failed" || parsed.status === "quota_exhausted") {
            lastStatus = parsed.status;
          }
          if (parsed.message && QUOTA_PATTERNS.some((pattern) => pattern.test(parsed.message ?? ""))) {
            lastStatus = "quota_exhausted";
          }
        } catch {
          // Ignore non-JSON stdout lines from worker output.
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });

    const done = new Promise<{ status: ManagedAgentStatus; lastError?: string }>((resolve) => {
      child.once("error", (err) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (pid > 0) {
          this.children.delete(pid);
        }
        resolve({ status: "failed", lastError: err.message });
      });

      child.once("exit", (code) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (pid > 0) {
          this.children.delete(pid);
        }
        if (pid > 0 && this.cancelledPids.has(pid)) {
          this.cancelledPids.delete(pid);
          resolve({ status: "stopped" });
          return;
        }
        if (timedOut) {
          resolve({ status: "failed", lastError: `Worker timeout after ${this.timeoutMs} ms.` });
          return;
        }
        if (lastStatus === "quota_exhausted" || QUOTA_PATTERNS.some((p) => p.test(stderrText))) {
          resolve({ status: "quota_exhausted", lastError: stderrText.trim() || "Quota limit reached." });
          return;
        }
        if (lastStatus) {
          resolve({
            status: lastStatus,
            lastError: lastStatus === "failed" ? stderrText.trim() || "Worker failed." : undefined,
          });
          return;
        }
        if (code === 0) {
          resolve({ status: "idle" });
          return;
        }
        resolve({
          status: "failed",
          lastError: stderrText.trim() || `Worker exited with code ${code ?? "unknown"}.`,
        });
      });
    });

    return { pid, done };
  }

  public cancel(pid: number): boolean {
    const child = this.children.get(pid);
    if (!child) {
      return false;
    }
    this.cancelledPids.add(pid);
    return child.kill("SIGTERM");
  }

  public stopAll(): void {
    for (const pid of this.children.keys()) {
      this.cancel(pid);
    }
  }
}

/**
 * Coordinate desktop and headless agy workers with per-workspace concurrency enforcement.
 */
export class HybridAgentManager {
  private readonly desktopAdapter: DesktopAgentAdapter;
  private readonly agyAdapter: AgyCliAgentAdapter;
  private readonly appDataDir?: string;
  private readonly stallThresholdMs: number;
  private readonly nowFn: () => number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly agents = new Map<string, ManagedAgentRecord>();
  private readonly pendingDone = new Map<string, Promise<unknown>>();

  public constructor(options: HybridAgentManagerOptions) {
    this.desktopAdapter = options.desktopAdapter;
    this.agyAdapter = options.agyAdapter;
    this.appDataDir = options.appDataDir;
    this.stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.nowFn = options.nowFn ?? Date.now;
    this.isPidAlive =
      options.isPidAlive ??
      ((pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
  }

  public hydrateAgents(records: ManagedAgentRecord[]): void {
    const nowIso = new Date(this.nowFn()).toISOString();
    for (const record of records) {
      if (!record?.id) {
        continue;
      }
      const copy: ManagedAgentRecord = { ...record };
      if (
        copy.runtime === "agy" &&
        (copy.status === "running" || copy.status === "stalled") &&
        (!copy.pid || !this.isPidAlive(copy.pid))
      ) {
        copy.status = "stopped";
        copy.updatedAt = nowIso;
      }
      this.agents.set(copy.id, copy);
    }
  }

  public async sendMessageToAgent(conversationId: string, prompt: string): Promise<void> {
    await this.desktopAdapter.sendMessage(conversationId, prompt);
  }

  public async spawnAgent(input: SpawnManagedAgentInput): Promise<ManagedAgentRecord> {
    const activeCount = this.countActiveAgentsForWorkspace(input.workspacePath);
    if (activeCount >= input.maxConcurrentWorkers) {
      throw new Error(
        `Cannot spawn agent: maxConcurrentWorkers (${input.maxConcurrentWorkers}) reached for ${input.workspacePath}.`,
      );
    }

    const nowIso = new Date(this.nowFn()).toISOString();
    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;

    if (input.runtime === "desktop") {
      const placeholder: ManagedAgentRecord = {
        id,
        runtime: "desktop",
        beadId: input.beadId,
        workspacePath: input.workspacePath,
        status: "running",
        startedAt: nowIso,
        updatedAt: nowIso,
      };
      this.agents.set(id, placeholder);
      try {
        const { conversationId } = await this.desktopAdapter.spawn(input);
        placeholder.conversationId = conversationId;
        placeholder.updatedAt = new Date(this.nowFn()).toISOString();
        return { ...placeholder };
      } catch (err) {
        this.agents.delete(id);
        throw err;
      }
    }

    const handle = this.agyAdapter.spawn(input);
    const record: ManagedAgentRecord = {
      id,
      runtime: "agy",
      beadId: input.beadId,
      workspacePath: input.workspacePath,
      status: "running",
      pid: handle.pid,
      startedAt: nowIso,
      updatedAt: nowIso,
    };
    this.agents.set(id, record);

    const donePromise = handle.done.then((outcome) => {
      this.pendingDone.delete(id);
      const current = this.agents.get(id);
      if (!current || current.status === "stopped") {
        return;
      }
      current.status = outcome.status;
      current.lastError = outcome.lastError;
      current.updatedAt = new Date(this.nowFn()).toISOString();
    });
    this.pendingDone.set(id, donePromise);

    return { ...record };
  }

  public async cancelAgent(agentId: string): Promise<ManagedAgentRecord> {
    const record = this.agents.get(agentId);
    if (!record) {
      throw new Error(`Unknown agent id: ${agentId}`);
    }
    if (record.runtime === "agy" && typeof record.pid === "number") {
      this.agyAdapter.cancel(record.pid);
      const pending = this.pendingDone.get(agentId);
      if (pending) {
        await pending.catch(() => undefined);
      }
    }
    record.status = "stopped";
    record.updatedAt = new Date(this.nowFn()).toISOString();
    return { ...record };
  }

  public async refreshHealth(): Promise<ManagedAgentRecord[]> {
    const nowMs = this.nowFn();
    for (const record of this.agents.values()) {
      if (record.runtime !== "desktop" || !record.conversationId || record.status === "stopped") {
        continue;
      }
      let rpcStatus: ManagedAgentStatus = record.status;
      try {
        rpcStatus = await this.desktopAdapter.getStatus(record.conversationId);
      } catch {
        continue;
      }
      const isRunning = rpcStatus === "running";
      if (this.appDataDir) {
        const transcriptPath = path.join(
          this.appDataDir,
          "brain",
          record.conversationId,
          ".system_generated",
          "logs",
          "transcript.jsonl",
        );
        record.status = inspectTranscriptHealth({
          transcriptPath,
          isRunning,
          nowMs,
          stallThresholdMs: this.stallThresholdMs,
        });
      } else {
        record.status = rpcStatus;
      }
      record.updatedAt = new Date(nowMs).toISOString();
    }
    return this.getAgents();
  }

  public getAgents(): ManagedAgentRecord[] {
    return Array.from(this.agents.values()).map((record) => ({ ...record }));
  }

  public async stopAll(): Promise<void> {
    this.agyAdapter.stopAll();
    await Promise.allSettled(Array.from(this.pendingDone.values()));
    const nowIso = new Date(this.nowFn()).toISOString();
    for (const record of this.agents.values()) {
      if (record.runtime === "agy" && (record.status === "running" || record.status === "stalled")) {
        record.status = "stopped";
        record.updatedAt = nowIso;
      }
    }
  }

  private countActiveAgentsForWorkspace(workspacePath: string): number {
    const normalizedTarget = path.resolve(workspacePath).toLowerCase();
    let count = 0;
    for (const record of this.agents.values()) {
      const normalizedRecord = path.resolve(record.workspacePath).toLowerCase();
      if (
        normalizedRecord === normalizedTarget &&
        (record.status === "running" || record.status === "stalled")
      ) {
        count += 1;
      }
    }
    return count;
  }
}
