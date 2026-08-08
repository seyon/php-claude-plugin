export const meta = {
  name: 'symfony-log-cluster',
  description: 'Cluster and summarize raw Symfony log entries via Haiku',
  phases: [
    { title: 'Cluster', detail: 'batch raw entries through Haiku' },
  ],
}

// args: { entries: [{ timestamp, channel, level, message, context? }], question: string }
//
// Raw log entries are usually too numerous and noisy (near-duplicate
// messages differing only by an ID or timestamp) to hand an expensive
// model directly. This batches them through Haiku to produce a compact
// cluster list instead -- the expensive step (answering the actual
// question) then only ever reads this summary, never the raw entries.

const BATCH_SIZE = 60

const CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          level: { type: 'string' },
          summary: { type: 'string', description: 'One sentence: what is going wrong.' },
          representativeMessage: { type: 'string', description: 'One verbatim, clearest example message from this cluster.' },
          count: { type: 'number', description: 'How many entries in this batch belong to this cluster.' },
          firstSeen: { type: 'string' },
          lastSeen: { type: 'string' },
          relevantToQuestion: { type: 'boolean', description: 'Whether this cluster plausibly relates to the given question -- be inclusive if unsure.' },
        },
        required: ['level', 'summary', 'representativeMessage', 'count', 'firstSeen', 'lastSeen', 'relevantToQuestion'],
      },
    },
  },
  required: ['clusters'],
}

function CLUSTER_PROMPT(batch) {
  return `You are triaging a batch of Symfony application log entries (JSON below).
The problem/question being investigated is: "${args.question}"

Entries:
${JSON.stringify(batch, null, 2)}

Group these entries into clusters of the same underlying issue -- entries
with the same exception class or the same message template differing only
by variable parts (IDs, timestamps, values) belong in the same cluster.
For each cluster report: level, a one-sentence summary of what's going
wrong, one representative verbatim message (pick the clearest example, keep
it as-is, don't paraphrase it), how many entries in this batch belong to
it, the first and last timestamp seen for it in this batch, and whether it
plausibly relates to the given question (true/false -- be inclusive if
unsure, the next step will judge relevance more carefully).

Do not invent information that isn't present in the entries. If a batch has
no entries, return an empty clusters array.`
}

const batches = []
for (let i = 0; i < args.entries.length; i += BATCH_SIZE) {
  batches.push(args.entries.slice(i, i + BATCH_SIZE))
}

const results = await pipeline(
  batches,
  (batch) => agent(CLUSTER_PROMPT(batch), {
    model: 'claude-haiku-4-5',
    phase: 'Cluster',
    schema: CLUSTER_SCHEMA,
  }),
)

return results.filter(Boolean).flatMap((r) => r.clusters)
