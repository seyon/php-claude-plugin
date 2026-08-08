export const meta = {
  name: 'phpinsights-trailing-array-comma',
  description: 'Auto-fix PHPInsights findings for SlevomatCodingStandard.Sniffs.Arrays.TrailingArrayCommaSniff',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for insight
// "SlevomatCodingStandard\Sniffs\Arrays\TrailingArrayCommaSniff"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPInsights finding (TrailingArrayCommaSniff) in ${item.file} at line ${item.line}:

"${item.message}"

A multi-line array literal is missing a trailing comma after its last
element.

What to do:
1. Open ${item.file} and find the array literal spanning line ${item.line}
   (it may start a few lines above).
2. Find the last element before the closing \`]\` or \`)\` of the array.
3. Add a comma immediately after that last element's value (before the
   closing bracket, which stays on its own line).
4. Do this only for arrays that are already written across multiple lines
   — do not reformat single-line arrays.
5. Save the file.

This is a purely mechanical, low-risk fix — only return "needs_escalation"
if you genuinely cannot locate the array literal referenced by the
message.`
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
