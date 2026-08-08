export const meta = {
  name: 'phpstan-assign-propertytype',
  description: 'Auto-fix PHPStan assign.propertyType findings',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for identifier "assign.propertyType"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: assign.propertyType) in ${item.file} at line ${item.line}:

"${item.message}"

A value is being assigned to a property whose declared type doesn't accept
it. The message names the property's declared type and the assigned value's
type — parse both from it.

What to do:
1. Decide which is correct: is the property's declared type right and the
   assigned value wrong, or is the property's type too narrow for a
   legitimately valid value?
2. If the declared type is correct: fix the assignment at line ${item.line}
   so the assigned value actually matches (cast/convert/assign the right
   variable).
3. If the assigned value is correct and the property's type is too narrow:
   widen the property's type declaration (or its \`@var\` PHPDoc tag) to
   cover this case.
4. Save the file(s) you changed.

If it's unclear which side is actually wrong, return status
"needs_escalation" and explain why in "note" instead of guessing.`
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
