// Shared identifier -> slug conversion, used by parse-results.js and by the
// SKILL.md instructions for naming newly generated workflow scripts. Both
// must agree on this exact mapping or "known identifier" lookups will miss.
'use strict';

function slugify(identifier) {
  return identifier
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function workflowPathForIdentifier(identifier) {
  return `.claude/workflows/phpstan-${slugify(identifier)}.js`;
}

module.exports = { slugify, workflowPathForIdentifier };
