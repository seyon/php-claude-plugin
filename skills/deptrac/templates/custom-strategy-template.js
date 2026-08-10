// TEMPLATE — not executed directly. This is the skeleton the "architecture
// analyst" subagent must follow when none of the 4 plugin-shipped generic
// strategies (dependency-inversion, move-to-correct-layer,
// extract-shared-abstraction, replace-with-event) cleanly fits a given
// layer pair, and a bespoke, project-local fix workflow is needed instead.
//
// Written to .claude/workflows/deptrac-<layer-pair-slug>.js in the TARGET
// PROJECT (not into this plugin) — it encodes knowledge specific to that
// project's architecture, not a generally reusable technique.
//
// Unlike the plugin strategies (which take `context` at runtime from the
// Layer Map because they're reused across pairs/projects), a custom
// workflow is written for exactly one layer pair in one project, so its
// fix recipe can be baked in directly.
//
//   1. Replace LAYER_PAIR with "LayerA -> LayerB" for logging/labels only.
//   2. Write a precise, self-contained FIX_PROMPT: what the real
//      architectural fix looks like for THIS pair in THIS project —
//      informed by actually reading the depfile.yaml layer collectors and
//      a few real violating files, not generic advice.
//   3. Keep the two-stage Haiku -> escalate pipeline.
//   4. `meta.name` must be `deptrac-<layer-pair-slug>` matching the Layer
//      Map row's slug.

export const meta = {
  name: 'deptrac-LAYER_PAIR_SLUG',
  description: 'Auto-fix Deptrac violations for layer pair: LAYER_PAIR',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { itemsFile } (see loader below) or, legacy, an array of { class, dependencyClass, file, line, rule } — one entry
// per violation for this layer pair, as produced by scripts/parse-results.js.

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this Deptrac architecture violation (layer pair: LAYER_PAIR) in
${item.file} at line ${item.line}:

Rule: "${item.rule}"
${item.class} depends on ${item.dependencyClass}.

<bespoke fix recipe goes here — exact steps for this project's actual
architecture, written by the architecture-analyst agent after reading the
project's depfile.yaml and real violating files, not left for the fixing
agent to infer>

Apply the minimal correct fix and save every file you changed. If you
cannot apply the fix with full confidence, return status
"needs_escalation" and explain why in "note" instead of guessing.`
}

// Load the item list. `args` is { itemsFile } (preferred -- the path printed
// by parse-results.js; passing the path instead of the items keeps the full
// violation list out of the calling conversation's context) or, legacy, the
// items array itself. Workflow scripts have no filesystem access, so a
// cheap agent reads the file.
const ITEMS_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object' } } },
  required: ['items'],
}
const items = Array.isArray(args)
  ? args
  : (await agent(
      `Read the JSON file at ${args.itemsFile} and return exactly {"items": <the file's parsed array>}. Do not modify, filter, reorder, or summarize it.`,
      { model: 'claude-haiku-4-5', label: 'load-items', schema: ITEMS_SCHEMA },
    )).items

const results = await pipeline(
  items,
  (item) => agent(FIX_PROMPT(item), {
    model: 'claude-haiku-4-5',
    phase: 'Fix',
    label: `${item.file}:${item.line}`,
    schema: FIX_RESULT_SCHEMA,
  }),
  (result, item) => (result && result.status === 'fixed')
    ? result
    : agent(FIX_PROMPT(item), {
        phase: 'Escalate',
        label: `${item.file}:${item.line}`,
        schema: FIX_RESULT_SCHEMA,
      }).then((r) => (r ? { ...r, escalated: true } : r)),
)

// Return a compact summary, not the full per-item results -- the summary
// is what lands back in the calling conversation's context. Detail is only
// carried for items that still need attention.
const summary = { total: items.length, fixed_by_haiku: 0, fixed_after_escalation: 0, fixedFiles: [], needs_escalation: [] }
for (let i = 0; i < results.length; i++) {
  const r = results[i]
  if (r && r.status === 'fixed') {
    if (r.escalated) summary.fixed_after_escalation += 1
    else summary.fixed_by_haiku += 1
    if (items[i].file && !summary.fixedFiles.includes(items[i].file)) summary.fixedFiles.push(items[i].file)
  } else {
    summary.needs_escalation.push({ ...items[i], note: r ? r.note : 'agent failed or was skipped' })
  }
}
return summary
