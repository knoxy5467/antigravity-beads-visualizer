// @scry.entry
// id: src.build-plugin~f281d8b2
// kind: code
// summary: >-
//   Bundle the single-file MCP App HTML and Antigravity plugin package using esbuild.
//   Also: build, plugin, esbuild, mcp-app, singlefile, packaging
// status: active
// weight: 0.85
// tags: ["topic:build", "build", "scope:src", "src", "plugin", "typescript"]
// rationale: >-
//   Produces a self-contained app.html under 10 MiB and an installable Antigravity plugin directory.
// applies: bundling mcp app html, bundling mcp stdio server, writing plugin manifests
// seeded_questions:
//   - "How does build-plugin.ts produce dist/mcp-app/app.html and dist/plugin?"
//   - "src/scripts/build-plugin.ts buildPluginArtifacts"
// @scry.entry.end

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = __dirname.includes(join('dist', 'src'))
  ? resolve(__dirname, '..', '..', '..')
  : resolve(__dirname, '..', '..');

const MAX_HTML_BYTES = 10 * 1024 * 1024;

const PLUGIN_SKILL_MD = `---
name: beads-visualizer
description: Open the interactive Beads Visualizer to inspect nested epics, dependency graphs, workflow lanes, and gates.
---

# Beads Visualizer

Use this skill when the user wants to inspect Beads epics, tasks, dependency graphs, workflow lanes, or gates.

1. Call \`beads_open_visualizer\` to open the Beads Visualizer pane.
2. Keep all inspection read-only from the visualizer.
3. Let the user attach quote pills or send gate decisions from the pane.
`;

const PLUGIN_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="14" fill="#18202c"/>
  <circle cx="18" cy="18" r="6" fill="#2f81f7"/>
  <circle cx="46" cy="18" r="6" fill="#3fb950"/>
  <circle cx="32" cy="46" r="6" fill="#d29922"/>
  <path d="M23 20L41 18M21 23L30 41M43 23L34 41" stroke="#9fb0c3" stroke-width="3" stroke-linecap="round"/>
</svg>
`;

/**
 * Bundle the MCP App single-file HTML and Antigravity plugin package.
 */
export async function buildPluginArtifacts(repoRoot: string = REPO_ROOT): Promise<void> {
  const mcpAppDir = join(repoRoot, 'dist', 'mcp-app');
  const pluginDir = join(repoRoot, 'dist', 'plugin');
  const pluginBinDir = join(pluginDir, 'bin');
  const pluginAssetsDir = join(pluginDir, 'assets');
  const pluginSkillDir = join(pluginDir, 'skills', 'beads-visualizer');
  const pluginSidecarDir = join(pluginDir, 'sidecars', 'beads-gatekeeper');

  await Promise.all([
    mkdir(mcpAppDir, { recursive: true }),
    mkdir(pluginBinDir, { recursive: true }),
    mkdir(pluginAssetsDir, { recursive: true }),
    mkdir(pluginSkillDir, { recursive: true }),
    mkdir(pluginSidecarDir, { recursive: true }),
  ]);

  const uiBundle = await build({
    entryPoints: [join(repoRoot, 'src', 'ui', 'app.ts')],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    write: false,
  });

  const bundledJs = uiBundle.outputFiles[0]?.text ?? '';
  const [templateHtml, stylesCss] = await Promise.all([
    readFile(join(repoRoot, 'src', 'ui', 'index.html'), 'utf-8'),
    readFile(join(repoRoot, 'src', 'ui', 'styles.css'), 'utf-8'),
  ]);

  const safeCss = stylesCss.replace(/<\/style>/gi, '<\\/style>');
  const safeJs = bundledJs.replace(/<\/script>/gi, '<\\/script>');
  const singleFileHtml = templateHtml
    .replace(/<link[^>]+rel=["']stylesheet["'][^>]*>\s*/i, () => `<style>${safeCss}</style>\n`)
    .replace(/<script[^>]+src=["'][^"']+["'][^>]*><\/script>\s*/i, () => `<script>${safeJs}</script>\n`);

  const htmlBytes = Buffer.byteLength(singleFileHtml, 'utf-8');
  if (htmlBytes >= MAX_HTML_BYTES) {
    throw new Error(`Bundled app.html exceeds 10 MiB (${htmlBytes} bytes).`);
  }

  const appJsPath = join(mcpAppDir, 'app.js');
  const appHtmlPath = join(mcpAppDir, 'app.html');
  await writeFile(appJsPath, bundledJs, 'utf-8');
  await writeFile(appHtmlPath, singleFileHtml, 'utf-8');
  await copyFile(appHtmlPath, join(pluginAssetsDir, 'app.html'));

  await build({
    entryPoints: [join(repoRoot, 'src', 'mcp', 'server.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    outfile: join(pluginBinDir, 'beads-visualizer-mcp.mjs'),
    banner: {
      js: '#!/usr/bin/env node\nimport { createRequire as __bvCreateRequire } from "node:module"; const require = __bvCreateRequire(import.meta.url);',
    },
  });

  await build({
    entryPoints: [join(repoRoot, 'sidecars', 'beads-gatekeeper', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    outfile: join(pluginSidecarDir, 'main.mjs'),
    banner: {
      js: '#!/usr/bin/env node\nimport { createRequire as __bvCreateRequire } from "node:module"; const require = __bvCreateRequire(import.meta.url);',
    },
  });

  const sidecarJson = {
    name: 'beads-gatekeeper',
    description: 'Monitor opt-in Beads Dolt servers, deterministic gates, and managed workers.',
    command: ['node', 'sidecars/beads-gatekeeper/main.mjs'],
    restart_policy: 'always',
    has_web_ui: false,
    agent_permissions: [
      'command(bd)',
      'command(dolt)',
      'command(agy)',
      'mcp(beads-visualizer_beads)',
    ],
  };

  const pluginJson = {
    name: 'beads-visualizer',
    version: '0.1.0',
    description: 'Read-only Beads Visualizer for nested epics, dependency graphs, workflow lanes, and gates.',
  };

  const mcpConfigJson = {
    mcpServers: {
      beads: {
        command: 'node',
        args: ['${PLUGIN_ROOT}/bin/beads-visualizer-mcp.mjs'],
      },
    },
  };

  await Promise.all([
    writeFile(join(pluginDir, 'plugin.json'), `${JSON.stringify(pluginJson, null, 2)}\n`, 'utf-8'),
    writeFile(join(pluginDir, 'mcp_config.json'), `${JSON.stringify(mcpConfigJson, null, 2)}\n`, 'utf-8'),
    writeFile(join(pluginSidecarDir, 'sidecar.json'), `${JSON.stringify(sidecarJson, null, 2)}\n`, 'utf-8'),
    writeFile(join(pluginSkillDir, 'SKILL.md'), PLUGIN_SKILL_MD, 'utf-8'),
    writeFile(join(pluginAssetsDir, 'logo.svg'), PLUGIN_LOGO_SVG, 'utf-8'),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void buildPluginArtifacts();
}
