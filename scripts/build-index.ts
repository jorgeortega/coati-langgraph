// Chunk and embed the docs into src/index.json, and embed the five search
// test questions into test/fixtures/queries.json, with the same model.
//
//   npm run index -- --dry   # chunk only: counts and sizes, no Workers AI call
//   npm run index            # embed through wrangler's proxy of the AI binding
//
// The embedding runs on the Cloudflare account wrangler is logged in to.
// It is about 35,000 input tokens (the docs are about 140,000 characters).
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { checkExport, type Manifest } from '../src/export.ts';
import { EMBEDDING_MODEL, buildIndex, chunkPage, embedText, encodeVector, parseRows, saveIndex, workersAiEmbed } from '../src/search.ts';

const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const kib = (n: number) => `${(n / 1024).toFixed(0)} KiB`;

const manifest = JSON.parse(read('data/manifest.json')) as Manifest;
const files = await checkExport(
  Object.fromEntries(Object.keys(manifest.files).map((name) => [name, read(`data/${name}`)])),
  manifest,
);
const rows = parseRows(files['docs.jsonl']!);
const docs = manifest.files['docs.jsonl']!;
const cases = JSON.parse(read('test/fixtures/search-cases.json')) as { id: string; question: string }[];

const chunks = rows.flatMap(chunkPage);
const chars = chunks.reduce((n, c) => n + embedText(c).length, 0) + cases.reduce((n, c) => n + c.question.length, 0);
console.log(`${rows.length} pages, ${chunks.length} chunks, ${chars} characters to embed (about ${Math.round(chars / 4)} tokens)`);

if (process.argv.includes('--dry')) process.exit(0);

const { getPlatformProxy } = await import('wrangler');
const proxy = await getPlatformProxy<{ AI: Ai }>();
try {
  const embed = workersAiEmbed(proxy.env.AI, EMBEDDING_MODEL);
  const index = await buildIndex(rows, embed, { batchSize: 8, model: EMBEDDING_MODEL, docs });
  const vectors = await embed(cases.map((c) => c.question));
  const queries = {
    model: EMBEDDING_MODEL,
    docs,
    queries: cases.map((c, i) => ({ id: c.id, question: c.question, vector: encodeVector(Float32Array.from(vectors[i]!)) })),
  };
  const text = `${JSON.stringify(saveIndex(index))}\n`;
  writeFileSync(new URL('src/index.json', root), text);
  writeFileSync(new URL('test/fixtures/queries.json', root), `${JSON.stringify(queries, null, 2)}\n`);
  console.log(`src/index.json: ${index.chunks.length} chunks × ${index.dim} dimensions, ${kib(text.length)}, ${kib(gzipSync(text).length)} gzipped`);
} finally {
  await proxy.dispose();
}
