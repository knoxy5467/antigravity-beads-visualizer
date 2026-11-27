import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  AgyCliAgentAdapter,
  DesktopAgentAdapter,
  HybridAgentManager,
  inspectTranscriptHealth,
} from "../../sidecars/beads-gatekeeper/agent-manager.js";

const tempDirs: string[] = [];
const servers: http.Server[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-agent-mgr-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});

describe("DesktopAgentAdapter", () => {
  it("creates and polls desktop conversations through ConversationService and sidecar_sdk", async () => {
    const requests: Array<{ path: string; csrf: string | undefined; body: unknown }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        requests.push({
          path: req.url ?? "",
          csrf: typeof req.headers["x-antigravity-csrf-token"] === "string"
            ? req.headers["x-antigravity-csrf-token"]
            : undefined,
          body: raw ? JSON.parse(raw) : {},
        });
        res.setHeader("Content-Type", "application/json");
        if (req.url?.endsWith("/CreateConversation")) {
          res.end(JSON.stringify({ conversationId: "conv-desktop-1" }));
          return;
        }
        if (req.url?.endsWith("/GetConversation")) {
          res.end(JSON.stringify({ conversationId: "conv-desktop-1", runState: "RUN_STATE_RUNNING" }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      });
    });
    servers.push(server);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const sentMessages: Array<{ conversationId: string; prompt: string }> = [];
    const adapter = new DesktopAgentAdapter({
      lsAddress: `127.0.0.1:${address.port}`,
      csrfToken: "csrf-secret-123",
      sidecarSdk: {
        sendMessage: async (conversationId: string, prompt: string) => {
          sentMessages.push({ conversationId, prompt });
        },
      },
    });

    const spawned = await adapter.spawn({
      workspacePath: "C:\\repo",
      beadId: "bv-task-1",
      prompt: "Run unit tests for bv-task-1.",
    });

    assert.equal(spawned.conversationId, "conv-desktop-1");
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].conversationId, "conv-desktop-1");

    const status = await adapter.getStatus("conv-desktop-1");
    assert.equal(status, "running");

    assert.equal(requests.length, 2);
    assert.equal(requests[0].path, "/product.v1.ConversationService/CreateConversation");
    assert.equal(requests[0].csrf, "csrf-secret-123");
    assert.equal(requests[1].path, "/product.v1.ConversationService/GetConversation");
  });
});

