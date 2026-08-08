export const meta = {
  name: 'deptrac-dependency-inversion',
  description: 'Fix Deptrac layer violations by extracting a port interface and inverting the dependency',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: { items: [{ class, dependencyClass, file, line, rule }], context: string }
// `context` is this project's recorded convention for this layer pair (from
// the Layer Map "Notes" column) — e.g. where ports/interfaces live, and how
// dependency injection is wired. Without it, generic advice; with it,
// Haiku gets project-exact instructions.

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item, context) {
  return `Fix this Deptrac architecture violation using the "Dependency Inversion" strategy.

Rule violated: "${item.rule}"
${item.class} depends on ${item.dependencyClass}, which its layer is not allowed to depend on (found in ${item.file}:${item.line}).

Project-specific conventions for this layer pair:
${context ? context : '(none recorded yet — infer conventions from the surrounding codebase before making assumptions)'}

What to do:
1. Read ${item.file} around line ${item.line} and determine exactly what
   ${item.class} needs from ${item.dependencyClass} — which method(s) or
   behavior, not the concrete implementation.
2. Define an interface (port) for that behavior, named after the
   capability it provides (e.g. \`PaymentGatewayInterface\`, not
   \`StripeGatewayInterface\`), placed according to the project conventions
   above. If no convention is recorded, place it in the same
   namespace/layer as ${item.class}.
3. Make ${item.dependencyClass} implement that interface (add
   \`implements TheNewInterface\`) — it can stay in its current layer/file.
4. Change ${item.class} to depend on the new interface instead of
   ${item.dependencyClass} directly: update the type hint on the
   constructor parameter / property / method parameter, and update any
   \`use\` import accordingly.
5. Wire the concrete ${item.dependencyClass} to the interface using the
   project's dependency injection mechanism described above (e.g. a
   service container binding, autowiring config, or factory) — do not
   instantiate ${item.dependencyClass} directly inside ${item.class}.
6. Save every file you changed.

If you can't determine what ${item.class} actually needs from the
dependency, or the project's DI wiring convention isn't clear enough from
the context above and the surrounding code, return status
"needs_escalation" instead of guessing.`
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
