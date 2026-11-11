// search_docs: the docs in heading-aware chunks, their embeddings, and a
// cosine scan in memory (coati-agent's src/coati_agent/index.py, ported
// line for line, so both labs search the same chunks).
//
// Why no Vectorize: the docs are a few hundred chunks, and a scan over them
// takes well under a millisecond, so the index ships inside the Worker as
// src/index.json (built by `npm run index`). Only the query is embedded at
// run time, through the Worker's Workers AI binding.
import type { Citation, ServerTool, ToolResult } from './tools.ts';

// Chosen in Task 5: bge-m3 reads 60,000 tokens and truncates past that;
// bge-base-en-v1.5 reads only 512, less than a long chunk.
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';

// About 300 to 800 tokens, at roughly four characters a token.
export const MIN_CHARS = 1200;
export const MAX_CHARS = 3200;
export const SEP = ' › ';

export type PageRow = { path: string; url: string; title: string; text: string };
export type Section = { heading: string; body: string };
export type Chunk = { id: string; url: string; title: string; heading: string; text: string };

// Python's len() counts code points; JavaScript's .length counts UTF-16
// units. Count code points, so chunks break where coati-agent's do.
const len = (s: string) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};
const fences = (s: string) => s.split('```').length - 1;

export const parseRows = (text: string): PageRow[] =>
  text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as PageRow);

export const embedText = (chunk: Chunk) => `${chunk.heading}\n\n${chunk.text}`;

/** Split a page at its h2 and h3 headings, never inside a code fence. */
export function sections(text: string, title: string): Section[] {
  const out: Section[] = [];
  let h2: string | null = null;
  let h3: string | null = null;
  const body: string[] = [];
  let inFence = false;

  const flush = () => {
    const joined = body.join('\n').trim();
    if (joined) out.push({ heading: [title, h2, h3].filter(Boolean).join(SEP), body: joined });
    body.length = 0;
  };

  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith('```')) inFence = !inFence;
    if (!inFence && line.startsWith('## ')) {
      flush();
      h2 = line.slice(3).trim();
      h3 = null;
    } else if (!inFence && line.startsWith('### ')) {
      flush();
      h3 = line.slice(4).trim();
    } else if (!inFence && line.startsWith('# ')) {
      continue; // the page title, already in every heading
    } else {
      body.push(line);
    }
  }
  flush();
  return out;
}

/** Blank-line separated blocks, keeping a code fence in one block. */
function paragraphs(body: string): string[] {
  const blocks: string[] = [];
  for (const block of body.split('\n\n')) {
    if (blocks.length && fences(blocks.at(-1)!) % 2 === 1) blocks[blocks.length - 1] += `\n\n${block}`;
    else blocks.push(block);
  }
  return blocks.map((b) => b.trim()).filter(Boolean);
}

/** Greedily join parts with blank lines, up to MAX_CHARS a piece. */
function pack(parts: string[]): string[] {
  const pieces: string[] = [];
  for (const part of parts) {
    if (pieces.length && len(pieces.at(-1)!) + 2 + len(part) <= MAX_CHARS) pieces[pieces.length - 1] += `\n\n${part}`;
    else pieces.push(part);
  }
  return pieces;
}

// The chunk's first heading is its label; later ones stay in the text.
const render = (heading: string, text: string, position: number) =>
  position === 0 ? text : `## ${heading.split(SEP).at(-1)}\n\n${text}`;

/** Chunks of about MIN_CHARS to MAX_CHARS, each starting at a heading. */
export function chunkPage(row: PageRow): Chunk[] {
  const pieces: [string, string][] = [];
  for (const section of sections(row.text, row.title)) {
    for (const text of pack(paragraphs(section.body))) pieces.push([section.heading, text]);
  }

  const groups: [string, string][][] = [];
  for (const [heading, text] of pieces) {
    const group = groups.at(-1);
    if (group) {
      const size = group.reduce((sum, [h, t], i) => sum + len(render(h, t, i)) + 2, 0);
      if (size + len(render(heading, text, 1)) <= MAX_CHARS || size < MIN_CHARS / 2) {
        group.push([heading, text]);
        continue;
      }
    }
    groups.push([[heading, text]]);
  }

  return groups.map((group, n) => ({
    id: `${row.path}#${n}`,
    url: row.url,
    title: row.title,
    heading: group[0]![0],
    text: group.map(([h, t], i) => render(h, t, i)).join('\n\n'),
  }));
}

