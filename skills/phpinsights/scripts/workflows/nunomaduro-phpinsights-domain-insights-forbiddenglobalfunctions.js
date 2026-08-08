export const meta = {
  name: 'phpinsights-forbidden-global-functions',
  description: 'Auto-fix PHPInsights findings for ForbiddenGlobalFunctions',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for insight
// "NunoMaduro\PhpInsights\Domain\Insights\ForbiddenGlobalFunctions"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPInsights finding (ForbiddenGlobalFunctions) in ${item.file} at line ${item.line}:

"${item.message}"

This file declares a plain global \`function name(...) { ... }\` outside of
any class, which PHPInsights flags as an architecture violation (global
functions can't be autoloaded per-class, aren't easily mockable/testable,
and pollute the global namespace).

What to do:
1. Open ${item.file} and find the global function declared at/near line
   ${item.line}.
2. Determine which existing class this function is conceptually related to
   (based on its name and what it operates on), or whether it's a generic
   utility with no natural home.
3. If it clearly belongs with an existing class: move it there as a
   \`public static function\` (or a regular method if it needs instance
   state) with the same name and signature.
4. If it's a generic, stateless utility with no natural existing class:
   create a dedicated final class named after its responsibility (e.g.
   \`StringHelper\`, matching this project's existing naming conventions
   for similar utility classes if any exist) and add it there as a
   \`public static function\`.
5. Update every call site of the old global function name to call the new
   static method instead (\`ClassName::functionName(...)\`), adding the
   necessary \`use\` import.
6. Delete the original global function declaration.
7. Save every file you changed.

If the function is called from many unrelated places across the codebase
(making this a large, risky rename) or you can't determine a sensible
class to place it in, return status "needs_escalation" instead of
guessing.`
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
