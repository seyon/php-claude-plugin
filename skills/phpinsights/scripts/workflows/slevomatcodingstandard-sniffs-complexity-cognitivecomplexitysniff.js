export const meta = {
  name: 'phpinsights-cognitive-complexity',
  description: 'Auto-fix PHPInsights findings for SlevomatCodingStandard.Sniffs.Complexity.CognitiveComplexitySniff',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for insight
// "SlevomatCodingStandard\Sniffs\Complexity\CognitiveComplexitySniff"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPInsights finding (CognitiveComplexitySniff) in ${item.file} at line ${item.line}:

"${item.message}"

The method/function at/near line ${item.line} is too hard to read at a
glance -- typically deep nesting (if inside if inside loop inside try) is
the biggest contributor, more so than raw branch count.

What to do, in order of preference:
1. Reduce nesting depth first: convert nested \`if\` blocks into guard
   clauses with early \`return\`/\`continue\`/\`throw\` wherever that's
   behavior-preserving, so the "happy path" isn't indented inside multiple
   conditions.
2. Extract deeply nested loop bodies or try/catch blocks into their own
   well-named private method.
3. Simplify compound boolean conditions (\`&&\`/\`||\` chains) by extracting
   them into a well-named private method or local variable that states
   what's being checked.
4. After refactoring, the function's behavior must be 100% identical for
   every input -- this is a structure-only change.
5. Save the file(s) you changed.

If the function's logic is too intertwined to safely restructure without
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
