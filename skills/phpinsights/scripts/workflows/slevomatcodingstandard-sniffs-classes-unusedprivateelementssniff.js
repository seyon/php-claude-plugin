export const meta = {
  name: 'phpinsights-unused-private-elements',
  description: 'Auto-fix PHPInsights findings for SlevomatCodingStandard.Sniffs.Classes.UnusedPrivateElementsSniff',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { itemsFile } (see loader below) or, legacy, an array of { file, line, message } for insight
// "SlevomatCodingStandard\Sniffs\Classes\UnusedPrivateElementsSniff"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPInsights finding (UnusedPrivateElementsSniff) in ${item.file} at line ${item.line}:

"${item.message}"

A private property, method, or constant declared in this class is never
used anywhere else in the same class (private members are only ever
accessible within their own class, so "unused in this class" means
genuinely dead).

What to do:
1. Open ${item.file} and find the private member declared at/near line
   ${item.line}.
2. Search the entire class body (including all its methods) for any
   reference to it (\`$this->member\`, \`self::CONST\`, \`self::method()\`,
   or via a magic \`__get\`/\`__call\` that reads its name dynamically —
   check for those before deleting).
3. If it's genuinely unused, delete the declaration (and, for a method,
   its full body) entirely.
4. If it's a constructor-promoted private property, remove the promotion
   from the constructor parameter instead of leaving an orphaned
   parameter.
5. Save the file.

If the member is referenced dynamically (via variable variables,
\`__get\`/\`__set\`/\`__call\`, reflection, or serialization) in a way that
static analysis wouldn't catch, return status "needs_escalation" instead
of deleting it.`
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
