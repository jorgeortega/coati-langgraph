// The Worker: POST /invoke, reached only through the site's service binding
// (no route, no workers.dev URL). Only the default export lives here:
// workerd reads every named export of the main module as an entrypoint.
import savedIndex from './index.json';
import { buildGraph } from './graph.ts';
import { type App, type Env, handleInvoke, json, tracingFor } from './invoke.ts';
import { ConfigError, chatModel } from './model.ts';
import { EXPORT, systemPrompt } from './prompt.ts';
import { type SavedIndex, loadIndex, searchDocsTool, workersAiEmbed } from './search.ts';
import { parsePlans, plansTool } from './tools.ts';

// One graph per isolate and model setting; the index is decoded once.
let cached: { key: string; app: Promise<Omit<App, 'tracing'>> } | null = null;
const index = loadIndex(savedIndex as SavedIndex);

function appFor(env: Env): Promise<Omit<App, 'tracing'>> {
  const key = env.COATI_MODEL ?? '';
  if (cached?.key !== key) {
    const { name, model } = chatModel(env);
    const tools = {
      search_docs: searchDocsTool(index, workersAiEmbed(env.AI)),
      get_plans: plansTool(parsePlans(EXPORT.files['plans.jsonl']!)),
    };
    const app = systemPrompt().then((system) => ({ graph: buildGraph({ model, system, tools }), model: name }));
    cached = { key, app };
    app.catch(() => (cached = null));
  }
  return cached!.app;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== '/invoke') return json({ error: 'not found' }, 404);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    let app: Omit<App, 'tracing'>;
    try {
      app = await appFor(env);
    } catch (error) {
      console.error('setup failed:', error instanceof ConfigError ? error.message : error instanceof Error ? error.name : 'unknown');
      return json({ error: 'the agent is not set up' }, 500);
    }
    return handleInvoke(request, { ...app, tracing: tracingFor(env) }, ctx);
  },
} satisfies ExportedHandler<Env>;
