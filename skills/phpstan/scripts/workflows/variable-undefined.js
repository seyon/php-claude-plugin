export const meta = {
  name: 'phpstan-variable-undefined',
  description: 'Auto-fix PHPStan variable.undefined findings',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for identifier "variable.undefined"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: variable.undefined) in ${item.file} at line ${item.line}:

"${item.message}"

A variable is used at line ${item.line} that isn't guaranteed to be defined
on every code path leading there (e.g. only assigned inside one branch of
an if/else, or inside a loop that might not execute).

What to do:
1. Trace back from line ${item.line} to find every code path that reaches
   it, and identify the path(s) where the variable is never assigned.
2. Fix it by ensuring the variable is always assigned before use — the
   usual fix is adding a default assignment before the conditional/loop
   (e.g. \`$result = null;\` before an \`if\` that only sometimes sets it),
   not by wrapping the usage in \`isset()\` unless the variable is
   legitimately meant to be optional at that point.
3. Pick a sensible default value based on how the variable is used
   afterward (null, empty array, 0, empty string, etc.) — if a safe default
   isn't obvious, don't guess.
4. Save the file.

If the variable is legitimately optional and the surrounding logic already
handles absence correctly elsewhere, or a safe default can't be determined,
return status "needs_escalation" and explain why in "note".`
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
