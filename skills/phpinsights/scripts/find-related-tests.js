#!/usr/bin/env node
// Cheap, non-LLM check: does a *.Test.php (or Test*.php) file anywhere in
// the project reference the class declared in a given, just-fixed PHP
// file? Used to decide whether a Sonnet-tier agent needs to review/update
// unit tests after a PHPInsights fix (see SKILL.md step 6) -- most
// relevant after Complexity fixes, which often extract/split methods and
// can invalidate existing mocks/expectations. This script only answers
// "are there tests to look at", never edits or judges anything itself.
//
// Usage:
//   node find-related-tests.js --project-root <dir> --file <path to the fixed .php file, relative or absolute>
//
// Prints (to stdout):
//   { "className": "Foo", "fqcn": "App\\Domain\\Foo", "testFiles": ["tests/Domain/FooTest.php", ...] }
'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['vendor', 'node_modules', '.git', 'var', 'cache', 'storage', 'build']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

function extractClass(fileContent) {
  const namespaceMatch = fileContent.match(/^\s*namespace\s+([^;]+);/m);
  const classMatch = fileContent.match(/\b(?:class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (!classMatch) return null;
  const className = classMatch[1];
  const namespace = namespaceMatch ? namespaceMatch[1].trim() : '';
  const fqcn = namespace ? `${namespace}\\${className}` : className;
  return { className, fqcn };
}

function walk(dir, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, onFile);
    } else if (entry.isFile() && /Test\.php$/.test(entry.name)) {
      onFile(fullPath);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = args['project-root'];
  const filePath = args['file'];
  if (!projectRoot || !filePath) {
    process.stderr.write('Usage: find-related-tests.js --project-root <dir> --file <path to fixed .php file>\n');
    process.exit(1);
  }

  const absFile = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  if (!fs.existsSync(absFile)) {
    process.stdout.write(JSON.stringify({ className: null, fqcn: null, testFiles: [] }, null, 2) + '\n');
    return;
  }

  const info = extractClass(fs.readFileSync(absFile, 'utf8'));
  if (!info) {
    process.stdout.write(JSON.stringify({ className: null, fqcn: null, testFiles: [] }, null, 2) + '\n');
    return;
  }

  const classNamePattern = new RegExp(`\\b${info.className}\\b`);
  const testFiles = [];
  walk(projectRoot, (testFilePath) => {
    if (path.resolve(testFilePath) === path.resolve(absFile)) return;
    let content;
    try {
      content = fs.readFileSync(testFilePath, 'utf8');
    } catch {
      return;
    }
    if (classNamePattern.test(content)) {
      testFiles.push(path.relative(projectRoot, testFilePath));
    }
  });

  process.stdout.write(JSON.stringify({ className: info.className, fqcn: info.fqcn, testFiles }, null, 2) + '\n');
}

main();
