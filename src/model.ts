// The chat model, picked by COATI_MODEL (spec L4). Task 8 adds the real
// ones: Workers AI through ChatOpenAI, and Claude through ChatAnthropic.
// "fake" answers without calling anything, for local runs and tests.
import { AIMessage } from '@langchain/core/messages';
import type { ChatModel } from './graph.ts';
import type { Env } from './invoke.ts';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export type ModelChoice = { name: string; model: ChatModel };

const FAKE: ChatModel = {
  invoke: async () => new AIMessage('This is the fake model: no model was called. Set COATI_MODEL to a real one.'),
};

export function chatModel(env: Env): ModelChoice {
  switch (env.COATI_MODEL) {
    case 'fake':
      return { name: 'fake', model: FAKE };
    case undefined:
    case '':
      throw new ConfigError('COATI_MODEL is not set');
    default:
      throw new ConfigError(`COATI_MODEL is not a model this Worker knows: ${env.COATI_MODEL}`);
  }
}
