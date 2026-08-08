export const meta = {
  name: 'phpinsights-forbidden-define',
  description: 'Auto-fix PHPInsights findings for ForbiddenDefineFunctions',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for insight
// "NunoMaduro\PhpInsights\Domain\Insights\ForbiddenDefineFunctions"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPInsights finding (ForbiddenDefineFunctions) in ${item.file} at line ${item.line}:

"${item.message}"

This file uses \`define('NAME', value)\` to declare a global constant,
which PHPInsights flags as an architecture violation (global constants
pollute the global namespace and can't be namespaced/autoloaded).

What to do:
1. Open ${item.file} and find the \`define(...)\` call at/near line
   ${item.line}.
2. If this constant clearly belongs to one specific class (used mostly/
   only in relation to that class), convert it to a class constant on
   that class instead (\`public const NAME = value;\` or
   \`final class ... { final public const NAME = value; }\` per this
   project's PHP version and conventions).
3. If it's used broadly across unrelated classes, define it as a
   namespaced PHP constant instead: \`namespace App\\Constants;\\n\\nconst
   NAME = value;\` in an appropriate file, or as a class constant on a
   dedicated constants/config class if that matches the project's existing
   conventions -- check for an existing pattern in the codebase first.
4. Update every usage of the constant (\`NAME\` or \`\\NAME\`) across the
   codebase to reference the new location (\`ClassName::NAME\` or the fully
   qualified namespaced constant with the appropriate \`use\` import).
5. Save every file you changed.

If the constant is used in a huge number of call sites across the
codebase (making this a large, risky rename) or you can't determine which
placement (class constant vs. namespaced constant) fits this project's
conventions, return status "needs_escalation" instead of guessing.`
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
