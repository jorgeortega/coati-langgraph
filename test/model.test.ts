// COATI_MODEL picks the chat model (spec L4). Each model's real request is
// checked against a mocked fetch: nothing leaves, nothing is spent.
import { HumanMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/invoke.ts';
import { ConfigError, MAX_TOKENS, chatModel } from '../src/model.ts';

const env: Partial<Env> = {
  CLOUDFLARE_ACCOUNT_ID: 'acct123',
  CLOUDFLARE_AI_TOKEN: 'cf-test-token',
  AI_GATEWAY_ID: 'coati-langgraph',
  ANTHROPIC_API_KEY: 'sk-ant-test',
};

type Sent = { url: string; headers: Headers; body: Record<string, unknown> };
function captureFetch(reply: unknown): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) });
    return Response.json(reply);
  }));
  return sent;
}

const openAiReply = {
  id: 'x', object: 'chat.completion', created: 0, model: 'm',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hi.' } }],
  usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
};

afterEach(() => vi.unstubAllGlobals());

describe('the Workers AI models', () => {
  it.each([
    ['gpt-oss-120b', '@cf/openai/gpt-oss-120b'],
    ['qwen3-30b-a3b', '@cf/qwen/qwen3-30b-a3b-fp8'],
  ])('%s goes through the AI Gateway, with the tools bound', async (name, id) => {
    const sent = captureFetch(openAiReply);
    const choice = chatModel({ ...env, COATI_MODEL: name } as never);
    expect(choice.name).toBe(name);
    const reply = await choice.model.invoke([new HumanMessage('Hello')]);
    expect(reply.content).toBe('Hi.');
    expect(reply.usage_metadata).toMatchObject({ input_tokens: 11, output_tokens: 2 });

    const [request] = sent;
    expect(request!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions');
    expect(request!.headers.get('authorization')).toBe('Bearer cf-test-token');
    expect(request!.headers.get('cf-aig-gateway-id')).toBe('coati-langgraph');
    expect(request!.body).toMatchObject({ model: id, max_tokens: MAX_TOKENS });
    expect((request!.body.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(['search_docs', 'get_plans', 'check_readiness']);
  });

  it('refuses to start without the token, account or gateway', () => {
    for (const missing of ['CLOUDFLARE_AI_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'AI_GATEWAY_ID']) {
      expect(() => chatModel({ ...env, [missing]: '', COATI_MODEL: 'gpt-oss-120b' } as never), missing).toThrow(ConfigError);
    }
  });
});

describe('Claude Haiku 5.5', () => {
  it('calls the Messages API with the labs workspace key and the tools bound', async () => {
    const sent = captureFetch({
      id: 'msg', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: 'Hi.' }], usage: { input_tokens: 11, output_tokens: 2 },
    });
    const choice = chatModel({ ...env, COATI_MODEL: 'claude-haiku-5-5' } as never);
    const reply = await choice.model.invoke([new HumanMessage('Hello')]);
    expect(reply.content).toBe('Hi.');
    const [request] = sent;
    expect(request!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request!.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(request!.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: MAX_TOKENS });
    expect((request!.body.tools as { name: string }[]).map((t) => t.name)).toEqual(['search_docs', 'get_plans', 'check_readiness']);
  });

  it('refuses to start without its key', () => {
    expect(() => chatModel({ ...env, ANTHROPIC_API_KEY: '', COATI_MODEL: 'claude-haiku-5-5' } as never)).toThrow(ConfigError);
  });
});

it('knows no other model', () => {
  expect(() => chatModel({ ...env, COATI_MODEL: 'gpt-5' } as never)).toThrow(/not a model this Worker knows/);
});
