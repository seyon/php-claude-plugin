#!/usr/bin/env node
// One-time-per-project detection of where a Symfony application's logs
// actually live: heuristically scans config/packages/**/monolog.{yaml,yml,php}
// for handler path entries (resolving %kernel.logs_dir% to Symfony's
// conventional var/log), and falls back to the standard var/log/<env>.log
// convention for any environment with no explicit override found.
//
// This is deliberately a plain text/regex scan, not a real YAML/PHP parser
// -- Node has no built-in YAML support, and Symfony's PHP config format
// (config builder closures, e.g. `$monologConfig->handler('main')->path(...)`,
// or plain array config via `$containerConfigurator->extension('monolog', [...])`)
// can be arbitrary PHP, so a real parse isn't feasible here either. Both
// YAML's `path: ...` and PHP's `'path' => '...'` / `->path('...')` shapes
// are covered by extractPaths() below. See SKILL.md: results should be
// sanity-checked once per project, then are persisted and never
// re-derived automatically.
//
// Usage:
//   node detect-log-config.js --project-root <dir>
//
// Prints (to stdout):
//   { "environments": [{ "env": "prod", "paths": ["var/log/prod.log"], "format": "line", "source": "..." }] }
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

const MONOLOG_FILENAMES = ['monolog.yaml', 'monolog.yml', 'monolog.php'];

function findMonologFiles(projectRoot) {
  const candidates = [];
  const packagesDir = path.join(projectRoot, 'config', 'packages');
  if (!fs.existsSync(packagesDir)) return candidates;

  for (const name of MONOLOG_FILENAMES) {
    const baseFile = path.join(packagesDir, name);
    if (fs.existsSync(baseFile)) candidates.push(baseFile);
  }

  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of MONOLOG_FILENAMES) {
      const envFile = path.join(packagesDir, entry.name, name);
      if (fs.existsSync(envFile)) candidates.push(envFile);
    }
  }
  return candidates;
}

// Heuristic: pull every handler "path" value out of the config text,
// regardless of nesting/handler structure, covering both config shapes
// Symfony supports:
//   - YAML:            path: '...'
//   - PHP array config: 'path' => '...'
//   - PHP config-builder: ->path('...')
// Good enough for the common stream/rotating_file handler shapes;
// deliberately not a full parser.
function extractPaths(text) {
  const paths = [];
  const patterns = [
    /\bpath:\s*['"]?([^'"\n#]+?)['"]?\s*(?:#.*)?$/gm,      // YAML
    /['"]path['"]\s*=>\s*['"]([^'"]+)['"]/g,                 // PHP array
    /->path\(\s*['"]([^'"]+)['"]\s*\)/g,                     // PHP config builder
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text))) {
      paths.push(match[1].trim());
    }
  }
  return paths;
}

function detectFormat(yamlText) {
  return /formatter/i.test(yamlText) && /json/i.test(yamlText) ? 'json' : 'line';
}

function resolveSymfonyPath(rawPath, env) {
  return rawPath
    .replace('%kernel.logs_dir%', 'var/log')
    // %kernel.environment% is only resolvable when we know which
    // environment this config applies to -- true for anything found under
    // config/packages/<env>/monolog.yaml, not for the shared
    // config/packages/monolog.yaml ("default"), where it's left as-is.
    .replace('%kernel.environment%', env === 'default' ? '%kernel.environment%' : env);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = args['project-root'];
  if (!projectRoot) {
    process.stderr.write('Usage: detect-log-config.js --project-root <dir>\n');
    process.exit(1);
  }

  const files = findMonologFiles(projectRoot);
  const environments = {};

  for (const file of files) {
    const parentDir = path.basename(path.dirname(file));
    const env = parentDir === 'packages' ? 'default' : parentDir;
    const text = fs.readFileSync(file, 'utf8');
    const rawPaths = extractPaths(text);
    if (!rawPaths.length) continue;

    environments[env] = {
      env,
      paths: [...new Set(rawPaths.map((p) => resolveSymfonyPath(p, env)))],
      format: detectFormat(text),
      source: path.relative(projectRoot, file),
    };
  }

  // Fall back to Symfony's conventional default for any standard
  // environment that wasn't explicitly configured, unless a "default"
  // (config/packages/monolog.yaml, applies to all environments) entry
  // already covers it.
  for (const env of ['dev', 'prod', 'test']) {
    if (environments[env] || environments.default) continue;
    environments[env] = {
      env,
      paths: [`var/log/${env}.log`],
      format: 'line',
      source: 'symfony-default (no explicit monolog.yaml path found)',
    };
  }

  process.stdout.write(JSON.stringify({ environments: Object.values(environments) }, null, 2) + '\n');
}

main();
