export const meta = {
  name: 'phpstan-method-notfound',
  description: 'Auto-fix PHPStan method.notFound findings',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for identifier "method.notFound"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: method.notFound) in ${item.file} at line ${item.line}:

"${item.message}"

Code calls a method that doesn't exist on the class named in the message.

What to do, in this order:
1. Open the class named in the message and list its actual declared
   methods (including ones from traits/parent classes/interfaces).
2. If the called method name is a near-miss of an existing one (typo,
   wrong case), fix the typo at line ${item.line} to call the correct
   existing method — this is the most common cause.
3. If no similar method exists and the call is clearly intentional, add
   the missing method to the class with a signature (parameters, return
   type) inferred from how it's called at line ${item.line} and, if
   visible, from a plausible implementation based on the class's existing
   methods. If you cannot determine what the method should actually do,
   do NOT invent a stub implementation — return "needs_escalation" instead.
4. If the class uses \`__call\`/\`__callStatic\` for dynamic methods, add a
   \`@method ReturnType name(ParamType $param)\` PHPDoc tag on the class
   instead of a real method.
5. Save the file(s) you changed.

If it's unclear whether this is a typo, a missing method whose behavior you
can safely infer, or a magic-method case, return status "needs_escalation"
and explain why in "note" instead of guessing.`
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
