// @scry.entry
// id: sidecars.workspace-registry~11288af0
// kind: code
// summary: >-
//   Load and save explicit opt-in workspace configs and parse Beads Dolt metadata.
//   Also: workspace-registry, opt-in, metadata, dolt, config
// status: active
// weight: 0.85
// tags: ["topic:sidecar", "sidecar", "scope:sidecars", "sidecars", "dolt", "beads"]
// rationale: >-
//   Ensures the sidecar supervises Dolt and runs gate automation only for approved Beads workspaces.
// applies: loading opt-in config, saving workspace settings, reading .beads/metadata.json
// seeded_questions:
//   - "How does workspace-registry.ts validate opt-in workspaces and parse metadata.json?"
//   - "sidecars/beads-gatekeeper/workspace-registry.ts loadOptInConfig"
// @scry.entry.end

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isBeadsWorkspaceDir } from '../../src/standalone/server.js';
import type { DoltMetadata, OptInWorkspaceConfig, SidecarConfig } from './types.js';

function normalizePathKey(dir: string): string {
  const abs = resolve(dir);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function sanitizeWorkspaceEntry(entry: Partial<OptInWorkspaceConfig>): OptInWorkspaceConfig | null {
  if (!entry.workspacePath || typeof entry.workspacePath !== 'string') return null;
  const resolvedPath = resolve(entry.workspacePath);
  if (!isBeadsWorkspaceDir(resolvedPath)) return null;
  return {
    workspacePath: resolvedPath,
    autoStartDolt: Boolean(entry.autoStartDolt),
    autoCheckGates: Boolean(entry.autoCheckGates),
    pollIntervalMs:
      typeof entry.pollIntervalMs === 'number' && entry.pollIntervalMs >= 1000
        ? Math.floor(entry.pollIntervalMs)
        : 15000,
    maxConcurrentWorkers:
      typeof entry.maxConcurrentWorkers === 'number' && entry.maxConcurrentWorkers >= 1
        ? Math.floor(entry.maxConcurrentWorkers)
        : 2,
  };
}

/**
 * Load the explicit opt-in workspace configuration from disk.
 */
export async function loadOptInConfig(configPath: string): Promise<SidecarConfig> {
  if (!existsSync(configPath)) {
    return { workspaces: [] };
  }
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as { workspaces?: Array<Partial<OptInWorkspaceConfig>> };
    const seen = new Set<string>();
    const valid: OptInWorkspaceConfig[] = [];
    for (const item of parsed.workspaces || []) {
      const clean = sanitizeWorkspaceEntry(item);
      if (!clean) continue;
      const key = normalizePathKey(clean.workspacePath);
      if (seen.has(key)) continue;
      seen.add(key);
      valid.push(clean);
    }
    return { workspaces: valid };
  } catch {
    return { workspaces: [] };
  }
}

/**
 * Save sanitized opt-in workspace entries atomically to disk.
 */
export async function saveOptInConfig(configPath: string, config: SidecarConfig): Promise<SidecarConfig> {
  const seen = new Set<string>();
  const valid: OptInWorkspaceConfig[] = [];
  for (const item of config.workspaces || []) {
    const clean = sanitizeWorkspaceEntry(item);
    if (!clean) continue;
    const key = normalizePathKey(clean.workspacePath);
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(clean);
  }

  const normalized: SidecarConfig = { workspaces: valid };
  await mkdir(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  await rename(tempPath, configPath);
  return normalized;
}

/**
 * Return true when workspacePath belongs to the opt-in configuration.
 */
export function isOptInWorkspace(config: SidecarConfig, workspacePath: string): boolean {
  const key = normalizePathKey(workspacePath);
  return config.workspaces.some((item) => normalizePathKey(item.workspacePath) === key);
}

/**
 * Read Dolt server mode, port, and database name from .beads/metadata.json.
 */
export async function readBeadsDoltMetadata(workspacePath: string): Promise<DoltMetadata> {
  const metaPath = join(resolve(workspacePath), '.beads', 'metadata.json');
  if (!existsSync(metaPath)) {
    return { doltMode: 'embedded', doltServerPort: 3307, doltDatabase: 'beads' };
  }
  try {
    const raw = await readFile(metaPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      dolt_mode?: string;
      dolt_server_port?: number;
      dolt_database?: string;
    };
    const doltMode = parsed.dolt_mode === 'server' ? 'server' : 'embedded';
    const doltServerPort =
      typeof parsed.dolt_server_port === 'number' && parsed.dolt_server_port > 0
        ? parsed.dolt_server_port
        : 3307;
    const doltDatabase =
      typeof parsed.dolt_database === 'string' && parsed.dolt_database.trim()
        ? parsed.dolt_database.trim()
        : 'beads';
    return { doltMode, doltServerPort, doltDatabase };
  } catch {
    return { doltMode: 'embedded', doltServerPort: 3307, doltDatabase: 'beads' };
  }
}
