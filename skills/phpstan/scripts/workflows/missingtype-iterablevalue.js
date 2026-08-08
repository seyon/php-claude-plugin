export const meta = {
  name: 'phpstan-missingtype-iterablevalue',
  description: 'Auto-fix PHPStan missingType.iterableValue findings',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for identifier "missingType.iterableValue"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPStan finding (identifier: missingType.iterableValue) in ${item.file} at line ${item.line}:

"${item.message}"

This means an iterable (array) property, parameter, or return value has no
declared value type — PHPStan can see it's an array/iterable but not what's
inside it.

What to do:
1. Open ${item.file} and find the declaration at/near line ${item.line}
   (a property, parameter, or return type).
2. Determine the actual element type by reading how the array is built and
   used nearby in the same file/class: look at what gets pushed/assigned
   into it (e.g. \`$this->items[] = new Foo()\` implies \`Foo[]\`), and how
   elements are consumed by callers (type hints, method calls on elements).
3. Add a precise PHPDoc annotation directly above the declaration, matching
   what's being documented:
   - Property: \`/** @var Foo[] */\` above \`private array $items;\`
   - Parameter: add \`@param Foo[] $items\` to the method's docblock (create
     one if it doesn't exist).
   - Return: add \`@return Foo[]\` to the method's docblock.
4. Prefer the most specific correct type you can determine
   (\`Foo[]\`, \`array<int, Foo>\`, \`list<Foo>\`, \`array<string, Foo>\` for
   associative arrays keyed by string). Only use \`mixed[]\` if the element
   type genuinely cannot be determined from the surrounding code — and in
   that case return "needs_escalation" instead of guessing, since a wrong
   type annotation is worse than none.
5. Do not change the array's actual (native) type — this is a PHPDoc-only
   fix; no runtime behavior should change.
6. Save the file.

If the element type is ambiguous or the array holds mixed/heterogeneous
types, return status "needs_escalation" and explain why in "note" instead
of guessing.`
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
