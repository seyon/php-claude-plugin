---
name: deptrac
description: Run Deptrac architecture analysis in an isolated Docker container and auto-fix layer violations via cheap Haiku subagents driven by fix-strategy workflows, escalating to a stronger model only when needed. Use when the user asks to run Deptrac, fix layer/architecture violations, or set up/configure the project's Deptrac tooling.
---

# Deptrac Advisor

Same advisor-loop idea as the `phpstan` skill, adapted for the fact that Deptrac violations are keyed by **project-specific layer pairs** (`Layer -> DependentLayer`, from the project's own `depfile.yaml`), not by a fixed, universal identifier catalog like PHPStan's. So instead of shipping ready-made fixes per identifier, this skill ships a small set of **generic, reusable fix strategies** (interface extraction, moving a class, extracting a shared abstraction, replacing a call with an event) and, once per project, decides *which* strategy applies to *which* layer pair — recording that decision plus the project's own conventions (where ports live, DI style, event bus, etc.) so Haiku gets a concrete, non-generic instruction instead of the raw violation.

Skill files:
- `../../lib/docker/` — **shared across every skill in this plugin**: generic Dockerfile + `detect-requirements.js` (reads a project's composer.json/composer.lock to determine required PHP version + extensions) + `build-or-reuse.sh` (builds a standalone, project-tailored image only if a matching one doesn't already exist locally — see its header comment for the caching contract)
- `docker/run.sh` — fixed-parameter Deptrac execution; wraps the shared lib to resolve/build the image, then runs `vendor/bin/deptrac` inside it
- `scripts/parse-results.js`, `scripts/slugify.js` — group the JSON report by layer pair, resolve known strategies
- `scripts/strategies/*.js` — 4 plugin-shipped, generic fix-strategy workflows (parameterized by runtime `context`, not project-specific by themselves): `dependency-inversion`, `move-to-correct-layer`, `extract-shared-abstraction`, `replace-with-event`
- `templates/custom-strategy-template.js` — shape for a bespoke, project-local workflow when no shipped strategy fits a layer pair

## Step 1 — Load or bootstrap project settings

**Resolve the project root first** (matters for monorepos): the directory containing the *specific* PHP project's own `composer.json` that you're analysing — not necessarily the repository root. `mount_root`/`project_subdir` (see below) don't need to be worked out by hand — `docker/run.sh` auto-detects them by scanning that `composer.json` for autoload paths pointing outside the project directory (e.g. a shared helper/rules folder wired in purely through Composer autoloading elsewhere in the monorepo). Detection is capped at 4 directory levels above the project root as a safety limit; past that it warns on stderr and falls back to mounting only the project root. It's a no-op for the common case and fully optional — pass `--mount-root`/`--project-subdir` explicitly, or record them in settings, to override it either way.

Look for a `## Deptrac Skill` section in `<project_root>/CLAUDE.md`, then `<project_root>/CLAUDE.local.md` (co-located with that specific project — a monorepo with several PHP packages ends up with one such section per package, each in its own package directory).

**If found**, parse these fields and use them as-is (never re-derive or re-ask):

```
- deptrac_binary: <path inside the container, e.g. /app/vendor/bin/deptrac, or
                   /app/<project_subdir>/vendor/bin/deptrac for a monorepo package>
- config_file: <path relative to project_root, e.g. depfile.yaml>
- formatter: json          (fixed — never change)
- mount_root: <absolute host path to bind-mount; equals project_root unless this
               is a monorepo package with path repositories, see above>
- project_subdir: <project_root's path relative to mount_root; "." unless monorepo>
```

There is deliberately no `docker_image_tag` setting — the image tag is derived automatically every run from the project's *current* composer.json/composer.lock (see Step 2), so it can never go stale if requirements change.

plus the `### Layer Map` table underneath it: `| Layer Pair | Strategy | Notes |`, where `Layer Pair` is `LayerA -> LayerB`, `Strategy` is one of the 4 plugin strategy slugs above or `custom`, and `Notes` holds the project-specific conventions text injected into that strategy's fix prompt at runtime.

**If not found**, bootstrap it:
1. Locate `depfile.yaml` in `project_root`.
2. Confirm `vendor/bin/deptrac` exists (this skill runs the project's own binary, it does not install Deptrac).
3. Set `mount_root`/`project_subdir` per the monorepo check above.
4. Write a `## Deptrac Skill` section with these settings (and an empty `### Layer Map` table) to `CLAUDE.local.md`, creating the file if it doesn't exist. Settings land in whichever file already had the section; only create `CLAUDE.local.md` when neither exists.

## Step 2 — Run Deptrac

```
skills/deptrac/docker/run.sh \
  --project-root <project_root, absolute> \
  --binary <deptrac_binary> \
  --config <config_file> \
  --output <tmp report path> \
  [--mount-root <mount_root, absolute>] \
  [--project-subdir <project_subdir>]
```

`run.sh` auto-detects the PHP version and required extensions from `--project-root`'s own composer.json/composer.lock (default PHP **8.5** if the project doesn't pin one), and resolves/builds the shared Docker image via `lib/docker/build-or-reuse.sh` — the build itself only happens once per project per unique requirement set, every later run reuses the cached image. Omit `--mount-root`/`--project-subdir` entirely for a non-monorepo project.

Always runs with `--formatter=json`; never bypass this with ad-hoc flags — the fixed format is what makes Step 3 reliable.

## Step 3 — Group findings by layer pair

```
node skills/deptrac/scripts/parse-results.js --report <tmp report path> --registry <the CLAUDE.md/CLAUDE.local.md that holds the section>
```

Returns `{ groups: [{ layer, dependentLayer, pairKey, slug, rule, count, items, strategy, context, workflowPath, workflowSource, known }] }`, one group per violated layer pair.

- `workflowSource: "plugin-strategy"` — the Layer Map assigns one of the 4 shipped strategies to this pair; `workflowPath` points into `scripts/strategies/`, and `context` (from the registry's Notes column) must be passed at runtime.
- `workflowSource: "project-custom"` — a bespoke workflow was previously generated for this exact pair at `workflowPath` (under the project's `.claude/workflows/`).
- `workflowSource: null` (`known: false`) — this pair hasn't been seen before; needs Step 4b.

If there are zero groups, Deptrac is clean — report that and stop.

## Step 4 — Dispatch each group

For every group, in order (largest count first):

**4a. `known: true`, `workflowSource: "plugin-strategy"`**:
```
Workflow({ scriptPath: group.workflowPath, args: { items: group.items, context: group.context } })
```

**4a. `known: true`, `workflowSource: "project-custom"`**:
```
Workflow({ scriptPath: group.workflowPath, args: group.items })
```

**4b. `known: false`** — run a one-time "architecture analyst" pass, then dispatch immediately:
1. Spawn one subagent (`Agent` tool, default/Sonnet-tier model — this is the one place a stronger model is required, since it's making the architectural call):
   - The project's `depfile.yaml` contents (layer names, collectors, rulesets) — have the agent read it directly
   - 2–3 sample violations from `group.items` (class, dependencyClass, file, line), and have the agent read those files for real context
   - A one-line description of each of the 4 shipped strategies (see the skill files list above)
   - Instruction: decide which shipped strategy genuinely fits this layer pair's real dependency shape in this codebase. If one fits:
     - Write a concise "Notes" string capturing this project's concrete conventions needed to apply it (e.g. "Ports live under src/Domain/Port, wired via src/Infrastructure/Container.php autowiring" or "Shared layer is src/Shared, Symfony EventDispatcher is used, listeners live under src/*/Listener").
     - Append `| Layer -> DependentLayer | <strategy-slug> | <notes> |` to the `### Layer Map` table.
   - If none of the 4 fits, author a new bespoke workflow at `.claude/workflows/deptrac-<slug>.js` following `templates/custom-strategy-template.js`, then append `| Layer -> DependentLayer | custom | <one-line description> |` to the Layer Map.
2. Run the resolved workflow the same way as 4a — the first occurrence gets fixed immediately, not deferred.

Groups can be dispatched concurrently once each one's strategy/workflow is resolved; unrelated layer pairs don't need to be serialized.

## Step 5 — Summarize

Report to the user:
- Total findings fixed by Haiku vs. escalated to the default model
- Any new layer-pair strategy decisions made this run (pair + chosen strategy or custom workflow)
- Any items still `needs_escalation` after the default-model pass — surface these explicitly
- A reminder to re-run this skill to confirm Deptrac is now clean

## Notes

- Verify Deptrac's JSON violation field names once against a real `vendor/bin/deptrac analyse --formatter=json` run for the target project's installed Deptrac version — `parse-results.js` tries a couple of common field-name variants defensively, but the schema has shifted across major Deptrac versions historically.
- Never let a subagent silence a violation by loosening `depfile.yaml` rulesets — that's a rule-definition change, not a fix, and requires explicit user confirmation (see the skill's original guidance below).
- The 4 shipped strategies are deliberately generic (parameterized by `context` at runtime) — don't bake project-specific paths/conventions into them; those belong in a project's Layer Map `Notes` or, if truly one-off, a custom workflow.
- Don't loosen ruleset constraints just to silence violations; confirm with the user that a rule change is intentional rather than treating it as a fix.
- The container never depends on the host machine's PHP install — only on what `lib/docker/detect-requirements.js` finds in the *target project's own* composer.json/composer.lock. If Deptrac fails inside the container complaining about a missing extension that genuinely isn't declared anywhere in composer.json/composer.lock, pass it via `--extra-extensions` on `docker/run.sh` rather than editing `lib/docker/Dockerfile`.
