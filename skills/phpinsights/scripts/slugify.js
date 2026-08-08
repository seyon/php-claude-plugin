// Shared insight-class -> slug conversion, used by parse-results.js and by
// the SKILL.md instructions for naming newly generated project-local
// workflows. Both must agree on this exact mapping or "known insight"
// lookups will miss.
//
// PHPInsights groups issues by "insight class" -- the fully-qualified class
// name of the underlying check (a PHP_CodeSniffer sniff, a PHPMD rule, or
// one of PHPInsights' own Insights classes, e.g.
// "SlevomatCodingStandard\Sniffs\Namespaces\UnusedUsesSniff"). Unlike
// Deptrac's layer pairs, this is effectively universal across projects
// (it's a class name from a composer-installed check library), so it plays
// the same role PHPStan's error identifier does.
'use strict';

function slugify(insightClass) {
  return String(insightClass)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function workflowPathForInsight(insightClass) {
  return `.claude/workflows/phpinsights-${slugify(insightClass)}.js`;
}

module.exports = { slugify, workflowPathForInsight };
