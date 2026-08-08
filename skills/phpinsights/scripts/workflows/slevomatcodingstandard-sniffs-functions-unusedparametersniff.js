export const meta = {
  name: 'phpinsights-unused-parameter',
  description: 'Auto-fix PHPInsights findings for SlevomatCodingStandard.Sniffs.Functions.UnusedParameterSniff',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for insight
// "SlevomatCodingStandard\Sniffs\Functions\UnusedParameterSniff"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPInsights finding (UnusedParameterSniff) in ${item.file} at line ${item.line}:

"${item.message}"

A function/method parameter is never used in its body.

What to do:
1. Open ${item.file} and find the function/method signature at/near line
   ${item.line}, and the parameter named in the message.
2. Determine whether this parameter must stay for signature-compatibility
   reasons: it's required by an interface/parent class the method
   implements/overrides, it's a framework callback signature (e.g. event
   listener, middleware), or removing it would change the function's
   arity in a way that breaks callers passing positional arguments after
   it.
3. If it must stay for compatibility: prefix the parameter name with an
   underscore only if this project's conventions do that (check other
   similarly-unused-but-required parameters in the codebase first);
   otherwise leave it as-is and return "needs_escalation" — don't silently
   rename per a convention you haven't confirmed exists in this project.
4. If it's safe to remove (not required by any interface/parent, and no
   caller relies on positional arguments after it): remove the parameter
   entirely, and update every call site accordingly.
5. Save the file(s) you changed.

If you're not certain whether removing the parameter is safe (interface
compliance, callback contracts, positional-argument callers), return
status "needs_escalation" instead of guessing.`
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
