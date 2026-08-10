export const meta = {
  name: 'phpinsights-declare-strict-types',
  description: 'Auto-fix PHPInsights findings for SlevomatCodingStandard.Sniffs.TypeHints.DeclareStrictTypesSniff',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { itemsFile } (see loader below) or, legacy, an array of { file, line, message } for insight
// "SlevomatCodingStandard\Sniffs\TypeHints\DeclareStrictTypesSniff"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPInsights finding (DeclareStrictTypesSniff) in ${item.file}:

"${item.message}"

This PHP file is missing (or has a misplaced/incorrectly formatted)
\`declare(strict_types=1);\` statement.

What to do:
1. Open ${item.file} and find the \`<?php\` opening tag.
2. Ensure the very first statement after \`<?php\` is exactly
   \`declare(strict_types=1);\` on its own line, followed by a blank line
   before anything else (namespace declaration, use statements, etc.).
3. If a \`declare(strict_types=1);\` already exists but is positioned wrong
   (e.g. after the namespace/use statements) or formatted differently
   (spacing, missing semicolon), move/fix it rather than adding a
   duplicate.
4. Do not add this to files that aren't plain PHP class/script files (e.g.
   skip if the file is a template with mixed HTML/PHP where a leading
   declare statement would break output — return "needs_escalation"
   instead for those).
5. Save the file.

This is purely additive and should never change runtime behavior beyond
enabling strict type checking — only return "needs_escalation" if adding
it would put PHP code after non-PHP output (rare, only in template-style
files).`
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
