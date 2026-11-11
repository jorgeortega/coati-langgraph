// The eval set as a LangSmith dataset, run with LangSmith's evaluate() and
// coati-agent's three code checks, against coati-langgraph under wrangler dev.
// The scoreboard's numbers come from coati-agent's runner and its judge; this
// is the LangSmith view of the same cases (spec L6).
//
//   npx wrangler dev --port 8799 --var COATI_MODEL:claude-haiku-5-5   # in another shell
//   node --env-file=.dev.vars scripts/langsmith-evals.ts ../coati-agent/evals/questions.jsonl
import { readFileSync } from 'node:fs';
import { Client } from 'langsmith';
import { evaluate } from 'langsmith/evaluation';
import { type Expectations, docsLinksOk, knownPrices, pricesOk, toolOk } from '../src/checks.ts';

const DATASET = 'coati-evals';
const AGENT = process.env.COATI_AGENT_URL ?? 'http://localhost:8799/invoke';
const casesPath = process.argv[2];
if (!casesPath) throw new Error('usage: scripts/langsmith-evals.ts <questions.jsonl>');
if (!process.env.LANGSMITH_API_KEY) throw new Error('LANGSMITH_API_KEY is not set (node --env-file=.dev.vars)');

const root = new URL('..', import.meta.url);
const exportText = ['docs.jsonl', 'plans.jsonl', 'rules.txt', 'site-summary.md']
  .map((name) => readFileSync(new URL(`data/${name}`, root), 'utf8'))
  .join('');
const prices = knownPrices(exportText);

type Case = { id: string; question: string; expectations: Expectations & Record<string, unknown> };
const cases: Case[] = readFileSync(casesPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const client = new Client({ apiKey: process.env.LANGSMITH_API_KEY });
if (!(await client.hasDataset({ datasetName: DATASET }))) {
  const dataset = await client.createDataset(DATASET, { description: 'The coati agent eval set (coati-agent evals/questions.jsonl)' });
  await client.createExamples({
    datasetId: dataset.id,
    inputs: cases.map((c) => ({ question: c.question })),
    outputs: cases.map((c) => ({ id: c.id, ...c.expectations })),
  });
  console.log(`created dataset ${DATASET} with ${cases.length} examples`);
}

// What the checks read, as coati-agent's local target gives it: the answer,
// or `CALL name args` for a pending client tool.
async function target(inputs: Record<string, unknown>): Promise<{ output: string; model: string }> {
  const response = await fetch(AGENT, {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: inputs.question }] }),
  });
  if (!response.ok) throw new Error(`agent answered ${response.status}`);
  const body = (await response.json()) as { answer?: string; pending?: { name: string; args: unknown }; model: string };
  const output = body.pending ? `CALL ${body.pending.name} ${JSON.stringify(body.pending.args)}` : (body.answer ?? '');
  return { output, model: body.model };
}

type Args = { outputs: Record<string, unknown>; referenceOutputs?: Record<string, unknown> };
const text = (a: Args) => String(a.outputs.output ?? '');
const evaluators = [
  (a: Args) => ({ key: 'check_readiness_use', score: toolOk(text(a), (a.referenceOutputs ?? {}) as Expectations) }),
  (a: Args) => ({ key: 'published_prices', score: pricesOk(text(a), prices) }),
  (a: Args) => ({ key: 'docs_links', score: docsLinksOk(text(a)) }),
];

const first = await target({ question: 'Hi' });
const results = await evaluate(target, {
  data: DATASET,
  evaluators,
  client,
  experimentPrefix: `langgraph-${first.model}`,
  maxConcurrency: 2,
  metadata: { model: first.model, checks: 'coati-agent code checks' },
});

const totals: Record<string, [number, number]> = {};
for (const row of results.results) {
  for (const r of row.evaluationResults.results) {
    const t = (totals[r.key] ??= [0, 0]);
    t[r.score ? 0 : 1]++;
  }
}
console.log(`experiment ${results.experimentName}`);
for (const [key, [pass, fail]] of Object.entries(totals)) console.log(`  ${key.padEnd(22)} ${pass}/${pass + fail}`);
