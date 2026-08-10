#!/usr/bin/env node
// Groups a `deptrac analyse --formatter=json` report by violated layer pair
// (Layer -> DependentLayer) and resolves, for each pair, which fix
// mechanism applies:
//   1. A plugin-shipped, generic fix strategy (scripts/strategies/<slug>.js)
//      that this project's Layer Map assigns to the pair, plus the
//      project-specific "context" notes needed to make that generic
//      strategy concrete (where ports/interfaces live, DI style, etc.)
//   2. A project-local custom workflow (.claude/workflows/deptrac-<slug>.js)
//      for pairs where none of the shipped strategies fit
//   3. Neither -> unknown, needs a one-time "architecture analyst" pass
//      (see SKILL.md step 4b) to decide which of the two above applies
//
// Two report shapes are supported:
//   a) The per-file shape produced by qossmic/deptrac's JsonOutputFormatter
//      (~1.x/2.x): { "Report": {...counts...}, "files": { "<path>":
//      { "violations": [{ "line", "message", ... }] } } }. Layer pair and
//      class names are recovered from the message text
//      ("ClassA must not depend on ClassB (LayerA on LayerB)").
//   b) A flat violations array with Layer/DependentLayer/Class/Dependency
//      fields (older/alternative formatters) — tried defensively with a
//      couple of common casings.
//
// Baseline: violations covered by the project's baseline (skip_violations,
// usually imported from deptrac.baseline.yaml) are reported by Deptrac as
// "skipped" — they are ALWAYS excluded here, in every shape (type/skipped
// markers and "[SKIPPED]" message prefixes), so a baselined violation is
// never dispatched to a fix workflow.
//
// Usage:
//   node parse-results.js --report <deptrac.json> [--registry <CLAUDE.md>]
'use strict';

const fs = require('fs');
const path = require('path');
const { slugify, layerPairKey, layerPairSlug, customWorkflowPathForPair } = require('./slugify');

const STRATEGIES_DIR = path.join(__dirname, 'strategies');

function pluginStrategyPath(strategySlug) {
  const file = path.join(STRATEGIES_DIR, `${strategySlug}.js`);
  return fs.existsSync(file) ? file : null;
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

// Parses the "### Layer Map" table: | Layer Pair | Strategy | Notes |
// where "Layer Pair" is formatted as "LayerA -> LayerB".
function readLayerMap(registryPath) {
  const known = new Map();
  if (!registryPath || !fs.existsSync(registryPath)) return known;

  const content = fs.readFileSync(registryPath, 'utf8');
  const sectionMatch = content.match(/###\s*Layer Map([\s\S]*?)(\n##|\n?$)/);
  if (!sectionMatch) return known;

  const rows = sectionMatch[1].split('\n').filter((line) => line.trim().startsWith('|'));
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const [pair, strategy, notes] = cells;
    if (pair === 'Layer Pair' || pair.startsWith('---')) continue;
    known.set(pair, { strategy, notes: notes || '' });
  }
  return known;
}

function isSkipped(entry, message) {
  const type = String(pick(entry, ['type', 'Type']) || '').toLowerCase();
  if (type === 'skipped') return true;
  if (pick(entry, ['skipped', 'Skipped']) === true) return true;
  return /^\s*\[SKIPPED\]/i.test(message || '');
}

// "App\A must not depend on App\B (Domain on Infrastructure)"
const MESSAGE_RE = /^\s*(?:\[SKIPPED\]\s*)?(\S+)\s+must not depend on\s+(\S+)\s+\((.+?) on (.+?)\)\s*$/i;

// Normalizes the per-file JsonOutputFormatter shape (see header) into the
// flat violation objects the grouping below expects. Rows that are
// baselined ("skipped") are dropped; rows whose message isn't a layer
// violation (uncovered/allowed/warnings) are ignored.
function violationsFromFiles(files) {
  const out = [];
  for (const [file, entry] of Object.entries(files || {})) {
    const rows = [
      ...(pick(entry, ['violations', 'Violations']) || []),
      ...(pick(entry, ['messages', 'Messages']) || []),
    ];
    for (const row of rows) {
      const message = pick(row, ['message', 'Message']) || '';
      if (isSkipped(row, message)) continue;
      const match = message.match(MESSAGE_RE);
      if (!match) continue;
      out.push({
        Layer: match[3],
        DependentLayer: match[4],
        Class: match[1],
        Dependency: { Class: match[2], FileOrDirectory: file, Line: pick(row, ['line', 'Line']) },
        Rule: message,
      });
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.report) {
    process.stderr.write('Usage: parse-results.js --report <deptrac.json> [--registry <CLAUDE.md>]\n');
    process.exit(1);
  }

  const raw = fs.readFileSync(args.report, 'utf8');
  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`Invalid Deptrac JSON report at ${args.report}: ${err.message}\n`);
    process.exit(1);
  }

  const layerMap = readLayerMap(args.registry);
  let violations = pick(report, ['Report'])
    ? pick(report.Report, ['Violations', 'violations'])
    : pick(report, ['Violations', 'violations']);
  if (!Array.isArray(violations)) {
    // Per-file JsonOutputFormatter shape ("Report" only holds counts there).
    violations = violationsFromFiles(pick(report, ['files', 'Files']));
  }

  const groupsByPair = new Map();

  for (const v of violations || []) {
    if (isSkipped(v, pick(v, ['Rule', 'rule', 'message', 'Message']))) continue;
    const layer = pick(v, ['Layer', 'layer']);
    const dependentLayer = pick(v, ['DependentLayer', 'dependent_layer', 'dependentLayer']);
    const rule = pick(v, ['Rule', 'rule']);
    const cls = pick(v, ['Class', 'class']);
    const dependency = pick(v, ['Dependency', 'dependency']) || {};
    const dependencyClass = pick(dependency, ['Class', 'class']);
    const file = pick(dependency, ['FileOrDirectory', 'file_or_directory', 'file']);
    const line = pick(dependency, ['Line', 'line']);

    const pairKey = layerPairKey(layer, dependentLayer);
    if (!groupsByPair.has(pairKey)) {
      const slug = layerPairSlug(layer, dependentLayer);
      const registryEntry = layerMap.get(pairKey);
      let workflowPath = null;
      let workflowSource = null;
      let strategy = null;
      let context = '';

      if (registryEntry) {
        strategy = registryEntry.strategy;
        context = registryEntry.notes;
        const shipped = pluginStrategyPath(strategy);
        if (shipped) {
          workflowPath = shipped;
          workflowSource = 'plugin-strategy';
        } else {
          const customPath = customWorkflowPathForPair(layer, dependentLayer);
          workflowPath = customPath;
          workflowSource = fs.existsSync(customPath) ? 'project-custom' : null;
        }
      }

      groupsByPair.set(pairKey, {
        layer,
        dependentLayer,
        pairKey,
        slug,
        rule,
        count: 0,
        items: [],
        strategy,
        context,
        workflowPath: workflowPath || customWorkflowPathForPair(layer, dependentLayer),
        workflowSource,
        known: Boolean(workflowSource),
      });
    }

    const group = groupsByPair.get(pairKey);
    group.count += 1;
    group.items.push({ class: cls, dependencyClass, file, line });
  }

  const groups = [...groupsByPair.values()].sort((a, b) => b.count - a.count);
  process.stdout.write(JSON.stringify({ groups }, null, 2) + '\n');
}

main();
