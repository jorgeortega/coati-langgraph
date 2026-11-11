// The chat model, picked by COATI_MODEL (spec L4), with the coati's three
// tools bound. The evals choose among them (Task 10).
//
// - Workers AI (gpt-oss-120b, qwen3-30b-a3b): LangChain's ChatOpenAI on
//   Workers AI's OpenAI-compatible endpoint, through the AI Gateway named in
//   AI_GATEWAY_ID, whose rate limit is the only cap Workers AI has.
//   @langchain/cloudflare can't be used: no tool calling, no binding (Task 1).
// - Claude Haiku 5.5: ChatAnthropic with a key from the Console workspace
//   "labs", whose spend limit is a hard cap (inside the org's own limit).
// - fake: answers without calling anything, for local runs and tests.
import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import type { ChatModel } from './graph.ts';
import type { Env } from './invoke.ts';
import { TOOL_SPECS } from './tools.ts';

// coati-agent's (serve.py): reasoning models think first, and 500 left some
// answers empty.
export const MAX_TOKENS = 1500;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export type ModelChoice = { name: string; model: ChatModel };

const WORKERS_AI: Record<string, string> = {
  'gpt-oss-120b': '@cf/openai/gpt-oss-120b',
  'qwen3-30b-a3b': '@cf/qwen/qwen3-30b-a3b-fp8',
};
const CLAUDE = 'claude-haiku-5-5';

const FAKE: ChatModel = {
  invoke: async () => new AIMessage('This is the fake model: no model was called. Set COATI_MODEL to a real one.'),
};

function need(env: Env, ...names: (keyof Env)[]): void {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new ConfigError(`${env.COATI_MODEL} needs ${missing.join(', ')}`);
}

export function chatModel(env: Env): ModelChoice {
  const name = env.COATI_MODEL;
  if (!name) throw new ConfigError('COATI_MODEL is not set');
  if (name === 'fake') return { name, model: FAKE };

  const id = WORKERS_AI[name];
  if (id) {
    need(env, 'CLOUDFLARE_AI_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'AI_GATEWAY_ID');
    const model = new ChatOpenAI({
      model: id,
      apiKey: env.CLOUDFLARE_AI_TOKEN,
      maxTokens: MAX_TOKENS,
      maxRetries: 1,
      configuration: {
        baseURL: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
        defaultHeaders: { 'cf-aig-gateway-id': env.AI_GATEWAY_ID! },
      },
    });
    return { name, model: model.bindTools(TOOL_SPECS) as unknown as ChatModel };
  }

  if (name === CLAUDE) {
    need(env, 'ANTHROPIC_API_KEY');
    const model = new ChatAnthropic({ model: CLAUDE, apiKey: env.ANTHROPIC_API_KEY, maxTokens: MAX_TOKENS, maxRetries: 1 });
    return { name, model: model.bindTools(TOOL_SPECS) as unknown as ChatModel };
  }

  throw new ConfigError(`COATI_MODEL is not a model this Worker knows: ${name}`);
}
