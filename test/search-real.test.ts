// The real index (src/index.json, from `npm run index`) against five docs
// questions from the eval set (coati-agent evals/questions.jsonl). The query
// vectors were made with the index, by the same model, so this runs offline.
// Each expected page (fixtures/search-cases.json) is the one whose text
// holds the case's fact, found by text search, not by this index.
import { describe, expect, it } from 'vitest';
import saved from '../src/index.json';
import cases from './fixtures/search-cases.json';
import queries from './fixtures/queries.json';
import { EXPORT } from '../src/prompt.ts';
import { decodeVector, loadIndex, parseRows, search } from '../src/search.ts';

const CASES = cases as { id: string; question: string; page: string; known_miss?: string }[];

describe('the real index', () => {
  const index = loadIndex(saved);

  it('covers every docs page, with the model the queries used', () => {
    const urls = new Set(parseRows(EXPORT.files['docs.jsonl']!).map((r) => r.url));
    expect(new Set(index.chunks.map((c) => c.url))).toEqual(urls);
    expect(queries.model).toBe(index.model);
    expect(queries.docs).toBe(saved.docs); // built from the same export
  });

  for (const c of CASES) {
    const rank = () => {
      const q = queries.queries.find((x) => x.id === c.id)!;
      expect(q.question).toBe(c.question);
      return search(index, decodeVector(q.vector), index.chunks.length).findIndex((h) => h.chunk.url === c.page) + 1;
    };
    const page = c.page.replace('https://docs.latitude10.tech/', '');
    if (c.known_miss) {
      // Recorded, not hidden: this fails once the page reaches the top 5,
      // and then the case should lose its known_miss.
      it(`ranks ${page} 6th to 10th for ${c.id} (known miss: ${c.known_miss.split(' (')[0]})`, () => {
        expect(rank()).toBeGreaterThan(5);
        expect(rank()).toBeLessThanOrEqual(10);
      });
    } else {
      it(`finds ${page} in the top 5 for ${c.id}`, () => {
        expect(rank()).toBeGreaterThan(0);
        expect(rank()).toBeLessThanOrEqual(5);
      });
    }
  }
});
