// @scry.entry
// id: sidecars.state-store~30401ecd
// kind: code
// summary: >-
//   Persist sidecar state snapshots and command queues atomically inside PLUGIN_DATA.
//   Also: state-store, plugin-data, atomic-write, commands, ipc, sidecar
// status: active
// weight: 0.85
// tags: ["topic:sidecar", "sidecar", "scope:sidecars", "sidecars", "persistence"]
// rationale: >-
//   Gives the MCP server and sidecar daemon a crash-safe shared state and command channel.
// applies: reading sidecar state, writing state snapshots, queueing sidecar commands
// seeded_questions:
//   - "How does SidecarStateStore persist state.json and drain commands.jsonl?"
//   - "sidecars/beads-gatekeeper/state-store.ts SidecarStateStore"
// @scry.entry.end

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SidecarCommand, SidecarStateSnapshot } from './types.js';

const EMPTY_STATE: SidecarStateSnapshot = {
  updatedAt: '',
  doltStates: [],
  gateStates: [],
  agents: [],
};

/**
 * Resolve the persistent plugin data directory for the Beads Gatekeeper sidecar.
 */
export function resolvePluginDataDir(): string {
  const override = process.env.BEADS_PLUGIN_DATA || process.env.PLUGIN_DATA;
  if (override && override.trim()) {
    return resolve(override.trim());
  }
  return join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'beads-visualizer');
}

/**
 * Manage atomic state snapshots, opt-in config paths, and queued commands in PLUGIN_DATA.
 */
export class SidecarStateStore {
  readonly dataDir: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly commandsPath: string;

  constructor(dataDir: string = resolvePluginDataDir()) {
    this.dataDir = resolve(dataDir);
    this.configPath = join(this.dataDir, 'config.json');
    this.statePath = join(this.dataDir, 'state.json');
    this.commandsPath = join(this.dataDir, 'commands.jsonl');
  }

  /**
   * Read the latest sidecar state snapshot, returning an empty state when absent.
   */
  async readState(): Promise<SidecarStateSnapshot> {
    if (!existsSync(this.statePath)) {
      return { ...EMPTY_STATE };
    }
    try {
      const raw = await readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SidecarStateSnapshot>;
      return {
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
        daemonPid: typeof parsed.daemonPid === 'number' ? parsed.daemonPid : undefined,
        doltStates: Array.isArray(parsed.doltStates) ? parsed.doltStates : [],
        gateStates: Array.isArray(parsed.gateStates) ? parsed.gateStates : [],
        agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      };
    } catch {
      return { ...EMPTY_STATE };
    }
  }

  /**
   * Write the sidecar state snapshot atomically with a temp file and rename.
   */
  async writeState(snapshot: SidecarStateSnapshot): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const tempPath = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
    await rename(tempPath, this.statePath);
  }

  /**
   * Append one command to the sidecar command queue.
   */
  async appendCommand(command: SidecarCommand): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await appendFile(this.commandsPath, `${JSON.stringify(command)}\n`, 'utf-8');
  }

  /**
   * Drain and clear all queued sidecar commands.
   */
  async drainCommands(): Promise<SidecarCommand[]> {
    if (!existsSync(this.commandsPath)) {
      return [];
    }
    const processingPath = `${this.commandsPath}.processing-${process.pid}-${Date.now()}`;
    try {
      await rename(this.commandsPath, processingPath);
    } catch {
      return [];
    }
    try {
      const raw = await readFile(processingPath, 'utf-8');
      const commands: SidecarCommand[] = [];
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as SidecarCommand;
          if (parsed && typeof parsed.type === 'string') {
            commands.push(parsed);
          }
        } catch {
          // Skip malformed command lines without blocking valid commands.
        }
      }
      await writeFile(processingPath, '', 'utf-8');
      return commands;
    } catch {
      return [];
    }
  }
}
