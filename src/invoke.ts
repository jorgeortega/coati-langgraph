// POST /invoke: check the request's shape, run one turn of the graph, and
// answer with the spec's contract. The site does the visitor-facing checks
// (throttle, budget, the conversation rules) first. Kept out of index.ts:
// workerd reads every named export of the main module as an entrypoint.
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { Client } from 'langsmith';
import { type WireMessage, type buildGraph, runTurn } from './graph.ts';
import { redactValues } from './redact.ts';

export type Env = {
  AI: Ai;
  COATI_MODEL?: string;
  LANGSMITH_API_KEY?: string;
  LANGSMITH_PROJECT?: string;
  LANGSMITH_ENDPOINT?: string;
};

// A second layer behind the site's own rules, so generous: a readiness
// result is about 5 KB and the site caps it, and the site allows 20 messages.
export const MAX_BODY = 200_000;
const MAX_MESSAGES = 40;
const MAX_TEXT = 60_000;
const MAX_CALLS = 8;

export type Tracing = { callbacks: LangChainTracer[]; flush: () => Promise<void> };
export type App = { graph: ReturnType<typeof buildGraph>; model: string; tracing?: Tracing | null };

export const json = (body: unknown, status = 200) => Response.json(body, { status });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The request's messages in the contract's shape, or why not. */
export function parseMessages(body: unknown): { messages: WireMessage[] } | { error: string } {
  const raw = isObject(body) ? body.messages : undefined;
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'messages must be a non-empty list' };
  if (raw.length > MAX_MESSAGES) return { error: 'too many messages' };
  const messages: WireMessage[] = [];
  let total = 0;
  for (const m of raw) {
    if (!isObject(m) || typeof m.content !== 'string') return { error: 'each message needs a string content' };
    total += m.content.length;
    if (m.role === 'user') messages.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string' || !m.tool_call_id) return { error: 'a tool message needs a tool_call_id' };
      messages.push({ role: 'tool', content: m.content, tool_call_id: m.tool_call_id });
    } else if (m.role === 'assistant') {
      const calls = m.tool_calls ?? [];
      if (!Array.isArray(calls) || calls.length > MAX_CALLS) return { error: 'tool_calls must be a short list' };
      const parsed = [];
      for (const c of calls) {
        if (!isObject(c) || typeof c.id !== 'string' || typeof c.name !== 'string' || !isObject(c.args)) {
          return { error: 'each tool call needs a string id and name, and object args' };
        }
        const args = JSON.stringify(c.args);
        if (c.id.length > 200 || c.name.length > 64 || args.length > 4_000) return { error: 'a tool call is too long' };
        total += args.length;
        parsed.push({ id: c.id, name: c.name, args: c.args });
      }
      messages.push({ role: 'assistant', content: m.content, ...(parsed.length ? { tool_calls: parsed } : {}) });
    } else return { error: 'role must be user, assistant or tool' };
  }
  if (messages[0]!.role !== 'user') return { error: 'the first message must be the user' };
  if (total > MAX_TEXT) return { error: 'too much text' };
  return { messages };
}

/** LangSmith tracing, only with a key: inputs and outputs redacted. */
export function tracingFor(env: Env): Tracing | null {
  if (!env.LANGSMITH_API_KEY) return null;
  // Built from the Worker's env: a Worker has no process.env to read it from.
  const client = new Client({
    apiKey: env.LANGSMITH_API_KEY,
    apiUrl: env.LANGSMITH_ENDPOINT ?? 'https://api.smith.langchain.com',
    hideInputs: redactValues,
    hideOutputs: redactValues,
  });
  const tracer = new LangChainTracer({ client, projectName: env.LANGSMITH_PROJECT ?? 'coati-langgraph' });
  return { callbacks: [tracer], flush: () => client.awaitPendingTraceBatches() };
}

export async function handleInvoke(request: Request, app: App, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'request too large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'not JSON' }, 400);
  }
  const parsed = parseMessages(body);
  if ('error' in parsed) return json({ error: parsed.error }, 400);

  try {
    const turn = await runTurn(app.graph, parsed.messages, { callbacks: app.tracing?.callbacks ?? [] });
    const { steps, usage } = turn;
    if (turn.pending) return json({ pending: turn.pending, messages: turn.messages, steps, usage, model: app.model });
    return json({ answer: turn.answer, citations: turn.citations, steps, usage, model: app.model });
  } catch (error) {
    // The name only: an upstream message can carry a key or a visitor's text.
    console.error('invoke failed:', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'the agent failed' }, 502);
  } finally {
    // Sent after the answer: the visitor never waits for tracing.
    if (app.tracing) ctx.waitUntil(app.tracing.flush());
  }
}

