---
name: phpinsights
description: Run PHPInsights code quality analysis in an isolated Docker container and auto-fix findings via cheap Haiku subagents driven by per-insight fix workflows, escalating to a stronger model only when needed. Use when the user asks to run PHPInsights, fix code quality/complexity/style/architecture findings, or set up/configure the project's PHPInsights tooling.
---

# PHPInsights Advisor

Same advisor-loop shape as the `phpstan` skill: run → group findings by **insight class** → dispatch each group to a Haiku-driven fix workflow (escalating to a stronger model only for items Haiku can't confidently fix) → generate a new fix workflow the first time an insight is seen → report results. PHPInsights groups every finding (across its four categories — Code, Complexity, Architecture, Style) by the fully-qualified class of the underlying check (a PHP_CodeSniffer sniff, a PHPMD rule, or one of PHPInsights' own Insights classes) — that class name is, like PHPStan's error identifier, effectively universal across projects, so the same shipped-workflow approach applies directly (unlike Deptrac, whose violations are keyed by project-specific layer names).

Skill files:
- `../../lib/docker/` — shared across every skill in this plugin (see the `phpstan` skill for details): generic Dockerfile + PHP version/extension auto-detection + build-once-per-requirement-set caching
- `docker/run.sh` — fixed-parameter PHPInsights execution; wraps the shared lib to resolve/build the image, then runs `vendor/bin/phpinsights` inside it
- `scripts/parse-results.js`, `scripts/slugify.js` — group the JSON report by insight class
- `scripts/find-related-tests.js` — cheap, non-LLM check for whether a fixed class has existing unit test coverage (see Step 6)
- `scripts/workflows/<slug>.js` — pre-authored, plugin-shipped fix workflows for 10 common PHPInsights insights, covering all four categories:
  - **Style**: `UnusedUsesSniff`, `LineLengthSniff`, `TrailingArrayCommaSniff`, `DeclareStrictTypesSniff`
  - **Code**: `UnusedPrivateElementsSniff`, `UnusedParameterSniff`
  - **Complexity**: `CyclomaticComplexityIsHigh`, `CognitiveComplexitySniff`
  - **Architecture**: `ForbiddenDefineFunctions`, `ForbiddenGlobalFunctions`
- `templates/workflow-template.js` — shape every *newly generated* (project-specific) fix workflow must follow

## Step 1 — Load or bootstrap project settings

**Resolve the project root first** (matters for monorepos): the directory containing the *specific* PHP project's own `composer.json` that you're analysing — not necessarily the repository root. `mount_root`/`project_subdir` (see below) don't need to be worked out by hand — `docker/run.sh` auto-detects them by scanning that `composer.json` for autoload paths pointing outside the project directory. Detection is capped at 4 directory levels above the project root as a safety limit; past that it warns on stderr and falls back to mounting only the project root. It's a no-op for the common case and fully optional — pass `--mount-root`/`--project-subdir` explicitly, or record them in settings, to override it either way.

Look for a `## PHPInsights Skill` section in `<project_root>/CLAUDE.md`, then `<project_root>/CLAUDE.local.md`.

**If found**, parse these fields and use them as-is (never re-derive or re-ask):

```
- phpinsights_binary: <path inside the container, e.g. /app/vendor/bin/phpinsights>
- config_file: <path relative to project_root, e.g. phpinsights.php>
- format: json          (fixed — never change)
- mount_root: <absolute host path to bind-mount; equals project_root unless this
               is a monorepo package with path repositories, see above>
- project_subdir: <project_root's path relative to mount_root; "." unless monorepo>
- extra_mounts: <optional; comma-separated HOST:CONTAINER[:ro] bind mounts, passed
                 through as repeated --extra-mount flags — for folders the single
                 mount_root mount can't cover. Omit when not needed.>
```

There is deliberately no `docker_image_tag` setting — the image tag is derived automatically every run from the project's *current* composer.json/composer.lock (see Step 2), so it can never go stale if requirements change.

plus the `### Recipe Registry` table underneath it (insight class → workflow script path).

**If not found**, bootstrap it:
1. Locate the PHPInsights config file (`phpinsights.php`, the default name) in `project_root`; if none exists, note that PHPInsights will run with its built-in defaults.
2. Confirm `vendor/bin/phpinsights` exists (this skill runs the project's own binary, it does not install PHPInsights itself).
3. Set `mount_root`/`project_subdir` per the monorepo check above.
4. Write a `## PHPInsights Skill` section with these settings (and an empty `### Recipe Registry` table) to `CLAUDE.local.md`, creating the file if it doesn't exist. Settings land in whichever file already had the section; only create `CLAUDE.local.md` when neither exists.

## Step 2 — Run PHPInsights

```
skills/phpinsights/docker/run.sh \
  --project-root <project_root, absolute> \
  --binary <phpinsights_binary> \
  --config <config_file> \
  --output <tmp report path> \
  [--mount-root <mount_root, absolute>] \
  [--project-subdir <project_subdir>] \
  [--extra-mount <HOST:CONTAINER[:ro]>]...   # one flag per extra_mounts entry
```

`run.sh` auto-detects the PHP version and required extensions from `--project-root`'s own composer.json/composer.lock (default PHP **8.5** if the project doesn't pin one), and resolves/builds the shared Docker image via `lib/docker/build-or-reuse.sh` — the build itself only happens once per project per unique requirement set. Omit `--mount-root`/`--project-subdir` for a non-monorepo project.

