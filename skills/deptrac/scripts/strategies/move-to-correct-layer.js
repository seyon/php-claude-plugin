export const meta = {
  name: 'deptrac-move-to-correct-layer',
  description: 'Fix Deptrac layer violations by moving a misplaced class into its correct layer',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { items: [{ class, dependencyClass, file, line, rule }], context: string }
// `context` is this project's recorded convention for this layer pair —
// typically which directory/namespace the class should move to, and how
// layers are detected (namespace prefix, directory collector, etc.).

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item, context) {
  return `Fix this Deptrac architecture violation using the "Move to correct layer" strategy.

Rule violated: "${item.rule}"
${item.class} (in ${item.file}:${item.line}) is currently placed in a layer
it doesn't belong to — its actual responsibility puts it closer to
${item.dependencyClass}'s layer, or a dependency on it wouldn't be a
violation.

Project-specific conventions for where this class belongs / how layers are
detected in this project:
${context ? context : '(none recorded yet — infer the correct target directory/namespace from the project\'s depfile.yaml layer collectors and existing directory structure before making assumptions)'}

What to do:
1. Confirm ${item.class}'s actual responsibility by reading ${item.file} —
   does it genuinely belong with ${item.dependencyClass}'s layer given what
   it does, not just where the violation says it currently lives?
2. Determine the correct target directory/namespace from the project
   conventions above (or from the project's depfile.yaml layer collectors
   if no convention is recorded yet).
3. Move the file to the correct location and update its namespace
   declaration to match.
4. Find every other file that references ${item.class} (via \`use\`
   statements or fully-qualified references) and update them to the new
   namespace.
5. Save every file you changed.

If moving ${item.class} would itself create new violations elsewhere, or
its correct layer is genuinely ambiguous, return status
"needs_escalation" and explain why in "note" instead of guessing.`
}

const results = await pipeline(
  args.items,
  (item) => agent(FIX_PROMPT(item, args.context), {
    model: 'claude-haiku-4-5',
    phase: 'Fix',
    label: `${item.file}:${item.line}`,
    schema: FIX_RESULT_SCHEMA,
  }),
  (result, item) => (result && result.status === 'fixed')
    ? result
    : agent(FIX_PROMPT(item, args.context), {
        phase: 'Escalate',
        label: `${item.file}:${item.line}`,
        schema: FIX_RESULT_SCHEMA,
      }),
)

return results
