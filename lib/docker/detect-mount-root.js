#!/usr/bin/env node
// Detects whether a project's composer.json references autoload paths
// OUTSIDE its own directory -- a pattern seen in some monorepos, e.g.
// shared custom PHPStan rules kept in a sibling folder and wired in via a
// relative psr-4/classmap/files autoload entry (so they're registered
// through the project's own autoloader, not through phpstan.neon
// directly). If we only ever bind-mounted --project-root, those classes
// would be unreachable inside the container and autoloading would fail.
//
// This is entirely optional and a no-op for the common case: if
// composer.json has no such external paths, it prints MOUNT_ROOT ==
// --project-root and PROJECT_SUBDIR=. -- i.e. no behavior change. It only
// ever *widens* the mount, and refuses to widen further than
// MAX_ANCESTOR_HOPS directory levels above the project root as a safety
// cap -- a public/default checkout should never end up silently
// bind-mounting a broad, unexpected part of the filesystem. Past that cap
// it warns on stderr and leaves the decision to an explicit
// --mount-root/--project-subdir (or the project's own recorded
// mount_root/project_subdir settings, see SKILL.md).
//
// Usage:
//   node detect-mount-root.js --project-root <dir>
//
// Prints (to stdout):
//   MOUNT_ROOT=<absolute path>
//   PROJECT_SUBDIR=<project-root's path relative to MOUNT_ROOT, or ".">
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_ANCESTOR_HOPS = 4;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

function collectAutoloadPaths(autoload) {
  const paths = [];
  if (!autoload) return paths;
  for (const key of ['psr-4', 'psr-0']) {
    const map = autoload[key];
    if (!map) continue;
    for (const value of Object.values(map)) {
      (Array.isArray(value) ? value : [value]).forEach((p) => paths.push(p));
    }
  }
  for (const key of ['classmap', 'files', 'exclude-from-classmap']) {
    (autoload[key] || []).forEach((p) => paths.push(p));
  }
  return paths;
}

// Longest common leading path shared by every given absolute path.
function commonAncestor(absPaths) {
  const segmentLists = absPaths.map((p) => p.split(path.sep).filter(Boolean));
  const shortest = Math.min(...segmentLists.map((s) => s.length));
  const common = [];
  for (let i = 0; i < shortest; i++) {
    const segment = segmentLists[0][i];
    if (segmentLists.every((s) => s[i] === segment)) {
      common.push(segment);
    } else {
      break;
    }
  }
  return common.length ? path.sep + path.join(...common) : path.sep;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRootArg = args['project-root'];
  if (!projectRootArg) {
    process.stderr.write('Usage: detect-mount-root.js --project-root <dir>\n');
    process.exit(1);
  }
  const projectRoot = path.resolve(projectRootArg);

  const composerJsonPath = path.join(projectRoot, 'composer.json');
  const externalPaths = [];

  if (fs.existsSync(composerJsonPath)) {
    const composerJson = JSON.parse(fs.readFileSync(composerJsonPath, 'utf8'));
    const rawPaths = [
      ...collectAutoloadPaths(composerJson.autoload),
      ...collectAutoloadPaths(composerJson['autoload-dev']),
    ];
    for (const rawPath of rawPaths) {
      const resolved = path.resolve(projectRoot, rawPath);
      const relative = path.relative(projectRoot, resolved);
      if (relative.startsWith('..')) {
        externalPaths.push(resolved);
      }
    }
  }

  if (externalPaths.length === 0) {
    process.stdout.write(`MOUNT_ROOT=${projectRoot}\n`);
    process.stdout.write('PROJECT_SUBDIR=.\n');
    return;
  }

  const ancestor = commonAncestor([projectRoot, ...externalPaths]);
  const hops = path.relative(ancestor, projectRoot).split(path.sep).filter(Boolean).length;

  if (ancestor === path.sep || hops > MAX_ANCESTOR_HOPS) {
    process.stderr.write(
      `detect-mount-root: composer.json references autoload path(s) outside the project root ` +
      `(${externalPaths.join(', ')}), but the common ancestor (${ancestor}) is ${hops} levels up ` +
      `-- too broad to mount automatically (cap: ${MAX_ANCESTOR_HOPS}). Falling back to mounting ` +
      `only the project root; those classes won't autoload inside the container. Set mount_root ` +
      `and project_subdir explicitly in this project's Skill settings (see SKILL.md) to fix this.\n`
    );
    process.stdout.write(`MOUNT_ROOT=${projectRoot}\n`);
    process.stdout.write('PROJECT_SUBDIR=.\n');
    return;
  }

  const projectSubdir = path.relative(ancestor, projectRoot) || '.';
  process.stdout.write(`MOUNT_ROOT=${ancestor}\n`);
  process.stdout.write(`PROJECT_SUBDIR=${projectSubdir}\n`);
}

main();
