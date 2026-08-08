# php-tools

A [Claude Code plugin](https://docs.claude.com/en/docs/claude-code) that provides PHP quality-tooling skills — currently [PHPStan](https://phpstan.org), [PHPInsights](https://github.com/nunomaduro/phpinsights), and [Deptrac](https://github.com/qossmic/deptrac).

## What it does

Each skill is more than a wrapper around a CLI tool — it's an **advisor loop**:

1. Run the tool in an isolated Docker container with fixed, reproducible parameters (JSON output, result caching where applicable).
2. Group the findings by their underlying cause — PHPStan's error identifier, PHPInsights' insight class, or Deptrac's violated layer pair.
3. Dispatch each group to a fix workflow that gives a small, cheap model (Haiku) a precise, pre-written fix recipe instead of the raw tool output — escalating to a stronger model only for the cases Haiku can't confidently resolve on its own.
4. The first time a new kind of finding shows up in a project, a stronger model (Sonnet) is spent once to write that fix recipe; every later occurrence of the same finding — in this project or any other using the plugin — reuses it directly with the cheap model.

The result: static analysis output that used to be dumped raw into an expensive model's context instead gets turned into targeted, model-tier-appropriate fix instructions, with the recipe-writing cost paid once per kind of issue rather than once per occurrence.

Skills: `phpstan`, `phpinsights`, `deptrac`. See each skill's `SKILL.md` for its exact workflow.

## Docker, not a generic tool runner

Every skill runs its tool inside a Docker container built specifically for the target project — the container gets exactly the PHP version and extensions that project's own `composer.json`/`composer.lock` declare (auto-detected, see `lib/docker/`), so the analysis never depends on whatever happens to be installed on the host, and never fails on a missing extension the host happens to have. The (expensive) image build only happens once per project per unique requirement set; later runs reuse it.

This means **Docker is a hard requirement** for every skill in this plugin — there is deliberately no fallback to running tools directly on the host. The plugin has not been built or tested against any other execution environment (podman, rootless containers, remote Docker daemons, CI runners without Docker-in-Docker, Windows without WSL2, etc.). If you need one of those, expect to adapt `lib/docker/` and each skill's `docker/run.sh` yourself.

## Monorepo support

Skills resolve their target project's root as the directory containing that specific PHP project's own `composer.json` — not necessarily the repository root — and settings/registries are recorded next to it, so a monorepo with several PHP packages ends up with one such section per package. If a project's `composer.json` declares autoload paths pointing outside its own directory (e.g. shared custom PHPStan rules kept in a sibling folder and wired in purely through Composer autoloading), the Docker mount is automatically widened just enough to cover them — capped at a few directory levels, and always overridable, so this stays safe for a default/public checkout that has no such setup.
