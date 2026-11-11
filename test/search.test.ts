// Chunking the docs, ranking chunks, and the search_docs tool, with fake
// vectors and no network (coati-agent's tests/test_index.py, ported).
import { describe, expect, it } from 'vitest';
import { EXPORT } from '../src/prompt.ts';
import {
  MAX_CHARS,
  MIN_CHARS,
  type Embed,
  type PageRow,
  buildIndex,
  chunkPage,
  embedText,
  loadIndex,
  parseRows,
  saveIndex,
  search,
  searchDocsTool,
  sections,
} from '../src/search.ts';

const page = (text: string, title = 'Keys', url = 'https://docs.latitude10.tech/keys'): PageRow => ({ path: 'keys.md', url, title, text });
const para = (n: number, word = 'alpha') => Array(n).fill(word).join(' ');

describe('sections', () => {
  it('split at h2 and h3 and keep the path', () => {
    const text = '# Keys\n\nIntro.\n\n## Project keys\n\nA.\n\n### Rotating\n\nB.\n\n## Agent keys\n\nC.';
    expect(sections(text, 'Keys').map((s) => [s.heading, s.body])).toEqual([
      ['Keys', 'Intro.'],
      ['Keys › Project keys', 'A.'],
      ['Keys › Project keys › Rotating', 'B.'],
      ['Keys › Agent keys', 'C.'],
    ]);
  });

  it('never start inside a code fence', () => {
    const got = sections('## Push\n\n```yaml\n## not a heading\nrun: x\n```\n\nAfter.', 'CI');
    expect(got).toHaveLength(1);
    expect(got[0]!.body).toContain('## not a heading');
  });
});

describe('chunks', () => {
  it('pack small sections together', () => {
    const text = [0, 1, 2, 3].map((i) => `## S${i}\n\n${para(30)}`).join('\n\n');
    const chunks = chunkPage(page(text));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe('Keys › S0');
  });

  it('split a long section on paragraphs and lose nothing', () => {
    const paragraphs = ['red', 'green', 'blue', 'cyan', 'gold', 'pink'].map((w) => para(120, w));
    const chunks = chunkPage(page(`## Long\n\n${paragraphs.join('\n\n')}`));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= MAX_CHARS)).toBe(true);
    const joined = chunks.map((c) => c.text).join('\n\n');
    for (const p of paragraphs) expect(joined).toContain(p);
  });

  it('carry their page and heading for embedding', () => {
    const [chunk] = chunkPage(page(`## Project keys\n\n${para(20)}`));
    expect(chunk!.url).toBe('https://docs.latitude10.tech/keys');
    expect(embedText(chunk!).startsWith('Keys › Project keys\n\n')).toBe(true);
  });

  it('stay within bounds on the real docs', () => {
    const rows = parseRows(EXPORT.files['docs.jsonl']!);
    const chunks = rows.flatMap(chunkPage);
    expect(new Set(chunks.map((c) => c.url))).toEqual(new Set(rows.map((r) => r.url)));
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
    expect(chunks.filter((c) => c.text.length > MAX_CHARS && c.text.includes('\n\n')).map((c) => c.id)).toEqual([]);
    // Only a page's last chunk may be short (nothing left to pack it with).
    expect(chunks.filter((c) => c.text.length < MIN_CHARS).length).toBeLessThanOrEqual(rows.length);
  });
});

// Maps each text to a fixed vector by keyword, and counts its calls.
function fakeEmbedder() {
  const keys = ['sso', 'price', 'mcp'];
  const batches: string[][] = [];
  const embed: Embed = async (texts) => {
    batches.push([...texts]);
    return texts.map((t) => keys.map((k) => t.toLowerCase().split(k).length - 1 + 0.01));
  };
  return { embed, batches };
}

const twoPages = [
  page('## Single sign-on\n\nSSO with OpenID Connect. SSO SSO.', 'Enterprise', 'u/sso'),
  page('## Prices\n\nThe price of Pro. price.', 'Pricing', 'u/price'),
];

describe('the index', () => {
  it('embeds in batches and keeps the order', async () => {
    const { embed, batches } = fakeEmbedder();
    const index = await buildIndex(twoPages, embed, { batchSize: 1, model: 'fake' });
    expect(batches).toHaveLength(2);
    expect(index.chunks.map((c) => c.url)).toEqual(['u/sso', 'u/price']);
  });

  it('ranks by cosine similarity', async () => {
    const index = await buildIndex(twoPages, fakeEmbedder().embed, { batchSize: 1, model: 'fake' });
    const hits = search(index, [1, 0, 0], 2);
    expect(hits.map((h) => h.chunk.url)).toEqual(['u/sso', 'u/price']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(search(index, [1, 0, 0], 1)[0]!.chunk.url).toBe('u/sso');
  });

  it('survives a save and load', async () => {
    const index = await buildIndex(twoPages, fakeEmbedder().embed, { batchSize: 1, model: 'fake' });
    const loaded = loadIndex(JSON.parse(JSON.stringify(saveIndex(index))));
    expect(loaded.chunks).toEqual(index.chunks);
    expect(loaded.model).toBe('fake');
    for (const [i, v] of index.vectors.entries()) expect([...loaded.vectors[i]!]).toEqual([...v]);
  });

  it('refuses vectors that do not match the chunks', async () => {
    const saved = saveIndex(await buildIndex(twoPages, fakeEmbedder().embed, { batchSize: 1, model: 'fake' }));
    expect(() => loadIndex({ ...saved, chunks: saved.chunks.slice(1) })).toThrow('2 vectors for 1 chunks');
  });
});

describe('search_docs', () => {
  it('returns numbered sources and one citation per section', async () => {
    const { embed } = fakeEmbedder();
    const tool = searchDocsTool(await buildIndex(twoPages, embed, { batchSize: 1, model: 'fake' }), embed, 2);
    const result = await tool({ query: 'How does SSO work?' });
    expect(result.content.startsWith('[1] Enterprise › Single sign-on (u/sso)\n')).toBe(true);
    expect(result.content).toContain('[2] Pricing › Prices (u/price)');
    expect(result.citations).toEqual([
      { title: 'Enterprise › Single sign-on', url: 'u/sso' },
      { title: 'Pricing › Prices', url: 'u/price' },
    ]);
  });

  it('refuses an empty query, without embedding it', async () => {
    const { embed, batches } = fakeEmbedder();
    const tool = searchDocsTool(await buildIndex(twoPages, embed, { batchSize: 2, model: 'fake' }), embed);
    expect((await tool({ query: '  ' })).content).toMatch(/empty/);
    await expect(async () => tool({ query: 3 })).rejects.toThrow(TypeError);
    expect(batches).toHaveLength(1); // only the build
  });
});
