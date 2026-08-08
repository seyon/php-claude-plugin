export const meta = {
  name: 'phpstan-argument-type',
  description: 'Auto-fix PHPStan argument.type findings',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for identifier "argument.type"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: argument.type) in ${item.file} at line ${item.line}:

"${item.message}"

A function/method call passes an argument whose type doesn't match the
declared parameter type. The message names the expected type and the given
type — parse both from it.

What to do, in this order of preference:
1. Fix the call site at line ${item.line}: convert/cast/adjust the value
   being passed so it actually matches the expected type (e.g. cast
   \`(int) $x\`, unwrap a nullable with a prior null-check, pass \`$foo->id\`
   instead of \`$foo\`, etc.) — pick whichever concretely produces the
   expected type given what's available at the call site.
2. If the value at the call site can genuinely be null/absent in a way the
   callee should handle, and changing the call site isn't right, add a
   guard (early return / \`if\` check) before the call instead of forcing a
   cast that could hide a real bug.
3. Only change the callee's declared parameter type (widen it) if the
   callee's type declaration is clearly the actual bug — i.e. the value
   being passed is legitimately valid and multiple call sites need this
   type. Do this rarely and only when confident.
4. Save the file(s) you changed.

Do not silence the error with \`@phpstan-ignore\`. If you can't determine
which of the value or the declared type is actually wrong, return status
"needs_escalation" and explain why in "note".`
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
