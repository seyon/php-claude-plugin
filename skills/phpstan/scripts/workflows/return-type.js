export const meta = {
  name: 'phpstan-return-type',
  description: 'Auto-fix PHPStan return.type findings',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for identifier "return.type"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: return.type) in ${item.file} at line ${item.line}:

"${item.message}"

A method/function's declared return type doesn't match what it actually
returns at line ${item.line}. The message names the declared type and the
actual type — parse both from it.

What to do:
1. Decide which is correct: read the method's other return statements and
   its declared purpose/name to judge whether the declared return type or
   the offending \`return\` statement is the bug.
2. If the declared type is correct: fix the \`return\` statement at line
   ${item.line} so its value actually matches (cast/convert/return the
   right variable).
3. If the returned value is correct and the declared type is too narrow:
   widen the return type in the method signature (or its \`@return\`
   PHPDoc tag) to cover this case too.
4. Save the file.

If the method is an interface/abstract implementation and changing the
return type could break other implementations, or the correct choice is
genuinely unclear, return status "needs_escalation" and explain why in
"note" instead of guessing.`
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