This always runs with `--format=json`; never bypass this with ad-hoc flags — the fixed format is what makes Step 3 reliable.

## Step 3 — Group findings by insight class

```
node skills/phpinsights/scripts/parse-results.js --report <tmp report path> --registry <the CLAUDE.md/CLAUDE.local.md that holds the section>
```

Returns `{ groups: [{ insightClass, slug, category, count, itemsFile, sampleItems, workflowPath, workflowSource, known }] }`, one group per insight class, sorted by count descending.

**Context hygiene — this is how the skill stays cheap on context.** The full item list of each group is NOT in this output: it's written to the file at `itemsFile`, and only `sampleItems` (first 3, for Step 4b) is inline. Never `cat`/Read the raw report, an `itemsFile`, or a Docker build log into the conversation, and dispatch by passing the `itemsFile` **path** (see Step 4), never by inlining items into the `Workflow` call.

- `workflowSource: "plugin"` — a hand-authored workflow shipped with this skill (`scripts/workflows/<slug>.js`) already covers this insight. Always preferred when present.
- `workflowSource: "project"` — no plugin workflow exists for this insight, but one was generated for this project previously and is listed in its Recipe Registry.
- `workflowSource: null` (`known: false`) — neither exists; a new workflow must be generated first (Step 4b).

If there are zero groups, PHPInsights found nothing to fix — report that and stop.

## Step 4 — Dispatch each group

**Execution contract — non-negotiable.** These rules exist because the whole point of this skill is the workflow pipeline; a run that "fixes the findings" without it did not follow the skill:

1. The user invoking this skill IS the explicit opt-in for the `Workflow` tool. Never ask for permission to run a workflow, never skip dispatch because it seems heavyweight, and never treat the Workflow tool's general opt-in gate as a reason to hold back — the skill invocation satisfies it.
2. Every finding is fixed **only** through its group's workflow. Fixing findings directly in the main conversation (editing the affected PHP files yourself) is forbidden, no matter how trivial the fix looks — that bypasses the Haiku→escalate pipeline and the recipe accumulation this skill exists for.
3. `known: false` is **not** a reason to skip a group, defer it, or hand-fix it. It means: do 4b now — generate the workflow via subagent, register it, then run it via `Workflow` in the same run. Do not ask the user whether to create the workflow; creating recipes for unseen insights is exactly what they invoked the skill for.
4. A group may end the run undispatched only if its workflow generation or execution genuinely failed after an attempt — and then Step 6 must say so explicitly. Silently skipping a group is never an outcome.

For every group, in order (largest count first):

**4a. `known: true`** — run its existing workflow directly, regardless of source (a `workflowSource: "project"` recipe under `.claude/workflows/` is dispatched exactly like a plugin one — via the `Workflow` tool, not by reading the script and doing the fixes yourself):
```
Workflow({ scriptPath: group.workflowPath, args: { itemsFile: group.itemsFile } })
```
Pass the `itemsFile` path, not the items — the workflow loads the file itself, and each returns a compact summary (`{ total, fixed_by_haiku, fixed_after_escalation, fixedFiles, needs_escalation }`) rather than per-item logs.

**4b. `known: false`** — generate the recipe, then run it immediately:
1. Spawn one subagent (`Agent` tool, default/Sonnet-tier model, *not* Haiku) with:
   - The group's `sampleItems` (file, line, message — already limited to 3; don't load more from `itemsFile`)
   - The exact insight class string
   - The contents of `templates/workflow-template.js` as the required shape
   - Instruction: research what this check actually enforces (the class name is usually descriptive — it's a PHP_CodeSniffer sniff, Slevomat Coding Standard sniff, PHPMD rule, or PHPInsights' own Insights class; consult that underlying tool's docs if the name alone isn't enough) and write a complete, working workflow script to `group.workflowPath` (project-local, under `.claude/workflows/`), with a precise `FIX_PROMPT` fix recipe filled in. The two-stage Haiku→escalate pipeline structure must be preserved exactly.
