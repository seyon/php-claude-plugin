---
name: phpstan
description: Run PHPStan static analysis in an isolated Docker container and auto-fix findings via cheap Haiku subagents driven by per-error-identifier fix workflows, escalating to a stronger model only when needed. Use when the user asks to run PHPStan, fix PHPStan errors, raise the analysis level, or set up/configure the project's PHPStan tooling.
---

# PHPStan Advisor

This skill does not just run PHPStan — it is an **advisor loop**: run → group findings by error identifier → dispatch each group to a Haiku-driven fix workflow (escalating to a stronger model only for items Haiku can't confidently fix) → generate a new fix workflow the first time an identifier is seen → report results. The goal is that after an identifier has been encountered once, all later fixes for it are handled by the cheap model directly, because the fix recipe is already baked into that identifier's workflow script.

Skill files:
- `../../lib/docker/` — **shared across every skill in this plugin**: generic Dockerfile + `detect-requirements.js` (reads a project's composer.json/composer.lock to determine required PHP version + extensions) + `build-or-reuse.sh` (builds a standalone, project-tailored image only if a matching one doesn't already exist locally — see its header comment for the caching contract)
- `docker/run.sh` — fixed-parameter PHPStan execution; wraps the shared lib to resolve/build the image, then runs `vendor/bin/phpstan` inside it
- `scripts/parse-results.js`, `scripts/slugify.js` — group the JSON report by error identifier
- `scripts/workflows/<slug>.js` — pre-authored, plugin-shipped fix workflows for common PHPStan error identifiers (missingType.iterableValue, missingType.parameter, missingType.return, missingType.property, argument.type, return.type, property.notFound, method.notFound, class.notFound, variable.undefined, assign.propertyType, deadCode.unreachable) — used directly, for every project, without any per-project generation step
- `templates/workflow-template.js` — shape every *newly generated* (project-specific) fix workflow must follow

## Step 1 — Load or bootstrap project settings

**Resolve the project root first** (matters for monorepos): the directory containing the *specific* PHP project's own `composer.json` that you're analysing — not necessarily the repository root. `mount_root`/`project_subdir` (see below) don't need to be worked out by hand — `docker/run.sh` auto-detects them by scanning that `composer.json` for autoload paths (`autoload`/`autoload-dev`, `psr-4`/`psr-0`/`classmap`/`files`) that point outside the project directory. This is the pattern behind e.g. custom PHPStan rules kept in a separate monorepo folder and wired in purely through Composer autoloading (not a `phpstan.neon` path setting) — without widening the mount, those classes simply wouldn't be reachable inside the container. Detection is capped at 4 directory levels above the project root as a safety limit (a public/generic checkout should never silently end up mounting a big, unrelated chunk of the filesystem); past that it warns on stderr and falls back to mounting only the project root. It's a no-op for the common case (no such external autoload paths) and fully optional — pass `--mount-root`/`--project-subdir` explicitly, or record them in settings, to override it either way.

Look for a `## PHPStan Skill` section in `<project_root>/CLAUDE.md`, then `<project_root>/CLAUDE.local.md` (co-located with that specific project — a monorepo with several PHP packages ends up with one such section per package, each in its own package directory).

**If found**, parse these fields from it and use them as-is (never re-derive or re-ask):

```
- phpstan_binary: <path inside the container, e.g. /app/vendor/bin/phpstan, or
                   /app/<project_subdir>/vendor/bin/phpstan for a monorepo package>
- config_file: <path relative to project_root, e.g. phpstan.neon.dist>
- error_format: json          (fixed — never change)
- result_cache_path: <e.g. .phpstan-result-cache.php>
- mount_root: <absolute host path to bind-mount; equals project_root unless this
               is a monorepo package with path repositories, see above>
- project_subdir: <project_root's path relative to mount_root; "." unless monorepo>
```

There is deliberately no `docker_image_tag` setting — the image tag is derived automatically every run from the project's *current* composer.json/composer.lock (see Step 2), so it can never go stale if requirements change.

plus the `### Recipe Registry` table underneath it (identifier → workflow script path).

**If not found**, bootstrap it:
1. Locate the phpstan config file (`phpstan.neon`, `phpstan.neon.dist`, or `phpstan.dist.neon`) in `project_root`.
2. Confirm `vendor/bin/phpstan` exists (PHPStan must already be a project dependency — this skill runs the project's own binary, it does not install PHPStan itself).
3. Set `result_cache_path: .phpstan-result-cache.php`, and `mount_root`/`project_subdir` per the monorepo check above.
4. Check the config file for `parameters.resultCache.cacheFilePath`. If it's missing, add it pointing at `result_cache_path` — result caching must always be on, since the container filesystem is ephemeral and only the bind-mounted project directory persists across runs.
5. Write a `## PHPStan Skill` section with these settings (and an empty `### Recipe Registry` table) to `CLAUDE.local.md`, creating the file if it doesn't exist. Settings always land in whichever file already had the section; only create a *new* file (`CLAUDE.local.md`) when neither exists.

## Step 2 — Run PHPStan

Invoke `docker/run.sh` with the settings from Step 1:

```
skills/phpstan/docker/run.sh \
  --project-root <project_root, absolute> \
  --binary <phpstan_binary> \
  --config <config_file> \
  --output <tmp report path> \
  [--mount-root <mount_root, absolute>] \
  [--project-subdir <project_subdir>]
```

`run.sh` auto-detects the PHP version and required extensions from `--project-root`'s own composer.json/composer.lock (default PHP **8.5** if the project doesn't pin one), and resolves/builds the shared Docker image via `lib/docker/build-or-reuse.sh` — the build itself only happens once per project per unique requirement set, every later run (for this project, or any other with an identical requirement set) reuses the cached image. Omit `--mount-root`/`--project-subdir` entirely for a non-monorepo project (they default to `--project-root` and `.`).

This always runs with `--error-format=json` and reuses the on-disk result cache — never bypass these by calling `vendor/bin/phpstan` directly or adding ad-hoc flags; the fixed parameters are what make the JSON parsing and grouping in Step 3 reliable.

## Step 3 — Group findings

```
node skills/phpstan/scripts/parse-results.js --report <tmp report path> --registry <the CLAUDE.md/CLAUDE.local.md that holds the section>
```

This returns `{ groups: [{ identifier, slug, count, items, workflowPath, workflowSource, known }] }`, one group per PHPStan error identifier, sorted by count descending.

- `workflowSource: "plugin"` — a hand-authored workflow shipped with this skill (`scripts/workflows/<slug>.js`) already covers this identifier. Always preferred when present.
- `workflowSource: "project"` — no plugin workflow exists for this identifier, but one was generated for this project previously and is listed in its Recipe Registry.
- `workflowSource: null` (`known: false`) — neither exists; a new workflow must be generated first (Step 4b).

If there are zero groups, PHPStan is clean — report that and stop.

## Step 4 — Dispatch each group

For every group, in order (largest count first):

**4a. `known: true`** — run its existing workflow directly, regardless of source:
```
Workflow({ scriptPath: group.workflowPath, args: group.items })
```

**4b. `known: false`** — generate the recipe, then run it immediately:
1. Spawn one subagent (`Agent` tool, default/Sonnet-tier model, *not* Haiku — this is the one place a stronger model is required, since it's authoring the fix knowledge itself) with:
   - 2–3 sample items from `group.items` (file, line, message)
   - The exact error identifier
   - The contents of `templates/workflow-template.js` as the required shape
   - Instruction: research the PHPStan semantics for this identifier (from the message text and identifier name — consult https://phpstan.org/error-identifiers if useful context is needed) and write a complete, working workflow script to `group.workflowPath` (project-local, under `.claude/workflows/`), with a precise `FIX_PROMPT` fix recipe filled in. The two-stage Haiku→escalate pipeline structure must be preserved exactly.
2. Append a row to the `### Recipe Registry` table in the settings file: `| <identifier> | <workflowPath> | <one-line note> |`.
3. Run the newly created workflow the same way as 4a — the first occurrence gets fixed immediately, not deferred to a later run.

New identifiers this common across many projects are good candidates to eventually promote into `skills/phpstan/scripts/workflows/` (shipped with the plugin) instead of staying project-local — mention this to the user when a project-generated recipe looks broadly reusable, but don't do it automatically.

Groups can be dispatched to their workflows concurrently once each one's workflow is known/created; there's no need to serialize unrelated identifiers.

## Step 5 — Summarize

Report to the user:
- Total findings fixed by Haiku vs. escalated to the default model (aggregate `status` across all workflow results)
- Any new recipes generated this run (identifier + workflow path)
- Any items still `needs_escalation` after the default-model pass (surface these explicitly — do not silently drop them)
- A reminder to re-run this skill to confirm PHPStan is now clean, since fixes are not re-verified automatically within the same run

## Notes

- Never let a subagent invent its own phpstan call parameters — `error_format`, the config path, and result caching are fixed by this skill's settings, not chosen per-run.
- Fix workflows are project assets meant to accumulate over time (checked into the registry), not regenerated each run — always check `known` before spawning a recipe-author agent.
- If Docker isn't available in the environment, stop and tell the user — this skill intentionally does not fall back to running PHPStan unsandboxed.
- The container never depends on the host machine's PHP install — only on what `lib/docker/detect-requirements.js` finds in the *target project's own* composer.json/composer.lock. If PHPStan fails inside the container complaining about a missing extension that genuinely isn't declared anywhere in composer.json/composer.lock (rare, e.g. a runtime-only dependency), pass it via `--extra-extensions` on `docker/run.sh` rather than editing `lib/docker/Dockerfile`.
