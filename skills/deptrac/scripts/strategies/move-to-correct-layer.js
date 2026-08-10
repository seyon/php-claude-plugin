export const meta = {
  name: 'deptrac-move-to-correct-layer',
  description: 'Fix Deptrac layer violations by moving a misplaced class into its correct layer',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { itemsFile, context } (see loader below) or, legacy, { items: [{ class, dependencyClass, file, line, rule }], context: string }
// `context` is this project's recorded convention for this layer pair —
// typically which directory/namespace the class should move to, and how
// layers are detected (namespace prefix, directory collector, etc.).

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item, context) {
  return `Fix this Deptrac architecture violation using the "Move to correct layer" strategy.

Rule violated: "${item.rule}"
${item.class} (in ${item.file}:${item.line}) is currently placed in a layer
it doesn't belong to — its actual responsibility puts it closer to
${item.dependencyClass}'s layer, or a dependency on it wouldn't be a
violation.

Project-specific conventions for where this class belongs / how layers are
detected in this project:
${context ? context : '(none recorded yet — infer the correct target directory/namespace from the project\'s depfile.yaml layer collectors and existing directory structure before making assumptions)'}

What to do:
1. Confirm ${item.class}'s actual responsibility by reading ${item.file} —
   does it genuinely belong with ${item.dependencyClass}'s layer given what
   it does, not just where the violation says it currently lives?
2. Determine the correct target directory/namespace from the project
   conventions above (or from the project's depfile.yaml layer collectors
   if no convention is recorded yet).
3. Move the file to the correct location and update its namespace
   declaration to match.
4. Find every other file that references ${item.class} (via \`use\`
   statements or fully-qualified references) and update them to the new
   namespace.
5. Save every file you changed.

If moving ${item.class} would itself create new violations elsewhere, or
its correct layer is genuinely ambiguous, return status
"needs_escalation" and explain why in "note" instead of guessing.`
}

// Load the item list. `args` is { itemsFile, context } (preferred -- the
// path printed by parse-results.js; passing the path instead of the items
// keeps the full violation list out of the calling conversation's context)
// or, legacy, { items, context }. Workflow scripts have no filesystem
// access, so a cheap agent reads the file.
const ITEMS_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object' } } },
  required: ['items'],
}
const items = Array.isArray(args.items)
  ? args.items
  : (await agent(
      `Read the JSON file at ${args.itemsFile} and return exactly {"items": <the file's parsed array>}. Do not modify, filter, reorder, or summarize it.`,
      { model: 'claude-haiku-4-5', label: 'load-items', schema: ITEMS_SCHEMA },
    )).items

const results = await pipeline(
  items,
  (item) => agent(FIX_PROMPT(item, args.context), {
    model: 'claude-haiku-4-5',
    phase: 'Fix',
    label: `${item.file}:${item.line}`,
    schema: FIX_RESULT_SCHEMA,
  }),
  (result, item) => (result && result.status === 'fixed')
    ? result
    : agent(FIX_PROMPT(item, args.context), {
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
