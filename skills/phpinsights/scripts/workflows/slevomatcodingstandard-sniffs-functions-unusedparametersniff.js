export const meta = {
  name: 'phpinsights-unused-parameter',
  description: 'Auto-fix PHPInsights findings for SlevomatCodingStandard.Sniffs.Functions.UnusedParameterSniff',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { itemsFile } (see loader below) or, legacy, an array of { file, line, message } for insight
// "SlevomatCodingStandard\Sniffs\Functions\UnusedParameterSniff"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPInsights finding (UnusedParameterSniff) in ${item.file} at line ${item.line}:

"${item.message}"

A function/method parameter is never used in its body.

What to do:
1. Open ${item.file} and find the function/method signature at/near line
   ${item.line}, and the parameter named in the message.
2. Determine whether this parameter must stay for signature-compatibility
   reasons: it's required by an interface/parent class the method
   implements/overrides, it's a framework callback signature (e.g. event
   listener, middleware), or removing it would change the function's
   arity in a way that breaks callers passing positional arguments after
   it.
3. If it must stay for compatibility: prefix the parameter name with an
   underscore only if this project's conventions do that (check other
   similarly-unused-but-required parameters in the codebase first);
   otherwise leave it as-is and return "needs_escalation" — don't silently
   rename per a convention you haven't confirmed exists in this project.
4. If it's safe to remove (not required by any interface/parent, and no
   caller relies on positional arguments after it): remove the parameter
   entirely, and update every call site accordingly.
5. Save the file(s) you changed.

If you're not certain whether removing the parameter is safe (interface
compliance, callback contracts, positional-argument callers), return
status "needs_escalation" instead of guessing.`
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
