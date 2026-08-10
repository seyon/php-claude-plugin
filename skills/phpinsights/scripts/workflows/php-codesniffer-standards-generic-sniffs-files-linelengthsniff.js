export const meta = {
  name: 'phpinsights-line-length',
  description: 'Auto-fix PHPInsights findings for Generic.Files.LineLengthSniff',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { itemsFile } (see loader below) or, legacy, an array of { file, line, message } for insight
// "PHP_CodeSniffer\Standards\Generic\Sniffs\Files\LineLengthSniff"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPInsights finding (LineLengthSniff) in ${item.file} at line ${item.line}:

"${item.message}"

The line exceeds the configured maximum length (the message states the
limit and the actual length — use that limit as the target).

What to do:
1. Open ${item.file} and read the full line at ${item.line}.
2. Break it across multiple lines without changing behavior, choosing
   whichever fits the code naturally:
   - Long method chains: put each \`->method(...)\` call on its own line.
   - Long function calls with several arguments: one argument per line,
     with a trailing comma on the last one, closing paren on its own line.
   - Long conditional expressions: break at logical operators (\`&&\`,
     \`||\`), with the operator at the start of the continuation line.
   - Long array literals: one entry per line with a trailing comma.
   - Long string concatenation: break at \`.\` operators.
3. Match the file's existing indentation style for the continuation lines.
4. Do not shorten variable/method names or remove content just to fit the
   line length — only reformat whitespace/line breaks.
5. Save the file.

If the line can't be broken without changing semantics (e.g. it's a single
very long string literal or URL that must stay on one line), return status
"needs_escalation" instead of forcing an unnatural break.`
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
