export const meta = {
  name: 'deptrac-replace-with-event',
  description: 'Fix Deptrac layer violations by replacing a direct call with an event/message',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { itemsFile, context } (see loader below) or, legacy, { items: [{ class, dependencyClass, file, line, rule }], context: string }
// `context` is this project's recorded convention for this layer pair —
// typically the event dispatcher/bus mechanism and where event/listener
// classes conventionally live.

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item, context) {
  return `Fix this Deptrac architecture violation using the "Replace direct call with event/message" strategy.

Rule violated: "${item.rule}"
${item.class} calls into ${item.dependencyClass} (${item.file}:${item.line}), which its layer is not allowed to depend on. This strategy applies when that call is a fire-and-forget side effect (${item.class} doesn't need a return value back from ${item.dependencyClass}).

Project-specific conventions for eventing in this project:
${context ? context : '(none recorded yet — look for an existing event dispatcher/bus and event/listener directory convention in the project before inventing one)'}

What to do:
1. Read ${item.file} around line ${item.line} and confirm the call to
   ${item.dependencyClass} is genuinely fire-and-forget — ${item.class}
   does not use a return value from it afterward. If it does use a return
   value, this strategy doesn't apply (see below).
2. Define an event/message class representing what happened (named for the
   business fact, e.g. \`OrderPlaced\`, not for the technical action),
   placed in ${item.class}'s own layer per the conventions above.
3. In ${item.class}, replace the direct call to ${item.dependencyClass}
   with dispatching the new event via the project's event
   dispatcher/bus (per the conventions above).
4. Move the logic that used to run inside the call to
   ${item.dependencyClass} into a new event listener/handler class living
   in ${item.dependencyClass}'s layer, subscribed to the new event via the
   project's usual listener registration mechanism.
5. Save every file you changed.

If the call requires a return value that ${item.class} depends on, or the
project's eventing mechanism can't be determined from the context and
surrounding code, return status "needs_escalation" and explain why in
"note" instead of forcing this strategy where it doesn't fit.`
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
