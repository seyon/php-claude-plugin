export const meta = {
  name: 'phpinsights-cyclomatic-complexity',
  description: 'Auto-fix PHPInsights findings for CyclomaticComplexityIsHigh',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { itemsFile } (see loader below) or, legacy, an array of { file, line, message } for insight
// "NunoMaduro\PhpInsights\Domain\Insights\CyclomaticComplexityIsHigh"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPInsights finding (CyclomaticComplexityIsHigh) in ${item.file} at line ${item.line}:

"${item.message}"

The method/function starting at/near line ${item.line} has too many
independent execution paths (too many if/else, switch cases, loops,
&&/||, catch blocks combined in one function).

What to do, in order of preference:
1. Read the full function body and identify self-contained chunks of
   logic (e.g. a validation block, a single \`switch\`/\`match\` arm's worth
   of logic, a loop body) that can be extracted into their own
   well-named private method, each handling one responsibility.
2. Prefer early returns/guard clauses over deeply nested if/else chains —
   flatten \`if (cond) { ... } else { ... }\` into
   \`if (!cond) { return ...; } ...\` where that doesn't change behavior.
3. If the function branches heavily on a type/enum/string, consider
   replacing a long if/elseif chain with a lookup table (array mapping)
   or \`match\` expression if that's cleaner and behavior-preserving.
4. After refactoring, the original method's logic must be 100%
   behaviorally identical for every input — this is a structure-only
   change, not a logic change.
5. Save the file(s) you changed.

This requires understanding the function's actual logic, not a mechanical
pattern — if the function is too intertwined to safely split without
risking a behavior change, return status "needs_escalation" instead of
attempting a risky refactor.`
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
