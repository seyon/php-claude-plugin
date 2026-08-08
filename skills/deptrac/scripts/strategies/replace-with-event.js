export const meta = {
  name: 'deptrac-replace-with-event',
  description: 'Fix Deptrac layer violations by replacing a direct call with an event/message',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { items: [{ class, dependencyClass, file, line, rule }], context: string }
// `context` is this project's recorded convention for this layer pair —
// typically the event dispatcher/bus mechanism and where event/listener
// classes conventionally live.

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item, context) {
  return `Fix this Deptrac architecture violation using the "Replace direct call with event/message" strategy.

Rule violated: "${item.rule}"
${item.class} calls into ${item.dependencyClass} (${item.file}:${item.line}), which its layer is not allowed to depend on. This strategy applies when that call is a fire-and-forget side effect (${item.class} doesn't need a return value back from ${item.dependencyClass}).

Project-specific conventions for eventing in this project:
${context ? context : '(none recorded yet — look for an existing event dispatcher/bus and event/listener directory convention in the project before inventing one)'}

What to do:
1. Read ${item.file} around line ${item.line} and confirm the call to
   ${item.dependencyClass} is genuinely fire-and-forget — ${item.class}
   does not use a return value from it afterward. If it does use a return
   value, this strategy doesn't apply (see below).
2. Define an event/message class representing what happened (named for the
   business fact, e.g. \`OrderPlaced\`, not for the technical action),
   placed in ${item.class}'s own layer per the conventions above.
3. In ${item.class}, replace the direct call to ${item.dependencyClass}
   with dispatching the new event via the project's event
   dispatcher/bus (per the conventions above).
4. Move the logic that used to run inside the call to
   ${item.dependencyClass} into a new event listener/handler class living
   in ${item.dependencyClass}'s layer, subscribed to the new event via the
   project's usual listener registration mechanism.
5. Save every file you changed.

If the call requires a return value that ${item.class} depends on, or the
project's eventing mechanism can't be determined from the context and
surrounding code, return status "needs_escalation" and explain why in
"note" instead of forcing this strategy where it doesn't fit.`
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
