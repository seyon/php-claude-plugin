export const meta = {
  name: 'phpstan-class-notfound',
  description: 'Auto-fix PHPStan class.notFound findings',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for identifier "class.notFound"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: class.notFound) in ${item.file} at line ${item.line}:

"${item.message}"

Code references a class/interface/enum that PHPStan cannot find.

What to do, in this order:
1. Search the codebase (and vendor/) for a class with this exact short
   name to find its real, fully-qualified namespace.
2. If found and the file at ${item.file} is simply missing the \`use\`
   import (or has a typo'd namespace in an existing \`use\` statement), add
   or fix the \`use Fully\\Qualified\\ClassName;\` import at the top of the
   file. Do NOT change the reference at line ${item.line} itself if only
   the import was missing.
3. If the class name at line ${item.line} itself has a typo (compare
   against the real class name you found), fix the typo at the usage site
   instead.
4. If no matching class exists anywhere in the codebase or vendor/, this is
   likely a missing Composer dependency or a class that genuinely needs to
   be created — do NOT invent a new class blindly. Return status
   "needs_escalation" and explain what's missing in "note".
5. Save the file(s) you changed.`
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
