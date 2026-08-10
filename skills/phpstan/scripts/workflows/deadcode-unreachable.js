export const meta = {
  name: 'phpstan-deadcode-unreachable',
  description: 'Auto-fix PHPStan deadCode.unreachable findings',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { itemsFile } (see loader below) or, legacy, an array of { file, line, message } for identifier "deadCode.unreachable"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: deadCode.unreachable) in ${item.file} at line ${item.line}:

"${item.message}"

Code at/after line ${item.line} can never execute, because an earlier
statement in the same branch always terminates it (an unconditional
\`return\`, \`throw\`, \`continue\`, \`break\`, or \`exit\`/\`die\`).

What to do:
1. Read the statements immediately before line ${item.line} in the same
   block to find what's terminating the branch early.
2. Read the unreachable code itself to judge intent:
   - If it's genuinely dead (leftover from a refactor, duplicate logic,
     debug code) — delete the unreachable statement(s).
   - If the unreachable code was clearly meant to run (e.g. an early
     \`return\` was added by mistake, or a condition is missing around the
     terminating statement so it fires too broadly) — fix the preceding
     control flow instead of deleting the code, e.g. move the terminating
     statement inside the correct \`if\` branch, or remove it if it
     shouldn't be there at all.
3. Save the file.

Only ever delete code you're confident is truly dead. If it's not obvious
whether the terminating statement or the code after it is the actual bug,
return status "needs_escalation" and explain the ambiguity in "note" rather
than deleting something that might be intended behavior.`
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
