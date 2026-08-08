export const meta = {
  name: 'phpstan-missingtype-property',
  description: 'Auto-fix PHPStan missingType.property findings',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for identifier "missingType.property"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: missingType.property) in ${item.file} at line ${item.line}:

"${item.message}"

A class property has no declared type.

What to do:
1. Open ${item.file} and find the property declaration at/near line
   ${item.line}.
2. Determine the correct type by reading the constructor/setters that
   assign it and the getters/usages that read it.
3. Add a native PHP property type, e.g. \`private int $count;\` or
   \`private ?Foo $foo = null;\`. Keep the existing visibility modifier and
   default value.
4. If the true type cannot be expressed natively on this PHP version, add a
   \`/** @var Type */\` PHPDoc comment directly above the property instead.
5. Save the file.

If the property is assigned genuinely different types in different places
(and that looks intentional rather than a bug), return status
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
