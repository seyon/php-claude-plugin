export const meta = {
  name: 'phpstan-property-notfound',
  description: 'Auto-fix PHPStan property.notFound findings',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for identifier "property.notFound"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: property.notFound) in ${item.file} at line ${item.line}:

"${item.message}"

Code accesses a property that doesn't exist on the class named in the
message.

What to do, in this order:
1. Open the class named in the message and list its actual declared
   properties (including ones from traits/parent classes).
2. If the accessed property name is a near-miss of an existing one (typo,
   wrong case, singular/plural mismatch), fix the typo at line ${item.line}
   to use the correct existing property name — this is the most common
   cause.
3. If no similar property exists and the access is clearly intentional
   (e.g. reading a value that's meant to be there), add the missing
   property declaration to the class with an appropriate type, inferred
   from how it's used at line ${item.line} and elsewhere.
4. If the object is a \`stdClass\` or otherwise dynamic and the property is
   set dynamically at runtime, add a \`@property Type $name\` PHPDoc tag on
   the class instead of a real declaration.
5. Save the file(s) you changed.

If it's unclear whether this is a typo or a genuinely missing property (or
which type it should have), return status "needs_escalation" and explain
why in "note" instead of guessing.`
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
