#!/usr/bin/env node
// Cheap, non-LLM extraction of level-filtered entries from a Symfony
// (Monolog) log file. Reads at most the last --max-bytes of the file (so
// this stays fast/bounded even against a large production log), parses
// either Monolog's default line format or its JSON formatter output, and
// returns structured entries -- no model involved at this stage.
//
// Usage:
//   node parse-logs.js --log-file <path> [--format line|json]
//                       [--levels error,critical,alert,emergency,warning]
//                       [--max-bytes 5242880] [--limit 500]
'use strict';

const fs = require('fs');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

function readTail(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, start);
  fs.closeSync(fd);
  return buffer.toString('utf8');
}

// Monolog's default LineFormatter: "[<datetime>] <channel>.<LEVEL>: <message> <context> <extra>"
// Exception stack traces and multi-line context spill onto following
// lines that don't start with "[" -- fold those into the previous entry
// (capped) rather than dropping or misparsing them as new entries.
function parseLineFormat(text) {
  const lines = text.split('\n');
  const headerRe = /^\[([^\]]+)\]\s+(\S+)\.(\w+):\s+(.*)$/;
  const entries = [];
  for (const line of lines) {
    const match = line.match(headerRe);
    if (match) {
      const [, timestamp, channel, level, message] = match;
      entries.push({ timestamp, channel, level: level.toUpperCase(), message, continuation: [] });
    } else if (entries.length && line.trim() && entries[entries.length - 1].continuation.length < 20) {
      entries[entries.length - 1].continuation.push(line);
    }
  }
  return entries.map((e) => ({
    timestamp: e.timestamp,
    channel: e.channel,
    level: e.level,
    message: e.continuation.length ? `${e.message}\n${e.continuation.join('\n')}` : e.message,
  }));
}

function parseJsonFormat(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      entries.push({
        timestamp: obj.datetime || obj.timestamp || null,
        channel: obj.channel || 'app',
        level: String(obj.level_name || obj.level || '').toUpperCase(),
        message: obj.message,
        context: obj.context,
      });
    } catch {
      // malformed/partial line (e.g. truncated at the tail boundary) -- skip
    }
  }
  return entries;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const logFile = args['log-file'];
  const format = args['format'] || 'line';
  const levels = (args['levels'] || 'error,critical,alert,emergency,warning')
    .split(',').map((l) => l.trim().toUpperCase()).filter(Boolean);
  const maxBytes = Number(args['max-bytes'] || 5 * 1024 * 1024);
  const limit = Number(args['limit'] || 500);

  if (!logFile) {
    process.stderr.write('Usage: parse-logs.js --log-file <path> [--format line|json] [--levels ...] [--max-bytes N] [--limit N]\n');
    process.exit(1);
  }

  if (!fs.existsSync(logFile)) {
    process.stdout.write(JSON.stringify({ error: `log file not found: ${logFile}`, totalParsed: 0, matched: 0, entries: [] }, null, 2) + '\n');
    return;
  }

  const text = readTail(logFile, maxBytes);
  const allEntries = format === 'json' ? parseJsonFormat(text) : parseLineFormat(text);
  const filtered = allEntries.filter((e) => levels.includes(e.level));
  const limited = filtered.slice(-limit);

  process.stdout.write(JSON.stringify({ totalParsed: allEntries.length, matched: filtered.length, entries: limited }, null, 2) + '\n');
}

main();
