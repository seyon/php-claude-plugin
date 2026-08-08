export const meta = {
  name: 'deptrac-extract-shared-abstraction',
  description: 'Fix Deptrac layer violations by extracting a shared type both layers may depend on',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { items: [{ class, dependencyClass, file, line, rule }], context: string }
// `context` is this project's recorded convention for this layer pair —
// typically the name/namespace of the shared/kernel layer both sides are
// allowed to depend on.

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item, context) {
  return `Fix this Deptrac architecture violation using the "Extract shared abstraction" strategy.

Rule violated: "${item.rule}"
${item.class} depends on ${item.dependencyClass} (${item.file}:${item.line}), but what it actually needs is a concept both layers legitimately share (e.g. a value object, DTO, enum, or plain data type) — neither layer should depend on the other for it.

Project-specific conventions for the shared/kernel layer both sides may
depend on:
${context ? context : '(none recorded yet — look for an existing shared/common/kernel namespace in the project before creating a new one)'}

What to do:
1. Read ${item.file} around line ${item.line} and identify the specific
   concept (type/value/constant) ${item.class} needs from
   ${item.dependencyClass} — it should be something with no real behavior
   tied to either layer (data shape, enum, simple value object), not
   business logic.
2. Extract that concept into a new class/interface/enum placed in the
   project's shared/kernel layer per the conventions above.
3. Update ${item.dependencyClass}'s layer to also reference the extracted
   shared type where it previously defined the concept directly (if
   applicable).
4. Update ${item.class} to depend on the newly extracted shared type
   instead of on ${item.dependencyClass}.
5. Save every file you changed.

If what ${item.class} needs isn't a genuinely shared, behavior-free concept
(i.e. it actually needs real logic that only makes sense in
${item.dependencyClass}'s layer), this strategy doesn't apply — return
status "needs_escalation" and say so in "note" rather than forcing an
extraction that doesn't fit.`
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
