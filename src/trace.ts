// The browser's trace: a short, safe record of each step, with no prompts and
// no tool payloads (the full trace goes to LangSmith, redacted; Task 6). The
// fields are coati-agent's, so the site's allowlist scrubber
// (app/api/agent-lab/_lib/trace.ts) reads both labs the same way.
import type { Citation } from './tools.ts';

export type ChatStep = {
  name: 'chat';
  type: 'CHAT_MODEL';
  ms: number;
  input_tokens: number;
  output_tokens: number;
  empty?: true;
};
export type ToolStep = { name: string; type: 'TOOL'; ms: number; sources: Citation[] };
// A client tool's ms is filled in by the site, which runs it.
export type ClientStep = { name: string; type: 'CLIENT_TOOL'; sources?: Citation[]; refused?: true };
export type Step = ChatStep | ToolStep | ClientStep;

export type Usage = { input_tokens: number; output_tokens: number };
export const NO_USAGE: Usage = { input_tokens: 0, output_tokens: 0 };
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
});

/** One citation per page: the first (best-ranked) one wins. */
export function addCitations(seen: Citation[], found: Citation[]): Citation[] {
  const out = [...seen];
  for (const c of found) if (out.every((s) => s.url !== c.url)) out.push(c);
  return out;
}
