export const meta = {
  name: 'deptrac-dependency-inversion',
  description: 'Fix Deptrac layer violations by extracting a port interface and inverting the dependency',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { itemsFile, context } (see loader below) or, legacy, { items: [{ class, dependencyClass, file, line, rule }], context: string }
// `context` is this project's recorded convention for this layer pair (from
// the Layer Map "Notes" column) — e.g. where ports/interfaces live, and how
// dependency injection is wired. Without it, generic advice; with it,
// Haiku gets project-exact instructions.

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item, context) {
  return `Fix this Deptrac architecture violation using the "Dependency Inversion" strategy.

Rule violated: "${item.rule}"
${item.class} depends on ${item.dependencyClass}, which its layer is not allowed to depend on (found in ${item.file}:${item.line}).

Project-specific conventions for this layer pair:
${context ? context : '(none recorded yet — infer conventions from the surrounding codebase before making assumptions)'}

What to do:
1. Read ${item.file} around line ${item.line} and determine exactly what
   ${item.class} needs from ${item.dependencyClass} — which method(s) or
   behavior, not the concrete implementation.
2. Define an interface (port) for that behavior, named after the
   capability it provides (e.g. \`PaymentGatewayInterface\`, not
   \`StripeGatewayInterface\`), placed according to the project conventions
   above. If no convention is recorded, place it in the same
   namespace/layer as ${item.class}.
3. Make ${item.dependencyClass} implement that interface (add
   \`implements TheNewInterface\`) — it can stay in its current layer/file.
4. Change ${item.class} to depend on the new interface instead of
   ${item.dependencyClass} directly: update the type hint on the
   constructor parameter / property / method parameter, and update any
   \`use\` import accordingly.
5. Wire the concrete ${item.dependencyClass} to the interface using the
   project's dependency injection mechanism described above (e.g. a
   service container binding, autowiring config, or factory) — do not
   instantiate ${item.dependencyClass} directly inside ${item.class}.
6. Save every file you changed.

If you can't determine what ${item.class} actually needs from the
dependency, or the project's DI wiring convention isn't clear enough from
the context above and the surrounding code, return status
"needs_escalation" instead of guessing.`
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