// --- embeddings and search ---------------------------------------------------

export type Embed = (texts: string[]) => Promise<number[][]>;

/** Workers AI, through the Worker's AI binding (or wrangler's proxy of it). */
export function workersAiEmbed(ai: Ai, model: string = EMBEDDING_MODEL): Embed {
  return async (texts) => {
    const input = model.includes('bge-m3') ? { text: texts, truncate_inputs: true } : { text: texts };
    const output = (await ai.run(model as Parameters<Ai['run']>[0], input as never)) as { data?: number[][] };
    if (!Array.isArray(output.data) || output.data.length !== texts.length) {
      throw new Error(`${model} returned ${output.data?.length ?? 'no'} vectors for ${texts.length} texts`);
    }
    return output.data;
  };
}

export type DocsIndex = { model: string; dim: number; docs: string; chunks: Chunk[]; vectors: Float32Array[] };
export type SavedIndex = { model: string; dim: number; docs: string; chunks: Chunk[]; vectors: string[] };

function normalise(vector: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(vector);
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i]! /= norm;
  return out;
}

// Vectors are stored as base64 float32: exact, and a third of decimal JSON.
export function encodeVector(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function decodeVector(text: string): Float32Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export async function buildIndex(
  rows: PageRow[],
  embed: Embed,
  { batchSize = 8, model, docs = '' }: { batchSize?: number; model: string; docs?: string },
): Promise<DocsIndex> {
  const chunks = rows.flatMap(chunkPage);
  const vectors: Float32Array[] = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    for (const v of await embed(chunks.slice(i, i + batchSize).map(embedText))) vectors.push(normalise(v));
  }
  return { model, dim: vectors[0]?.length ?? 0, docs, chunks, vectors };
}

export const saveIndex = (index: DocsIndex): SavedIndex => ({ ...index, vectors: index.vectors.map(encodeVector) });

export function loadIndex(saved: SavedIndex): DocsIndex {
  if (saved.vectors.length !== saved.chunks.length) {
    throw new Error(`${saved.vectors.length} vectors for ${saved.chunks.length} chunks`);
  }
  const vectors = saved.vectors.map(decodeVector);
  if (vectors.some((v) => v.length !== saved.dim)) throw new Error(`a vector isn't ${saved.dim} long`);
  return { ...saved, vectors };
}

export function search(index: DocsIndex, query: ArrayLike<number>, k = 5): { chunk: Chunk; score: number }[] {
  const q = normalise(query);
  if (q.length !== index.dim) throw new Error(`a ${q.length}-long query for a ${index.dim}-long index`);
  const scored = index.vectors.map((v, i) => {
    let score = 0;
    for (let j = 0; j < v.length; j++) score += v[j]! * q[j]!;
    return { i, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(({ i, score }) => ({ chunk: index.chunks[i]!, score }));
}

// --- the tool ------------------------------------------------------------------

export function searchDocsTool(index: DocsIndex, embed: Embed, k = 5): ServerTool {
  return async ({ query, ...rest }): Promise<ToolResult> => {
    if (Object.keys(rest).length || typeof query !== 'string') {
      throw new TypeError('search_docs takes one string, query');
    }
    if (!query.trim()) return { content: 'Error: the query is empty. Say what to look for.', citations: [] };
    const [vector] = await embed([query.trim()]);
    const hits = search(index, vector!, k);
    const content = hits
      .map(({ chunk }, n) => `[${n + 1}] ${chunk.heading} (${chunk.url})\n${chunk.text}`)
      .join('\n\n');
    const citations: Citation[] = [];
    for (const { chunk } of hits) {
      if (!citations.some((c) => c.title === chunk.heading && c.url === chunk.url)) {
        citations.push({ title: chunk.heading, url: chunk.url });
      }
    }
    return { content, citations };
  };
}