2. Verify the subagent actually wrote the file at `group.workflowPath` (read it — it must parse as a workflow script with a filled-in `FIX_PROMPT`); if not, re-prompt the subagent once before giving up and reporting the failure in Step 6.
3. Append a row to the `### Recipe Registry` table in the settings file: `| <insightClass> | <workflowPath> | <one-line note> |`.
4. Run the newly created workflow the same way as 4a — via `Workflow({ scriptPath: group.workflowPath, args: { itemsFile: group.itemsFile } })`, in this same run. The first occurrence gets fixed immediately, not deferred to a later run, and not fixed by hand "since the workflow is new anyway".

New insights this common across many projects are good candidates to eventually promote into `skills/phpinsights/scripts/workflows/` (shipped with the plugin) instead of staying project-local — mention this to the user when a project-generated recipe looks broadly reusable, but don't do it automatically.

Groups can be dispatched to their workflows concurrently once each one's workflow is known/created; there's no need to serialize unrelated insights.

## Step 5 — Check and update affected unit tests

PHPInsights fixes — especially Complexity ones (`CyclomaticComplexityIsHigh`, `CognitiveComplexitySniff`), which often extract or split methods — can change a class's internal structure enough to break existing unit tests (mocked calls, method-level assertions, etc.), even when the externally observable behavior is preserved. Checking for this is cheap; only *acting* on it costs a model call, and only when there's actually something to look at:

1. Collect the union of `fixedFiles` across all workflow summaries from Step 4 (already deduplicated per workflow).
2. For each one, run the cheap, non-LLM check:
   ```
   node skills/phpinsights/scripts/find-related-tests.js --project-root <project_root> --file <relative path to the fixed file>
   ```
   This extracts the class name declared in the file and searches the project for any `*Test.php` file that references it by name — pure text search, no LLM involved.
3. If `testFiles` is empty for a file, there's nothing to do — skip it. This is the common case for most Style/Code fixes and keeps this step from costing anything when it doesn't apply.
4. If `testFiles` is non-empty, spawn one subagent (`Agent` tool, default/Sonnet-tier model, *not* Haiku — judging whether a refactor changed what a test needs to verify, and updating it without weakening coverage, requires real understanding) per fixed file, given:
   - The fixed file's current (post-fix) content
   - Each related test file's content
   - Instruction: check whether the fix changed the class's structure in a way the tests need to follow (e.g. a method was split and a mock/expectation now targets the wrong call, or a newly extracted method has no coverage of its own) and update the test file(s) accordingly. Preserve the original test's intent and coverage — never delete or weaken an assertion just to make a test pass; if a test exercised behavior that moved to a new method, adapt it to still verify the same behavior through the new structure. If nothing actually needs to change, say so and leave the test untouched.
5. Save any test file changes made.

## Step 6 — Summarize

Report to the user:
- **A per-group accounting table**: every group from Step 3 with its insight class, the workflow used (plugin / project / newly generated this run), and its outcome (n fixed by Haiku / n escalated / failed: reason). Every group must appear — this table is what makes a silently skipped group visible, so an unaccounted group means Step 4 wasn't finished.
- Total findings fixed by Haiku vs. escalated to the default model (aggregate `status` across all workflow results)
- Any new recipes generated this run (insight class + workflow path)
- Any items still `needs_escalation` after the default-model pass — surface these explicitly, especially Complexity findings, which often genuinely require human judgment to refactor safely
- Any unit test files updated in Step 5, and which fixed class each update was for
- A reminder to re-run this skill (and the project's test suite) to confirm PHPInsights is now clean and tests still pass

## Notes

- **Project files are never modified by this skill's tooling steps** (config files, composer.json, etc.) — the only files this skill writes are the settings/registry section in `CLAUDE.md`/`CLAUDE.local.md`, generated workflows under `.claude/workflows/`, and the actual code/test fixes the dispatched steps make.
- **Context hygiene**: findings travel by file path, never by value. Don't read the raw report, items files, or build logs into the conversation; don't inline items into `Workflow` calls; don't echo per-item results — the parse summary and the workflows' compact summaries are the only finding data that belongs in the main context.
- Never let a subagent invent its own phpinsights call parameters — `format`, the config path, are fixed by this skill's settings, not chosen per-run.
- PHPInsights' exact JSON field names have not been verified against a live run in building this skill — `scripts/parse-results.js` tries a couple of plausible field-name variants defensively (see its header comment). Verify once against a real `vendor/bin/phpinsights analyse --format=json` run for the target project and adjust the field lookups if they don't match.
- Fix workflows are project assets meant to accumulate over time (checked into the registry), not regenerated each run — always check `known` before spawning a recipe-author agent.
- If Docker isn't available in the environment, stop and tell the user — this skill intentionally does not fall back to running PHPInsights unsandboxed.
- The container never depends on the host machine's PHP install — only on what `lib/docker/detect-requirements.js` finds in the *target project's own* composer.json/composer.lock. If PHPInsights fails inside the container complaining about a missing extension not declared anywhere in composer.json/composer.lock, pass it via `--extra-extensions` on `docker/run.sh` rather than editing `lib/docker/Dockerfile`.
