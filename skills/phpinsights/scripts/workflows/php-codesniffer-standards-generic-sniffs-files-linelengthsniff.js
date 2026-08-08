export const meta = {
  name: 'phpinsights-line-length',
  description: 'Auto-fix PHPInsights findings for Generic.Files.LineLengthSniff',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for insight
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

const results = await pipeline(
  args,
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
      }),
)

return results
