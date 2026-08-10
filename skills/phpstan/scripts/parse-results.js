#!/usr/bin/env node
// Groups a `phpstan analyse --error-format=json` report by error
// `identifier` (https://phpstan.org/error-identifiers) and determines,
// for each identifier, whether a fix workflow already exists:
//   1. shipped with this plugin, in scripts/workflows/<slug>.js — covers
//      common identifiers out of the box, for every project
//   2. previously generated for this project, listed in its Recipe
//      Registry (a markdown table in CLAUDE.md / CLAUDE.local.md)
//   3. neither -> unknown, a new workflow must be generated (see SKILL.md
//      step 4b), which is written to the project-local path convention
//
// Usage:
//   node parse-results.js --report <phpstan.json> [--registry <CLAUDE.md>]
//
// Prints a single JSON object to stdout (see SKILL.md "groups" shape).
'use strict';

const fs = require('fs');
const path = require('path');
const { slugify, workflowPathForIdentifier } = require('./slugify');

const PLUGIN_WORKFLOWS_DIR = path.join(__dirname, 'workflows');

function pluginWorkflowPath(slug) {
  const file = path.join(PLUGIN_WORKFLOWS_DIR, `${slug}.js`);
  return fs.existsSync(file) ? file : null;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

// Errors without a machine identifier (older phpstan versions, or a small
// number of checks that don't set one) are grouped under "no-identifier" so
// they still surface, but they never get an auto-generated fix workflow —
// the identifier is precisely what keys the recipe registry.
const NO_IDENTIFIER = 'no-identifier';

function readRegistry(registryPath) {
  const known = new Map();
  if (!registryPath || !fs.existsSync(registryPath)) return known;

  const content = fs.readFileSync(registryPath, 'utf8');
  const sectionMatch = content.match(/###\s*Recipe Registry([\s\S]*?)(\n##|\n?$)/);
  if (!sectionMatch) return known;

  const rows = sectionMatch[1].split('\n').filter((line) => line.trim().startsWith('|'));
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const [identifier, workflowPath] = cells;
    if (identifier === 'Error identifier' || identifier.startsWith('---')) continue;
    known.set(identifier, workflowPath);
  }
  return known;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.report) {
    process.stderr.write('Usage: parse-results.js --report <phpstan.json> [--registry <CLAUDE.md>]\n');
    process.exit(1);
  }

  const raw = fs.readFileSync(args.report, 'utf8');
  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`Invalid PHPStan JSON report at ${args.report}: ${err.message}\n`);
    process.exit(1);
  }

  const registry = readRegistry(args.registry);
  const groupsByIdentifier = new Map();

  const files = report.files || {};
  for (const [file, fileReport] of Object.entries(files)) {
    for (const msg of fileReport.messages || []) {
      const identifier = msg.identifier || NO_IDENTIFIER;
      if (!groupsByIdentifier.has(identifier)) {
        const slug = identifier === NO_IDENTIFIER ? NO_IDENTIFIER : slugify(identifier);
        const shipped = identifier === NO_IDENTIFIER ? null : pluginWorkflowPath(slug);
        const registered = registry.get(identifier) || null;
        groupsByIdentifier.set(identifier, {
          identifier,
          slug,
          count: 0,
          items: [],
          // Plugin-shipped workflows win over a project-local one for the
          // same identifier, so a hand-authored, broadly-tested recipe is
          // always preferred over a project-generated one.
          workflowPath: shipped || registered || (identifier === NO_IDENTIFIER ? null : workflowPathForIdentifier(identifier)),
          workflowSource: shipped ? 'plugin' : registered ? 'project' : null,
          known: Boolean(shipped || registered),
        });
      }
      const group = groupsByIdentifier.get(identifier);
      group.count += 1;
      group.items.push({ file, line: msg.line, message: msg.message });
    }
  }

  const groups = [...groupsByIdentifier.values()].sort((a, b) => b.count - a.count);

  // Context hygiene: the full item lists are written to per-group files and
  // only referenced by path (`itemsFile`) in the printed summary, so
  // hundreds of findings never enter the orchestrating conversation's
  // context. Workflows load their group's file themselves (see the loader
  // stanza in every workflow script); `sampleItems` (first 3) stays inline
  // for the recipe/strategy generation step (SKILL.md 4b).
  const itemsDir = `${path.resolve(args.report)}-groups`;
  fs.mkdirSync(itemsDir, { recursive: true });
  for (const group of groups) {
    group.itemsFile = path.join(itemsDir, `${group.slug}.json`);
    fs.writeFileSync(group.itemsFile, JSON.stringify(group.items, null, 2) + '\n');
    group.sampleItems = group.items.slice(0, 3);
    delete group.items;
  }
  process.stdout.write(JSON.stringify({ groups }, null, 2) + '\n');
}

main();
