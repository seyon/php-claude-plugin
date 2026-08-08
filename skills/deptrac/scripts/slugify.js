// Shared layer-pair -> slug conversion, used by parse-results.js and by the
// SKILL.md instructions for naming newly generated project-local custom
// strategy workflows. Both must agree on this exact mapping.
'use strict';

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function layerPairKey(layer, dependentLayer) {
  return `${layer} -> ${dependentLayer}`;
}

function layerPairSlug(layer, dependentLayer) {
  return `${slugify(layer)}-${slugify(dependentLayer)}`;
}

function customWorkflowPathForPair(layer, dependentLayer) {
  return `.claude/workflows/deptrac-${layerPairSlug(layer, dependentLayer)}.js`;
}

module.exports = { slugify, layerPairKey, layerPairSlug, customWorkflowPathForPair };