describe("AgyCliAgentAdapter", () => {
  it("runs a stream-json worker process and reads NDJSON completion", async () => {
    const tmpDir = makeTempDir();
    const mockScript = path.join(tmpDir, "mock-agy.mjs");
    fs.writeFileSync(
      mockScript,
      [
        "import readline from 'node:readline';",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', (line) => {",
        "  const msg = JSON.parse(line);",
        "  process.stdout.write(JSON.stringify({ type: 'ack', prompt: msg.content }) + '\\n');",
        "  process.stdout.write(JSON.stringify({ type: 'result', status: 'idle' }) + '\\n');",
        "  process.exit(0);",
        "});",
      ].join("\n"),
      "utf8",
    );

    const adapter = new AgyCliAgentAdapter({
      agyExecutable: process.execPath,
      baseArgs: [mockScript],
    });

    const handle = adapter.spawn({
      workspacePath: tmpDir,
      beadId: "bv-task-2",
      prompt: "Check gate status.",
    });

    assert.ok(typeof handle.pid === "number" && handle.pid > 0);
    const result = await handle.done;
    assert.equal(result.status, "idle");
  });

  it("cancels a running worker process by PID", async () => {
    const tmpDir = makeTempDir();
    const mockScript = path.join(tmpDir, "slow-agy.mjs");
    fs.writeFileSync(
      mockScript,
      [
        "process.stdout.write(JSON.stringify({ type: 'started' }) + '\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );

    const adapter = new AgyCliAgentAdapter({
      agyExecutable: process.execPath,
      baseArgs: [mockScript],
    });

    const handle = adapter.spawn({
      workspacePath: tmpDir,
      beadId: "bv-task-3",
      prompt: "Long worker task.",
    });

    assert.ok(typeof handle.pid === "number" && handle.pid > 0);
    const cancelled = adapter.cancel(handle.pid);
    assert.equal(cancelled, true);
    const result = await handle.done;
    assert.equal(result.status, "stopped");
  });

  it("stops a worker process when execution timeout expires", async () => {
    const tmpDir = makeTempDir();
    const mockScript = path.join(tmpDir, "timeout-agy.mjs");
    fs.writeFileSync(
      mockScript,
      "setInterval(() => {}, 1000);",
      "utf8",
    );

    const adapter = new AgyCliAgentAdapter({
      agyExecutable: process.execPath,
      baseArgs: [mockScript],
      timeoutMs: 120,
    });

    const handle = adapter.spawn({
      workspacePath: tmpDir,
      beadId: "bv-task-4",
      prompt: "Timeout worker task.",
    });

    const result = await handle.done;
    assert.equal(result.status, "failed");
    assert.match(result.lastError ?? "", /timeout/i);
  });
});

describe("inspectTranscriptHealth", () => {
  it("classifies running, idle, stalled, quota_exhausted, and failed transcripts", () => {
    const tmpDir = makeTempDir();

    const runningFile = path.join(tmpDir, "running.jsonl");
    fs.writeFileSync(runningFile, JSON.stringify({ type: "assistant", text: "Working" }) + "\n", "utf8");
    const nowMs = Date.now();
    assert.equal(
      inspectTranscriptHealth({ transcriptPath: runningFile, isRunning: true, nowMs, stallThresholdMs: 60_000 }),
      "running",
    );
    assert.equal(
      inspectTranscriptHealth({ transcriptPath: runningFile, isRunning: false, nowMs, stallThresholdMs: 60_000 }),
      "idle",
    );

    const stalledFile = path.join(tmpDir, "stalled.jsonl");
    fs.writeFileSync(stalledFile, JSON.stringify({ type: "assistant", text: "Waiting" }) + "\n", "utf8");
    const oldTime = new Date(nowMs - 120_000);
    fs.utimesSync(stalledFile, oldTime, oldTime);
    assert.equal(
      inspectTranscriptHealth({ transcriptPath: stalledFile, isRunning: true, nowMs, stallThresholdMs: 60_000 }),
      "stalled",
    );

    const quotaFile = path.join(tmpDir, "quota.jsonl");
    fs.writeFileSync(quotaFile, JSON.stringify({ type: "error", message: "RESOURCE_EXHAUSTED: quota exceeded" }) + "\n", "utf8");
    assert.equal(
      inspectTranscriptHealth({ transcriptPath: quotaFile, isRunning: false, nowMs }),
      "quota_exhausted",
    );

    const failedFile = path.join(tmpDir, "failed.jsonl");
    fs.writeFileSync(failedFile, JSON.stringify({ type: "error", status: "failed", message: "Unhandled crash" }) + "\n", "utf8");
    assert.equal(
      inspectTranscriptHealth({ transcriptPath: failedFile, isRunning: false, nowMs }),
      "failed",
    );

    const errorMessageFile = path.join(tmpDir, "error-message.jsonl");
    fs.writeFileSync(errorMessageFile, JSON.stringify({ type: "ERROR_MESSAGE", message: "Stream aborted" }) + "\n", "utf8");
    assert.equal(
      inspectTranscriptHealth({ transcriptPath: errorMessageFile, isRunning: false, nowMs }),
      "failed",
    );

    const http429File = path.join(tmpDir, "http-429.jsonl");
    fs.writeFileSync(http429File, JSON.stringify({ type: "error", message: "Upstream HTTP 429" }) + "\n", "utf8");
    assert.equal(
      inspectTranscriptHealth({ transcriptPath: http429File, isRunning: false, nowMs }),
      "quota_exhausted",
    );
  });
});

describe("HybridAgentManager", () => {
  it("prevents concurrent desktop spawns from exceeding maxConcurrentWorkers", async () => {
    const tmpDir = makeTempDir();
    let releaseSpawn: (() => void) | undefined;
    const desktopAdapter = {
      spawn: () =>
        new Promise<{ conversationId: string }>((resolve) => {
          releaseSpawn = () => resolve({ conversationId: "conv-slow" });
        }),
      getStatus: async () => "running" as const,
    } as unknown as DesktopAgentAdapter;

    const agyAdapter = new AgyCliAgentAdapter();
    const manager = new HybridAgentManager({ desktopAdapter, agyAdapter });

    const firstSpawn = manager.spawnAgent({
      workspacePath: tmpDir,
      beadId: "bv-race-1",
      runtime: "desktop",
      prompt: "First",
      maxConcurrentWorkers: 1,
    });

    await assert.rejects(
      () =>
        manager.spawnAgent({
          workspacePath: tmpDir,
          beadId: "bv-race-2",
          runtime: "desktop",
          prompt: "Second",
          maxConcurrentWorkers: 1,
        }),
      /maxConcurrentWorkers/i,
    );

    releaseSpawn?.();
    const record = await firstSpawn;
    assert.equal(record.conversationId, "conv-slow");
  });

  it("dispatches desktop and agy workers and enforces maxConcurrentWorkers", async () => {
    const tmpDir = makeTempDir();
    const slowScript = path.join(tmpDir, "slow-worker.mjs");
    fs.writeFileSync(slowScript, "setInterval(() => {}, 1000);", "utf8");

    const desktopAdapter = {
      spawn: async () => ({ conversationId: "conv-1" }),
      getStatus: async () => "running" as const,
    } as unknown as DesktopAgentAdapter;

    const agyAdapter = new AgyCliAgentAdapter({
      agyExecutable: process.execPath,
      baseArgs: [slowScript],
    });

    const manager = new HybridAgentManager({
      desktopAdapter,
      agyAdapter,
      appDataDir: tmpDir,
    });

    const desktopRecord = await manager.spawnAgent({
      workspacePath: tmpDir,
      beadId: "bv-1",
      runtime: "desktop",
      prompt: "Desktop task",
      maxConcurrentWorkers: 2,
    });
    assert.equal(desktopRecord.runtime, "desktop");
    assert.equal(desktopRecord.conversationId, "conv-1");
    assert.equal(desktopRecord.status, "running");

    const agyRecord = await manager.spawnAgent({
      workspacePath: tmpDir,
      beadId: "bv-2",
      runtime: "agy",
      prompt: "CLI task",
      maxConcurrentWorkers: 2,
    });
    assert.equal(agyRecord.runtime, "agy");
    assert.ok(typeof agyRecord.pid === "number" && agyRecord.pid > 0);

    await assert.rejects(
      () =>
        manager.spawnAgent({
          workspacePath: tmpDir,
          beadId: "bv-3",
          runtime: "agy",
          prompt: "Blocked by concurrency limit",
          maxConcurrentWorkers: 2,
        }),
      /maxConcurrentWorkers/i,
    );

    const stopped = await manager.cancelAgent(agyRecord.id);
    assert.equal(stopped.status, "stopped");
    await manager.stopAll();
  });

  it("sends follow-up messages and hydrates live desktop agents while marking dead agy PIDs stopped", async () => {
    const sent: Array<{ conversationId: string; prompt: string }> = [];
    const desktopAdapter = new DesktopAgentAdapter({
      sidecarSdk: {
        sendMessage: async (conversationId, prompt) => {
          sent.push({ conversationId, prompt });
        },
      },
    });
    const agyAdapter = new AgyCliAgentAdapter();

    const manager = new HybridAgentManager({
      desktopAdapter,
      agyAdapter,
      isPidAlive: (pid) => pid === 4444,
    });

    manager.hydrateAgents([
      {
        id: "agent-desktop-old",
        runtime: "desktop",
        beadId: "bv-1",
        workspacePath: "/synthetic/repo",
        status: "running",
        conversationId: "conv-old-1",
        startedAt: "2026-11-27T00:00:00Z",
        updatedAt: "2026-11-27T00:05:00Z",
      },
      {
        id: "agent-agy-dead",
        runtime: "agy",
        beadId: "bv-2",
        workspacePath: "/synthetic/repo",
        status: "running",
        pid: 9999,
        startedAt: "2026-11-27T00:00:00Z",
        updatedAt: "2026-11-27T00:05:00Z",
      },
    ]);

    const hydrated = manager.getAgents();
    assert.equal(hydrated.find((a) => a.id === "agent-desktop-old")?.status, "running");
    assert.equal(hydrated.find((a) => a.id === "agent-agy-dead")?.status, "stopped");

    await manager.sendMessageToAgent("conv-old-1", "Gate resolved; continue.");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.conversationId, "conv-old-1");
  });
});
