export const meta = {
  name: 'phpstan-missingtype-return',
  description: 'Auto-fix PHPStan missingType.return findings',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for identifier "missingType.return"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: missingType.return) in ${item.file} at line ${item.line}:

"${item.message}"

A method/function has no declared return type.

What to do:
1. Open ${item.file} and find the method/function signature at/near line
   ${item.line}.
2. Read every \`return\` statement in the function body to determine every
   possible returned type (including implicit \`return;\` / falling off the
   end, which means \`void\` or nullable).
3. Add a native PHP return type hint after the parameter list, e.g.
   \`function foo(): int\`, \`function foo(): ?Foo\`, \`function foo(): void\`.
   Use \`self\`/\`static\` when returning the current instance where
   appropriate.
4. If the true return type cannot be expressed natively on this PHP version
   (union types on PHP < 8.0, or a generic/template return type), add a
   \`@return Type\` tag to the method's PHPDoc block instead (create the
   docblock if missing), and leave the native signature as-is.
5. Save the file.

If different branches return genuinely incompatible types and it's unclear
which is intended, or the method is abstract/interface-declared and the
concrete contract is ambiguous, return status "needs_escalation" and
explain why in "note" instead of guessing.`
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
