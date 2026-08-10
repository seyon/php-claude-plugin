# php-tools

A [Claude Code plugin](https://docs.claude.com/en/docs/claude-code) that provides PHP quality-tooling skills — currently [PHPStan](https://phpstan.org), [PHPInsights](https://github.com/nunomaduro/phpinsights), [Deptrac](https://github.com/qossmic/deptrac), and a Symfony log investigator.

## What it does

The three static-analysis skills (`phpstan`, `phpinsights`, `deptrac`) are more than a wrapper around a CLI tool each — they're an **advisor loop**:

1. Run the tool in an isolated Docker container with fixed, reproducible parameters (JSON output, result caching where applicable).
2. Group the findings by their underlying cause — PHPStan's error identifier, PHPInsights' insight class, or Deptrac's violated layer pair.
3. Dispatch each group to a fix workflow that gives a small, cheap model (Haiku) a precise, pre-written fix recipe instead of the raw tool output — escalating to a stronger model only for the cases Haiku can't confidently resolve on its own.
4. The first time a new kind of finding shows up in a project, a stronger model (Sonnet) is spent once to write that fix recipe; every later occurrence of the same finding — in this project or any other using the plugin — reuses it directly with the cheap model.

The result: static analysis output that used to be dumped raw into an expensive model's context instead gets turned into targeted, model-tier-appropriate fix instructions, with the recipe-writing cost paid once per kind of issue rather than once per occurrence.

The fourth skill, `symfony-log`, applies the same cheap-model-first idea to a different problem: investigating a Symfony project's own application logs. Given a problem/question, it has Haiku bulk-cluster and summarize the relevant `var/log/*.log` entries into a compact findings list, then answers the question directly from that summary instead of reading raw log noise. It's a local-development aid — it defaults to the `dev` log, not `prod`.

See each skill's `SKILL.md` for its exact workflow.

## Installation

This repo is its own [plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces), so installing everything is two commands inside Claude Code:

```
/plugin marketplace add seyon/php-claude-plugin
/plugin install seyon-php-tools@seyon-php-tools
```

If the install output says to run `/reload-plugins`, do that afterward to activate it. No other setup is required beyond having [Docker](#docker-not-a-generic-tool-runner) available locally — the skills themselves detect everything else about the target project on first use.

### Installing a single skill

Each skill also has its own marketplace entry, so you don't have to pull in all four if you only want one. Their tool names are distinctive enough on their own — no extra prefix needed. After the `marketplace add` step above, install just the skill you need instead of `seyon-php-tools@seyon-php-tools`:

```
/plugin install phpstan@seyon-php-tools
```

Swap `phpstan` for `phpinsights`, `deptrac`, or `symfony-log` to install just that one skill.

### Keeping it updated

Auto-update is **off by default** for third-party marketplaces like this one (it's on by default only for official Anthropic marketplaces), so new commits pushed to this repo are *not* picked up automatically until you either:

- Enable it: run `/plugin` → **Marketplaces** tab → select `seyon-php-tools` → toggle **Enable auto-update** (checked in the background shortly after each session start from then on), or
- Update on demand: `claude plugin update seyon-php-tools@seyon-php-tools` (or `/plugin marketplace update seyon-php-tools` to refresh the whole catalog first).

## Docker, not a generic tool runner

Every skill *except* `symfony-log` (which only reads log files off disk, nothing to isolate) runs its tool inside a Docker container built specifically for the target project — the container gets exactly the PHP version and extensions that project's own `composer.json`/`composer.lock` declare (auto-detected, see `lib/docker/`), so the analysis never depends on whatever happens to be installed on the host, and never fails on a missing extension the host happens to have. The (expensive) image build only happens once per project per unique requirement set; later runs reuse it.

This means **Docker is a hard requirement** for the `phpstan`/`phpinsights`/`deptrac` skills — there is deliberately no fallback to running tools directly on the host. The plugin has not been built or tested against any other execution environment (podman, rootless containers, remote Docker daemons, CI runners without Docker-in-Docker, Windows without WSL2, etc.). If you need one of those, expect to adapt `lib/docker/` and each skill's `docker/run.sh` yourself.

## Project files are never touched

The analysis tooling never writes into the target project. Tool caches that would normally land in the project tree are redirected to a plugin-managed host directory (`~/.cache/php-claude-plugin/<skill>/<project>`, bind-mounted into the container): PHPStan's result cache via a generated wrapper config that includes the project's own `phpstan.neon` unchanged and overrides only `tmpDir`, Deptrac's cache via `--cache-file`. Project configs are never edited during setup either — the only files a skill writes are its settings/registry section in `CLAUDE.md`/`CLAUDE.local.md`, generated workflows under `.claude/workflows/`, and the actual code fixes. An existing Deptrac baseline (`deptrac.baseline.yaml` imported by the config) is respected as-is: baselined violations are excluded from findings, never "fixed", and the baseline is never regenerated.

## Context-window hygiene

The skills are built to keep the orchestrating conversation's context small: Docker build logs go to a log file (`~/.cache/php-claude-plugin/build-logs/`, one summary line in the conversation), each skill's `parse-results.js` writes the full finding lists to per-group files and prints only counts, paths, and 3 sample items, workflows receive the items **file path** (not the items) and load it themselves via a cheap agent, and every workflow returns a compact summary (counts + only the items that still need attention) instead of per-item logs. So a run with hundreds of findings costs the main context roughly the same as a run with five.

## Extra mounts

Each `docker/run.sh` accepts repeatable `--extra-mount HOST:CONTAINER[:ro]` flags (recorded per project as `extra_mounts` in the skill settings) for folders the single project mount can't cover — e.g. a shared PHPStan-rules directory elsewhere on the host. If the project config references such a folder by relative path, mount it at the container path where that relative reference resolves from `/app`.

## Monorepo support

Skills resolve their target project's root as the directory containing that specific PHP project's own `composer.json` — not necessarily the repository root — and settings/registries are recorded next to it, so a monorepo with several PHP packages ends up with one such section per package. If a project's `composer.json` declares autoload paths pointing outside its own directory (e.g. shared custom PHPStan rules kept in a sibling folder and wired in purely through Composer autoloading), the Docker mount is automatically widened just enough to cover them — capped at a few directory levels, and always overridable, so this stays safe for a default/public checkout that has no such setup.
