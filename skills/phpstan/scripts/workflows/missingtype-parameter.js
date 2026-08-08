export const meta = {
  name: 'phpstan-missingtype-parameter',
  description: 'Auto-fix PHPStan missingType.parameter findings',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for identifier "missingType.parameter"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: missingType.parameter) in ${item.file} at line ${item.line}:

"${item.message}"

A method/function parameter has no declared type.

What to do:
1. Open ${item.file} and find the parameter named in the message, in the
   method/function signature at/near line ${item.line}.
2. Determine the correct type by reading how the parameter is used inside
   the function body (method calls on it, comparisons, arithmetic, string
   operations) and how callers invoke this method with it.
3. Add a native PHP type hint directly in the signature, e.g.
   \`function foo(int $x)\` or \`function foo(?Foo $x = null)\` for a
   nullable/optional parameter.
4. If the true type cannot be expressed as a native hint on this PHP
   version (e.g. a union type on PHP < 8.0, or a generic/template type),
   add a \`@param Type $name\` tag to the method's PHPDoc block instead
   (create the docblock if missing), and leave the native signature as-is.
5. Preserve the parameter's existing default value (if any) and its
   position/order in the signature exactly.
6. Save the file.

If the parameter is used inconsistently (different callers imply different
types) or the correct type is genuinely unclear, return status
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
