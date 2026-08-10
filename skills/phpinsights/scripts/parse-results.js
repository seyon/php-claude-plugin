#!/usr/bin/env node
// Groups a `phpinsights analyse --format=json` report by "insight class"
// (the fully-qualified class of the underlying sniff/rule/insight, e.g.
// "SlevomatCodingStandard\Sniffs\Namespaces\UnusedUsesSniff") and
// determines whether a fix workflow already exists for it:
//   1. shipped with this plugin, in scripts/workflows/<slug>.js -- covers
//      common insights out of the box, for every project
//   2. previously generated for this project, listed in its Recipe
//      Registry (a markdown table in CLAUDE.md / CLAUDE.local.md)
//   3. neither -> unknown, a new workflow must be generated (SKILL.md step 4b)
//
// NOTE: PHPInsights' exact JSON field names have not been verified here
// against a live run. This script tries a couple of plausible field-name
// variants defensively (`insightClass`/`insight_class`/`class`, etc.), but
// verify once against a real `vendor/bin/phpinsights analyse --format=json`
// run for the target project's installed PHPInsights version and adjust
// FIELD lookups below if they don't match.
//
// Usage:
//   node parse-results.js --report <phpinsights.json> [--registry <CLAUDE.md>]
'use strict';

const fs = require('fs');
const path = require('path');
const { slugify, workflowPathForInsight } = require('./slugify');

const PLUGIN_WORKFLOWS_DIR = path.join(__dirname, 'workflows');

function pluginWorkflowPath(slug) {
  const file = path.join(PLUGIN_WORKFLOWS_DIR, `${slug}.js`);
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

const NO_INSIGHT = 'no-insight-class';

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
    const [insightClass, workflowPath] = cells;
    if (insightClass === 'Insight class' || insightClass.startsWith('---')) continue;
    known.set(insightClass, workflowPath);
  }
  return known;
}

// Flattens whatever shape the report's issue list turns out to be in --
// either a flat array under a top-level/`Report`-nested "issues" key, or
// grouped by category ({ code: [...], complexity: [...], ... }).
function extractIssues(report) {
  const root = pick(report, ['Report', 'report']) || report;
  const issues = pick(root, ['issues', 'Issues']);
  if (Array.isArray(issues)) return issues;
  if (issues && typeof issues === 'object') {
    return Object.entries(issues).flatMap(([category, list]) =>
      (Array.isArray(list) ? list : []).map((issue) => ({ category, ...issue })));
  }
  return [];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.report) {
    process.stderr.write('Usage: parse-results.js --report <phpinsights.json> [--registry <CLAUDE.md>]\n');
    process.exit(1);
  }

  const raw = fs.readFileSync(args.report, 'utf8');
  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`Invalid PHPInsights JSON report at ${args.report}: ${err.message}\n`);
    process.exit(1);
  }

  const registry = readRegistry(args.registry);
  const groupsByInsight = new Map();

  for (const issue of extractIssues(report)) {
    const insightClass = pick(issue, ['insightClass', 'insight_class', 'class', 'insight']) || NO_INSIGHT;
    const file = pick(issue, ['file', 'File']);
    const line = pick(issue, ['line', 'Line', 'lineNumber']);
    const message = pick(issue, ['message', 'Message', 'title', 'Title']) || '';
    const category = pick(issue, ['category', 'Category']) || null;

    if (!groupsByInsight.has(insightClass)) {
      const slug = insightClass === NO_INSIGHT ? NO_INSIGHT : slugify(insightClass);
      const shipped = insightClass === NO_INSIGHT ? null : pluginWorkflowPath(slug);
      const registered = registry.get(insightClass) || null;
      groupsByInsight.set(insightClass, {
        insightClass,
        slug,
        category,
        count: 0,
        items: [],
        // Plugin-shipped workflows win over a project-local one for the
        // same insight class, so a hand-authored, broadly-tested recipe is
        // always preferred over a project-generated one.
        workflowPath: shipped || registered || (insightClass === NO_INSIGHT ? null : workflowPathForInsight(insightClass)),
        workflowSource: shipped ? 'plugin' : registered ? 'project' : null,
        known: Boolean(shipped || registered),
      });
    }

    const group = groupsByInsight.get(insightClass);
    group.count += 1;
    group.items.push({ file, line, message });
  }

  const groups = [...groupsByInsight.values()].sort((a, b) => b.count - a.count);

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
