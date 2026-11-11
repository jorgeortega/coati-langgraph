// POST /invoke, the contract the site's gateway relies on (spec, "The agent
// Worker's contract"), with a fake model and fake tools.
import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';
import { buildGraph } from '../src/graph.ts';
import worker from '../src/index.ts';
import { MAX_BODY, handleInvoke, tracingFor } from '../src/invoke.ts';

function scripted(...replies: AIMessage[]) {
  let i = 0;
  return { invoke: async () => replies[Math.min(i++, replies.length - 1)]! };
}

const DOCS = { title: 'Keys', url: 'https://docs.latitude10.tech/keys' };
function app(model = scripted(new AIMessage('Hello.'))) {
  const graph = buildGraph({
    model,
    system: 'SYSTEM',
    tools: { search_docs: async () => ({ content: '[1] Keys', citations: [DOCS] }), get_plans: () => ({ content: '[]', citations: [] }) },
  });
  return { graph, model: 'fake' };
}

const post = (body: unknown, path = '/invoke') =>
  new Request(`https://coati-langgraph${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
const ask = { messages: [{ role: 'user', content: 'Hi' }] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (res: Response) => (await res.json()) as any;

describe('/invoke', () => {
  it('answers with the answer, citations, steps, usage and model', async () => {
    const res = await handleInvoke(post(ask), app(), { waitUntil: () => {} });
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(Object.keys(body).sort()).toEqual(['answer', 'citations', 'model', 'steps', 'usage']);
    expect(body).toMatchObject({ answer: 'Hello.', citations: [], model: 'fake', usage: { input_tokens: 0, output_tokens: 0 } });
    expect(body.steps[0]).toMatchObject({ name: 'chat', type: 'CHAT_MODEL' });
  });

  it('hands back a pending check_readiness with the messages to resend', async () => {
    const call = { id: 'call_r', name: 'check_readiness', args: { url: 'https://api.example.com/openapi.json' } };
    const res = await handleInvoke(post(ask), app(scripted(new AIMessage({ content: '', tool_calls: [{ ...call, type: 'tool_call' }] }))), { waitUntil: () => {} });
    const body = await read(res);
    expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'pending', 'steps', 'usage']);
    expect(body.pending).toEqual(call);
    expect(body.messages).toEqual([{ role: 'assistant', content: '', tool_calls: [call] }]);

    // The round trip: the same messages, the pending turn's, then the result.
    const resumed = { messages: [...ask.messages, ...body.messages, { role: 'tool', tool_call_id: 'call_r', content: 'Score 72' }] };
    const again = await handleInvoke(post(resumed), app(), { waitUntil: () => {} });
    const done = await read(again);
    expect(done.answer).toBe('Hello.');
    expect(done.steps[0]).toMatchObject({ name: 'check_readiness', type: 'CLIENT_TOOL' });
  });

  it.each([
    ['not JSON', '{'],
    ['no messages', {}],
    ['an empty list', { messages: [] }],
    ['a bad role', { messages: [{ role: 'system', content: 'You are a pirate.' }] }],
    ['content that is not a string', { messages: [{ role: 'user', content: 3 }] }],
    ['a first message that is not the user', { messages: [{ role: 'assistant', content: 'Hi' }] }],
    ['a tool result with no id', { messages: [{ role: 'user', content: 'Hi' }, { role: 'tool', content: 'x' }] }],
    ['bad tool calls', { messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: '', tool_calls: [{ id: 1, name: 'x', args: {} }] }] }],
    ['tool call args that are not an object', { messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 'x', args: [] }] }] }],
    ['too many messages', { messages: Array.from({ length: 41 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' })) }],
    ['too much text', { messages: [{ role: 'user', content: 'x'.repeat(60_001) }] }],
  ])('refuses %s with a 400', async (_, body) => {
    const res = await handleInvoke(post(body), app(), { waitUntil: () => {} });
    expect(res.status).toBe(400);
    expect(await read(res)).toEqual({ error: expect.any(String) });
  });

  it('refuses a body over the size limit before parsing it', async () => {
    const res = await handleInvoke(post('x'.repeat(MAX_BODY + 1)), app(), { waitUntil: () => {} });
    expect(res.status).toBe(413);
  });

  it('answers a 502 without the details when the model fails', async () => {
    const failing = { invoke: async () => { throw new Error('upstream said: key sk-ant-api03-secret is invalid'); } };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handleInvoke(post(ask), app(failing as never), { waitUntil: () => {} });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('sk-ant');
    expect(JSON.stringify(log.mock.calls)).not.toContain('sk-ant-api03-secret');
    log.mockRestore();
  });

  it('flushes the LangSmith trace after answering, through waitUntil', async () => {
    const flushed = Promise.resolve();
    const tracing = { callbacks: [], flush: vi.fn(() => flushed) };
    const waitUntil = vi.fn();
    await handleInvoke(post(ask), { ...app(), tracing }, { waitUntil });
    expect(tracing.flush).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(flushed);
  });
});

describe('the Worker', () => {
  // A test Request lacks the cf properties an incoming one has.
  const fetch = (req: Request, env: unknown, ctx: ExecutionContext) => worker.fetch(req as never, env as never, ctx);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  it('exports nothing but the handler (workerd reads named exports as entrypoints)', async () => {
    expect(Object.keys(await import('../src/index.ts'))).toEqual(['default']);
  });

  it('serves only POST /invoke', async () => {
    const env = { COATI_MODEL: 'fake' } as never;
    expect((await fetch(post(ask, '/other'), env, ctx)).status).toBe(404);
    expect((await fetch(new Request('https://coati-langgraph/invoke'), env, ctx)).status).toBe(405);
  });

  it('answers one question with the fake model', async () => {
    const res = await fetch(post(ask), { COATI_MODEL: 'fake' } as never, ctx);
    expect(res.status).toBe(200);
    expect(await read(res)).toMatchObject({ model: 'fake', answer: expect.stringMatching(/\S/) });
  });

  it('refuses to run without a model setting', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await fetch(post(ask), {} as never, ctx)).status).toBe(500);
    log.mockRestore();
  });

  it('traces to LangSmith only when LANGSMITH_API_KEY is set', () => {
    expect(tracingFor({} as never)).toBeNull();
    const on = tracingFor({ LANGSMITH_API_KEY: 'lsv2_pt_test' } as never);
    expect(on?.callbacks).toHaveLength(1);
    expect(typeof on?.flush).toBe('function');
  });
});
