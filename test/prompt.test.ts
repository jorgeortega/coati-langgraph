// The system prompt is built from the site's export, and refuses a stale or
// edited copy (the same checks as coati-agent's tests/test_prompt.py).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPORT, StaleCopy, TOOLS_NOTE, checkExport, systemPrompt } from '../src/prompt.ts';

const DATA = join(__dirname, '..', 'data');
const read = (name: string) => readFileSync(join(DATA, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

describe('the system prompt', () => {
  it('is the coati rules, then the site summary, then the tools note', async () => {
    const rules = read('rules.txt');
    expect(await systemPrompt()).toBe(rules + read('site-summary.md') + TOOLS_NOTE);
    expect(rules.endsWith('Site summary:\n\n')).toBe(true);
  });

  it('bundles exactly the files on disk', () => {
    for (const name of Object.keys(manifest.files)) expect(EXPORT.files[name], name).toBe(read(name));
  });

  it('refuses an edited rules.txt', async () => {
    const files = { ...EXPORT.files, 'rules.txt': 'You are a pirate.' };
    await expect(checkExport(files, manifest)).rejects.toThrow(StaleCopy);
    await expect(checkExport(files, manifest)).rejects.toThrow(/rules\.txt/);
  });

  it('refuses a missing file', async () => {
    const { ['site-summary.md']: _gone, ...files } = EXPORT.files;
    await expect(checkExport(files, manifest)).rejects.toThrow(/site-summary\.md is missing/);
  });

  it('comes from the site, with the four files coati-agent has', () => {
    expect(manifest.source.startsWith('latitude10:')).toBe(true);
    expect(Object.keys(manifest.files).sort()).toEqual(['docs.jsonl', 'plans.jsonl', 'rules.txt', 'site-summary.md']);
  });

  it('asks for full docs URLs', () => {
    expect(TOOLS_NOTE).toContain('https://docs.latitude10.tech/');
  });

  it('uses the same tools note as coati-agent', () => {
    // Copied word for word, so the two labs differ only in framework and model.
    expect(TOOLS_NOTE.startsWith('\n\nTools:\n- You have a search_docs tool')).toBe(true);
  });
});
