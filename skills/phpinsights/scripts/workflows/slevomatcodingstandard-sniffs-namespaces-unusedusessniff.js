export const meta = {
  name: 'phpinsights-unused-uses',
  description: 'Auto-fix PHPInsights findings for SlevomatCodingStandard.Sniffs.Namespaces.UnusedUsesSniff',
  phases: [
    { title: 'Fix', detail: 'attempt fix with Haiku' },
    { title: 'Escalate', detail: 'retry unresolved items with the default model' },
  ],
}

// args: array of { file, line, message } for insight
// "SlevomatCodingStandard\Sniffs\Namespaces\UnusedUsesSniff"

const FIX_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['fixed', 'needs_escalation'] },
    note: { type: 'string', description: 'One sentence: what was changed, or why it could not be fixed confidently.' },
  },
  required: ['status', 'note'],
}

function FIX_PROMPT(item) {
  return `Fix this PHPInsights finding (UnusedUsesSniff) in ${item.file} at line ${item.line}:

"${item.message}"

A \`use\` import statement in this file is not referenced anywhere in the
file's code.

What to do:
1. Open ${item.file} and find the \`use\` statement at/near line ${item.line}.
2. Search the rest of the file for any reference to the imported class,
   interface, trait, function, or constant (as a plain name, in a docblock
   type, or in an \`instanceof\`/\`extends\`/\`implements\`/attribute).
3. If it is genuinely unused, delete that \`use\` line entirely (including
   its trailing newline) — do not just comment it out.
4. If the import is aliased (\`use Foo\\Bar as Baz;\`) check for the alias
   name \`Baz\` being used, not just \`Bar\`.
5. Save the file.

If the import is referenced only inside a docblock/PHPDoc type annotation
that isn't itself checked by static analysis in this project (so removing
it could silently drop useful documentation), still remove it — PHPDoc
uses count as usage for this sniff, so if the sniff flagged it, treat it as
verified unused and remove it. If you find any genuine usage anywhere in
the file, return status "needs_escalation" instead of deleting it.`
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
