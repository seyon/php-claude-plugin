---
name: symfony-log
description: Investigate a problem or question about a Symfony project using its own application logs. Uses Haiku to bulk-cluster and summarize ERROR/WARNING log entries so the expensive model only ever reads a compact findings list, never raw log noise. Use when the user reports a bug/incident, asks "why is X failing", "what's in the logs", or wants an error investigated via the project's logs.
---

# Symfony Log Investigator

Invoke this skill with the **problem or question to investigate** as its argument (e.g. "why is checkout throwing 500 errors since this morning", "what's causing the deprecation noise in prod"). Log volume is usually far too large to hand an expensive model directly, so the heavy lifting — reading raw log entries and clustering/summarizing them — is delegated to Haiku; you (the invoking assistant) then answer the actual question directly using that compact summary, not the raw logs.

Skill files:
- `scripts/detect-log-config.js` — one-time-per-project: reads the project's Monolog config to find where its logs actually live
- `scripts/parse-logs.js` — cheap, non-LLM extraction of ERROR/WARNING/etc. entries from a log file
- `scripts/cluster-log-entries.js` — Workflow-tool script: Haiku-driven clustering/summarizing of raw entries into a compact findings list

No Docker is involved here — this skill only reads log files off disk, it never executes project code.

## Step 1 — Load or bootstrap log location settings

Look for a `## Symfony Log Skill` section in the target project's `./CLAUDE.md`, then `./CLAUDE.local.md`.

**If found**, use its `### Log Locations` table as-is (never re-derive or re-ask). This detection is meant to happen once per project and be reused indefinitely — not on every invocation — until the project's Monolog config actually changes. If a run turns up a recorded log path that clearly no longer exists or is empty when it shouldn't be, re-run the bootstrap below and update the table rather than silently working around it.

**If not found**, bootstrap it:
1. Run:
   ```
   node skills/symfony-log/scripts/detect-log-config.js --project-root <project_root>
   ```
   This heuristically scans `config/packages/**/monolog.yaml` for handler `path:` entries (resolving `%kernel.logs_dir%` to Symfony's conventional `var/log`) and falls back to the standard `var/log/<env>.log` convention for any environment it found no explicit override for. This is a best-effort text scan, not a real YAML parser — if a project's Monolog config is unusually structured (paths built up via parameters, handlers wrapped several levels deep in `fingers_crossed`/`buffer`/`group`), sanity-check the detected paths (the files should exist and actually be growing) before trusting them, and correct the table by hand if not.
2. Write a `## Symfony Log Skill` section with a `### Log Locations` table to `CLAUDE.local.md`, creating the file if it doesn't exist:
   ```
   ### Log Locations
   | Environment | Path | Format | Source |
   |---|---|---|---|
   | prod | var/log/prod.log | line | config/packages/prod/monolog.yaml |
   | dev | var/log/dev.log | line | symfony-default |
   ```
   Settings land in whichever file already had the section; only create `CLAUDE.local.md` when neither exists.

## Step 2 — Determine scope from the given problem/question

From the problem/question you were invoked with (and by asking the user only if genuinely ambiguous):
- Default to the `dev` row from the Log Locations table. This skill is a local-development aid — it's not meant to be pointed at a live/production log, so don't reach for `prod` unless the user explicitly names an environment other than `dev` (e.g. they're debugging a `prod`/`staging` log they've pulled locally).
- Note anything that helps focus the search: a rough timeframe ("since this morning", "in the last hour"), a channel/component name, an exception type, or a specific endpoint/feature mentioned in the question — you'll use this in Steps 4–5, not to filter Step 3's raw extraction (that stays broad on purpose, since Haiku's clustering step is what does the relevance judgment cheaply).

## Step 3 — Extract raw entries (cheap, no LLM)

```
node skills/symfony-log/scripts/parse-logs.js \
  --log-file <resolved path from Step 1, relative to project_root> \
  --format <format from Step 1> \
  --levels error,critical,alert,emergency,warning \
  --limit 500
```

Reads at most the last few MB of the log file and returns parsed, level-filtered entries as JSON — no model involved yet. If the file doesn't exist or nothing matches, say so plainly and stop rather than guessing at an answer. If the question implies a longer lookback than the default tail window likely covers (e.g. "since last week" on a busy prod log), raise `--max-bytes` accordingly rather than silently answering from a truncated sample.

## Step 4 — Cluster and summarize via Haiku

```
Workflow({
  scriptPath: 'skills/symfony-log/scripts/cluster-log-entries.js',
  args: { entries: <entries array from Step 3>, question: <the problem/question this skill was invoked with> }
})
```

This batches the raw entries and has Haiku group them into clusters of the same underlying issue (deduping near-identical messages that only differ by IDs/timestamps), each with a level, one-line summary, a representative verbatim message, an occurrence count, first/last-seen timestamps, and a relevance flag against the given question. This is the expensive-token step made cheap: instead of an expensive model reading hundreds of raw log lines, it reads a short, structured cluster list.

## Step 5 — Answer the question

Using the cluster list from Step 4 (not the raw entries), answer the problem/question you were given directly:
- Lead with clusters flagged `relevantToQuestion: true`, ordered by how directly they explain the reported problem, not just by occurrence count.
- Cite concrete evidence: representative message, occurrence count, first/last seen.
- If nothing in the logs looks related to the question, say so explicitly rather than forcing an answer from unrelated clusters — that's itself a useful finding (e.g. "no matching error in `dev` — try reproducing it first, or check whether the failure isn't surfacing to the logs at all").
- If Step 3's window might not cover the relevant timeframe, say so and offer to re-run it with a larger `--max-bytes`/`--limit` rather than silently answering from a possibly-incomplete sample.

## Notes

- Never trust `detect-log-config.js`'s output blind the first time — it's a heuristic text scan of YAML, not a real parser, precisely so this skill has no dependency on a YAML library.
- Don't re-run Step 1's bootstrap on every invocation — it's meant to happen once per project, like the other skills in this plugin.
- This skill only reads log files; it never modifies application code or config, and has no reason to.
