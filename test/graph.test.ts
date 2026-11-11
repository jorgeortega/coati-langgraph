// The graph, with a fake model: the same behaviour as coati-agent's loop
// (src/coati_agent/agent.py there, tests/test_agent.py and test_client_tools.py).
import { AIMessage, type BaseMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { CUT, GIVE_UP, MAX_CLIENT_OUTPUT, MAX_STEPS, NOT_RUN, buildGraph, runTurn, type WireMessage } from '../src/graph.ts';
import { READINESS, type ServerTool } from '../src/tools.ts';

type Reply = { text?: string; calls?: { name: string; args: Record<string, unknown>; id?: string }[]; invalid?: { name: string; args: string; id: string }[] };

// Answers from a script, one reply per call, and remembers what it was sent.
function fakeModel(script: Reply[]) {
  const seen: BaseMessage[][] = [];
  let i = 0;
  return {
    seen,
    async invoke(messages: BaseMessage[]) {
      seen.push(messages);
      const reply = script[Math.min(i++, script.length - 1)]!;
      return new AIMessage({
        content: reply.text ?? '',
        tool_calls: (reply.calls ?? []).map((c, n) => ({ id: c.id ?? `call_${i}_${n}`, name: c.name, args: c.args, type: 'tool_call' as const })),
        invalid_tool_calls: (reply.invalid ?? []).map((c) => ({ ...c, error: 'bad json', type: 'invalid_tool_call' as const })),
        usage_metadata: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      });
    },
  };
}

const DOCS = { title: 'Hosted MCP', url: 'https://docs.latitude10.tech/hosted-mcp' };
const PRICING = { title: 'Pricing', url: 'https://latitude10.tech/pricing' };
const tools: Record<string, ServerTool> = {
  search_docs: async () => ({ content: '[1] Hosted MCP …', citations: [DOCS] }),
  get_plans: () => ({ content: '[{"id":"pro"}]', citations: [PRICING] }),
};

function setup(script: Reply[], serverTools = tools) {
  const model = fakeModel(script);
  let now = 0;
  const graph = buildGraph({ model, system: 'SYSTEM', tools: serverTools, clock: () => (now += 5) });
  return { model, ask: (messages: WireMessage[]) => runTurn(graph, messages) };
}

const question: WireMessage[] = [{ role: 'user', content: 'How do I set up hosted MCP?' }];

describe('the graph', () => {
  it('answers when the model calls no tool', async () => {
    const { model, ask } = setup([{ text: 'Hello.' }]);
    const turn = await ask(question);
    expect(turn).toMatchObject({ answer: 'Hello.', pending: null, citations: [], usage: { input_tokens: 100, output_tokens: 10 } });
    expect(turn.steps).toEqual([{ name: 'chat', type: 'CHAT_MODEL', ms: 5, input_tokens: 100, output_tokens: 10 }]);
    expect(model.seen[0]![0]!.content).toBe('SYSTEM');
    expect(model.seen[0]![1]!.content).toBe('How do I set up hosted MCP?');
  });

  it('runs search_docs and get_plans, then answers from their results', async () => {
    const { model, ask } = setup([
      { calls: [{ name: 'search_docs', args: { query: 'hosted mcp' } }, { name: 'get_plans', args: { plan: 'Pro' } }] },
      { calls: [{ name: 'search_docs', args: { query: 'mcp keys' } }] },
      { text: 'Set it up like this.' },
    ]);
    const turn = await ask(question);
    expect(turn.answer).toBe('Set it up like this.');
    expect(turn.citations).toEqual([DOCS, PRICING]); // one per page
    expect(turn.steps.map((s) => `${s.type}:${s.name}`)).toEqual([
      'CHAT_MODEL:chat', 'TOOL:search_docs', 'TOOL:get_plans', 'CHAT_MODEL:chat', 'TOOL:search_docs', 'CHAT_MODEL:chat',
    ]);
    expect(turn.steps[1]).toEqual({ name: 'search_docs', type: 'TOOL', ms: 5, sources: [DOCS] });
    expect(turn.usage).toEqual({ input_tokens: 300, output_tokens: 30 });
    const results = model.seen[1]!.filter((m) => m instanceof ToolMessage).map((m) => m.content);
    expect(results).toEqual(['[1] Hosted MCP …', '[{"id":"pro"}]']);
  });

  it('ends with check_readiness pending, after running the server tools', async () => {
    const { ask } = setup([{ calls: [
      { name: 'search_docs', args: { query: 'readiness' } },
      { name: 'check_readiness', args: { url: 'https://api.example.com/openapi.json' }, id: 'call_r' },
    ] }]);
    const turn = await ask([{ role: 'user', content: 'Check https://api.example.com/openapi.json' }]);
    expect(turn.answer).toBeNull();
    expect(turn.pending).toEqual({ name: 'check_readiness', id: 'call_r', args: { url: 'https://api.example.com/openapi.json' } });
    // What the gateway sends back, before the tool's result.
    expect(turn.messages).toEqual([
      { role: 'assistant', content: '', tool_calls: [
        { id: expect.any(String), name: 'search_docs', args: { query: 'readiness' } },
        { id: 'call_r', name: 'check_readiness', args: { url: 'https://api.example.com/openapi.json' } },
      ] },
      { role: 'tool', content: '[1] Hosted MCP …', tool_call_id: expect.any(String) },
    ]);
  });

  it('resumes with the readiness result: capped, cited and on the trace', async () => {
    const { model, ask } = setup([{ text: 'Your API scores 72.' }]);
    const long = 'x'.repeat(MAX_CLIENT_OUTPUT + 50);
    const turn = await ask([
      { role: 'user', content: 'Check https://api.example.com/openapi.json' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_r', name: 'check_readiness', args: { url: 'https://api.example.com/openapi.json' } }] },
      { role: 'tool', content: long, tool_call_id: 'call_r' },
    ]);
    expect(turn.answer).toBe('Your API scores 72.');
    expect(turn.citations).toEqual([READINESS]);
    expect(turn.steps[0]).toEqual({ name: 'check_readiness', type: 'CLIENT_TOOL', sources: [READINESS] });
    const result = model.seen[0]!.find((m) => m instanceof ToolMessage)!;
    expect(result.content).toBe('x'.repeat(MAX_CLIENT_OUTPUT) + CUT);
  });

  it('refuses a readiness call without a public https URL, and goes on', async () => {
    const { model, ask } = setup([
      { calls: [{ name: 'check_readiness', args: { url: 'http://localhost/openapi.json' } }] },
      { text: 'I need a public https URL.' },
    ]);
    const turn = await ask(question);
    expect(turn.answer).toBe('I need a public https URL.');
    expect(turn.pending).toBeNull();
    expect(turn.steps[1]).toEqual({ name: 'check_readiness', type: 'CLIENT_TOOL', refused: true });
    expect(model.seen[1]!.at(-1)!.content).toMatch(/only checks a public https URL/);
  });

  it('refuses a tool it does not have, and goes on', async () => {
    const { model, ask } = setup([{ calls: [{ name: 'delete_everything', args: {} }] }, { text: 'Done.' }]);
    const turn = await ask(question);
    expect(turn.answer).toBe('Done.');
    expect(model.seen[1]!.at(-1)!.content).toBe("Error: unknown tool 'delete_everything'. Use only the tools you were given.");
  });

  it('tells the model about arguments that are not JSON', async () => {
    const { model, ask } = setup([{ invalid: [{ name: 'search_docs', args: '{"query":', id: 'call_bad' }] }, { text: 'Retried.' }]);
    expect((await ask(question)).answer).toBe('Retried.');
    const ai = model.seen[1]!.find((m) => m instanceof AIMessage) as AIMessage;
    expect(ai.tool_calls).toEqual([expect.objectContaining({ id: 'call_bad', name: 'search_docs', args: {} })]);
    expect(model.seen[1]!.at(-1)!.content).toMatch(/^Error: invalid arguments for search_docs/);
  });

  it('gives the model the error when a tool throws, and goes on', async () => {
    const broken = { ...tools, search_docs: async () => { throw new TypeError('boom'); } };
    const { model, ask } = setup([{ calls: [{ name: 'search_docs', args: { query: 'q' } }] }, { text: 'Sorry.' }], broken);
    expect((await ask(question)).answer).toBe('Sorry.');
    expect(model.seen[1]!.at(-1)!.content).toBe('Error: search_docs failed: TypeError');
  });

  it(`stops after ${MAX_STEPS} model calls`, async () => {
    const { model, ask } = setup([{ calls: [{ name: 'search_docs', args: { query: 'again' } }] }]);
    const turn = await ask(question);
    expect(turn.answer).toBe(GIVE_UP);
    expect(model.seen).toHaveLength(MAX_STEPS);
    expect(turn.steps.filter((s) => s.type === 'CHAT_MODEL')).toHaveLength(MAX_STEPS);
  });

  it('asks once more after an empty answer, and never shows a blank', async () => {
    const once = setup([{ text: '  ' }, { text: 'Here it is.' }]);
    const turn = await once.ask(question);
    expect(turn.answer).toBe('Here it is.');
    expect(turn.steps[0]).toMatchObject({ name: 'chat', empty: true });
    expect(once.model.seen[1]).toHaveLength(2); // the empty reply isn't kept

    const twice = setup([{ text: '' }]);
    expect((await twice.ask(question)).answer).toBe(GIVE_UP);
    expect(twice.model.seen).toHaveLength(2);
  });

  it('closes a tool call the conversation left open', async () => {
    const { model, ask } = setup([{ text: 'Shall I try again?' }]);
    await ask([
      { role: 'user', content: 'Check https://api.example.com/openapi.json' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_r', name: 'check_readiness', args: { url: 'https://api.example.com/openapi.json' } }] },
      { role: 'user', content: 'Never mind.' },
    ]);
    const closing = model.seen[0]!.find((m) => m instanceof ToolMessage)!;
    expect(closing.content).toBe(NOT_RUN.replace('{name}', 'check_readiness'));
  });

  it('reports only the fields the site trace scrubber reads', async () => {
    const { ask } = setup([{ calls: [{ name: 'search_docs', args: { query: 'q' } }] }, { text: 'Ok.' }]);
    const allowed = new Set(['name', 'type', 'ms', 'input_tokens', 'output_tokens', 'sources', 'empty', 'refused']);
    for (const step of (await ask(question)).steps) {
      for (const key of Object.keys(step)) expect(allowed.has(key), key).toBe(true);
    }
  });
});
