export const meta = {
  name: 'deptrac-extract-shared-abstraction',
  description: 'Fix Deptrac layer violations by extracting a shared type both layers may depend on',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { itemsFile, context } (see loader below) or, legacy, { items: [{ class, dependencyClass, file, line, rule }], context: string }
// `context` is this project's recorded convention for this layer pair —
// typically the name/namespace of the shared/kernel layer both sides are
// allowed to depend on.

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item, context) {
  return `Fix this Deptrac architecture violation using the "Extract shared abstraction" strategy.

Rule violated: "${item.rule}"
${item.class} depends on ${item.dependencyClass} (${item.file}:${item.line}), but what it actually needs is a concept both layers legitimately share (e.g. a value object, DTO, enum, or plain data type) — neither layer should depend on the other for it.

Project-specific conventions for the shared/kernel layer both sides may
depend on:
${context ? context : '(none recorded yet — look for an existing shared/common/kernel namespace in the project before creating a new one)'}

What to do:
1. Read ${item.file} around line ${item.line} and identify the specific
   concept (type/value/constant) ${item.class} needs from
   ${item.dependencyClass} — it should be something with no real behavior
   tied to either layer (data shape, enum, simple value object), not
   business logic.
2. Extract that concept into a new class/interface/enum placed in the
   project's shared/kernel layer per the conventions above.
3. Update ${item.dependencyClass}'s layer to also reference the extracted
   shared type where it previously defined the concept directly (if
   applicable).
4. Update ${item.class} to depend on the newly extracted shared type
   instead of on ${item.dependencyClass}.
5. Save every file you changed.

If what ${item.class} needs isn't a genuinely shared, behavior-free concept
(i.e. it actually needs real logic that only makes sense in
${item.dependencyClass}'s layer), this strategy doesn't apply — return
status "needs_escalation" and say so in "note" rather than forcing an
extraction that doesn't fit.`
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
