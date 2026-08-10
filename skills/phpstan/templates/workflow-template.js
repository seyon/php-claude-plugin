// TEMPLATE — not executed directly. This is the skeleton the "recipe
// author" subagent must follow when generating a new
// .claude/workflows/phpstan-<slug>.js for a previously-unseen PHPStan error
// identifier. Copy this shape, then:
//
//   1. Replace ERROR_IDENTIFIER with the exact phpstan identifier string
//      (e.g. "missingType.iterableValue").
//   2. Replace the body of FIX_PROMPT with a precise, self-contained fix
//      recipe for THIS identifier specifically — exact syntax, examples,
//      edge cases — detailed enough that a small/cheap model can apply it
//      correctly without further reasoning about *why* the rule exists.
//   3. Keep the two-stage pipeline (Haiku attempt, then Sonnet escalation
//      only for items Haiku couldn't confidently fix) — do not remove the
//      escalation stage or default every item straight to the expensive
//      model.
//   4. Leave `meta.name` as `phpstan-<slug>` matching the registry slug so
//      the Recipe Registry row and this file's name stay in sync.

export const meta = {
  name: 'phpstan-ERROR_IDENTIFIER_SLUG',
  description: 'Auto-fix PHPStan findings for identifier: ERROR_IDENTIFIER',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { itemsFile } (see loader below) or, legacy, an array of { file, line, message } — one entry per PHPStan finding
// for this identifier, as produced by scripts/parse-results.js.

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: ERROR_IDENTIFIER) in ${item.file} at line ${item.line}:

"${item.message}"

<fix recipe goes here — exact syntax/pattern for this identifier, written
by the recipe-author agent, not left for the fixing agent to infer>

Read the file, apply the minimal correct fix, and save it. If you cannot
apply the fix with full confidence (e.g. the recipe doesn't clearly cover
this case), return status "needs_escalation" and explain why in "note"
instead of guessing.`
}

// Load the item list. `args` is { itemsFile } (preferred -- the path printed
// by parse-results.js; passing the path instead of the items keeps the full
// finding list out of the calling conversation's context) or, legacy, the
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
    // No model override here — inherits the session's default (Sonnet),
    // used only for the subset Haiku flagged as uncertain.
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
