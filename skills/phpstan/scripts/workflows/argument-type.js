export const meta = {
  name: 'phpstan-argument-type',
  description: 'Auto-fix PHPStan argument.type findings',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { itemsFile } (see loader below) or, legacy, an array of { file, line, message } for identifier "argument.type"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: argument.type) in ${item.file} at line ${item.line}:

"${item.message}"

A function/method call passes an argument whose type doesn't match the
declared parameter type. The message names the expected type and the given
type — parse both from it.

What to do, in this order of preference:
1. Fix the call site at line ${item.line}: convert/cast/adjust the value
   being passed so it actually matches the expected type (e.g. cast
   \`(int) $x\`, unwrap a nullable with a prior null-check, pass \`$foo->id\`
   instead of \`$foo\`, etc.) — pick whichever concretely produces the
   expected type given what's available at the call site.
2. If the value at the call site can genuinely be null/absent in a way the
   callee should handle, and changing the call site isn't right, add a
   guard (early return / \`if\` check) before the call instead of forcing a
   cast that could hide a real bug.
3. Only change the callee's declared parameter type (widen it) if the
   callee's type declaration is clearly the actual bug — i.e. the value
   being passed is legitimately valid and multiple call sites need this
   type. Do this rarely and only when confident.
4. Save the file(s) you changed.

Do not silence the error with \`@phpstan-ignore\`. If you can't determine
which of the value or the declared type is actually wrong, return status
"needs_escalation" and explain why in "note".`
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
