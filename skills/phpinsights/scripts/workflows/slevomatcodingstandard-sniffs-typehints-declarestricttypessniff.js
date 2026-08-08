export const meta = {
  name: 'phpinsights-declare-strict-types',
  description: 'Auto-fix PHPInsights findings for SlevomatCodingStandard.Sniffs.TypeHints.DeclareStrictTypesSniff',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for insight
// "SlevomatCodingStandard\Sniffs\TypeHints\DeclareStrictTypesSniff"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPInsights finding (DeclareStrictTypesSniff) in ${item.file}:

"${item.message}"

This PHP file is missing (or has a misplaced/incorrectly formatted)
\`declare(strict_types=1);\` statement.

What to do:
1. Open ${item.file} and find the \`<?php\` opening tag.
2. Ensure the very first statement after \`<?php\` is exactly
   \`declare(strict_types=1);\` on its own line, followed by a blank line
   before anything else (namespace declaration, use statements, etc.).
3. If a \`declare(strict_types=1);\` already exists but is positioned wrong
   (e.g. after the namespace/use statements) or formatted differently
   (spacing, missing semicolon), move/fix it rather than adding a
   duplicate.
4. Do not add this to files that aren't plain PHP class/script files (e.g.
   skip if the file is a template with mixed HTML/PHP where a leading
   declare statement would break output — return "needs_escalation"
   instead for those).
5. Save the file.

This is purely additive and should never change runtime behavior beyond
enabling strict type checking — only return "needs_escalation" if adding
it would put PHP code after non-PHP output (rare, only in template-style
files).`
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
