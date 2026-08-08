export const meta = {
  name: 'phpinsights-cyclomatic-complexity',
  description: 'Auto-fix PHPInsights findings for CyclomaticComplexityIsHigh',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for insight
// "NunoMaduro\PhpInsights\Domain\Insights\CyclomaticComplexityIsHigh"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPInsights finding (CyclomaticComplexityIsHigh) in ${item.file} at line ${item.line}:

"${item.message}"

The method/function starting at/near line ${item.line} has too many
independent execution paths (too many if/else, switch cases, loops,
&&/||, catch blocks combined in one function).

What to do, in order of preference:
1. Read the full function body and identify self-contained chunks of
   logic (e.g. a validation block, a single \`switch\`/\`match\` arm's worth
   of logic, a loop body) that can be extracted into their own
   well-named private method, each handling one responsibility.
2. Prefer early returns/guard clauses over deeply nested if/else chains —
   flatten \`if (cond) { ... } else { ... }\` into
   \`if (!cond) { return ...; } ...\` where that doesn't change behavior.
3. If the function branches heavily on a type/enum/string, consider
   replacing a long if/elseif chain with a lookup table (array mapping)
   or \`match\` expression if that's cleaner and behavior-preserving.
4. After refactoring, the original method's logic must be 100%
   behaviorally identical for every input — this is a structure-only
   change, not a logic change.
5. Save the file(s) you changed.

This requires understanding the function's actual logic, not a mechanical
pattern — if the function is too intertwined to safely split without
risking a behavior change, return status "needs_escalation" instead of
attempting a risky refactor.`
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
