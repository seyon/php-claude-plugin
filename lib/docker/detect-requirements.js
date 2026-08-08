#!/usr/bin/env node
// Detects the PHP version and required extensions for a *specific* PHP
// project directory (its composer.json / composer.lock), so every skill's
// Docker image is built with exactly what that project needs.
//
// --project-root must be the directory that actually contains the
// project's own composer.json (e.g. a monorepo sub-package directory such
// as packages/api, not necessarily the repository/monorepo root) -- see
// SKILL.md's monorepo notes for how mount-root and project-root differ.
//
// Usage:
//   node detect-requirements.js --project-root <dir>
//
// Prints (to stdout):
//   PHP_VERSION=8.5
//   PHP_EXTENSIONS=bcmath,gd,intl
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

function collectExtensions(requireObj, set) {
  for (const key of Object.keys(requireObj || {})) {
    if (key.startsWith('ext-')) set.add(key.slice(4).toLowerCase());
  }
}

function detectPhpVersion(composerJson) {
  const constraint = (composerJson.config && composerJson.config.platform && composerJson.config.platform.php)
    || (composerJson.require && composerJson.require.php);
  if (!constraint) return '8.5';
  const match = String(constraint).match(/(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : '8.5';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = args['project-root'];
  if (!projectRoot) {
    process.stderr.write('Usage: detect-requirements.js --project-root <dir>\n');
    process.exit(1);
  }

  const composerJsonPath = path.join(projectRoot, 'composer.json');
  const composerLockPath = path.join(projectRoot, 'composer.lock');

  const extensions = new Set();
  let phpVersion = '8.5';

  if (fs.existsSync(composerJsonPath)) {
    const composerJson = JSON.parse(fs.readFileSync(composerJsonPath, 'utf8'));
    collectExtensions(composerJson.require, extensions);
    collectExtensions(composerJson['require-dev'], extensions);
    phpVersion = detectPhpVersion(composerJson);
  }

  // composer.lock carries the *resolved* dependency tree, including
  // transitive ext-* requirements from packages like phpstan/phpstan or
  // qossmic/deptrac themselves (and any of their extensions/bridges) that
  // never appear directly in the project's own composer.json.
  if (fs.existsSync(composerLockPath)) {
    const lock = JSON.parse(fs.readFileSync(composerLockPath, 'utf8'));
    for (const pkg of [...(lock.packages || []), ...(lock['packages-dev'] || [])]) {
      collectExtensions(pkg.require, extensions);
    }
  }

  const sorted = [...extensions].sort();
  process.stdout.write(`PHP_VERSION=${phpVersion}\n`);
  process.stdout.write(`PHP_EXTENSIONS=${sorted.join(',')}\n`);
}

main();
