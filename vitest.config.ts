import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

// The Worker bundles data/*.txt, *.md and *.jsonl as strings (wrangler.jsonc
// "rules"); this does the same for tests, reading the bytes as they are.
const TEXT = /\/data\/[^/]+\.(txt|md|jsonl)$/;
const text: Plugin = {
  name: 'text-modules',
  enforce: 'pre',
  load(id) {
    if (!TEXT.test(id)) return null;
    return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
  },
};

export default defineConfig({
  plugins: [text],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
