# Notes

What I learn while building this, in my own words. One entry per task.

## Task 2: the skeleton (2026-11-11)

- The Worker has no route and no `workers.dev` URL: only the site's Worker
  calls it, through a service binding.
- `nodejs_compat` is on because LangChain and LangSmith use Node APIs
  (`AsyncLocalStorage` for callbacks and tracing context).
- Every dependency is pinned to an exact version at least two weeks old.
- `@langchain/langgraph` 1.5.3 lets npm pick `@langchain/langgraph-sdk`
  1.12.10, which wants a newer `@langchain/core` than ours; `overrides` in
  `package.json` pins the SDK to 1.12.8.
- Everything together bundles to about 850 KiB gzipped. The Workers Paid
  limit is 10 MiB, so size is not a worry yet; the search index (Task 5) is
  the next thing to measure.

## Task 3: the export and the prompt (2026-11-11)

- The site writes `data/` (rules, summary, docs, plans and a manifest of
  SHA-256 hashes) with `AGENT_LAB_EXPORT=~/github/coati-langgraph npx vitest
  run tests/agent-lab-export.test.ts`, the same command as for coati-agent.
- A Worker has no file system, so `data/` is bundled as strings: wrangler's
  `Text` rule for the Worker, and a ten-line Vite plugin for tests.
- `systemPrompt()` hashes the files with Web Crypto once per isolate. An
  edited copy fails every request with `StaleCopy` rather than answering
  from the wrong rules.
- `TOOLS_NOTE` is coati-agent's, word for word, so the two labs differ only
  in framework and model.

## Task 4: the graph (2026-11-11)

- The state is `MessagesAnnotation` plus a few channels with reducers:
  `steps` and `citations` add up, `usage` sums, `calls` counts model calls,
  and `answer`, `pending`, `retried` and `invalid` keep the last value. A
  node returns only what it changes.
- Two conditional edges carry the whole loop: after `model` it's done,
  tools, or ask again (an empty answer); after `tools` it's pending
  (`check_readiness` is handed back) or model.
- The step cap is a counter in state, checked by `model`. LangGraph's
  `recursionLimit` (10) is only a backstop: it throws, and we would rather
  answer "Sorry, I couldn't finish that answer".
- No checkpointer: a pending client tool ends the run, and the caller sends
  everything back with the result, so there's nothing to store.
- `Date.now()` in a Worker only moves on I/O, so a fake model's steps take
  0 ms there. Real model calls are I/O.

## Task 5: search (2026-11-11)

- The chunker is coati-agent's, ported: on the real docs both make the same
  72 chunks, character for character. One catch: Python's `len()` counts
  code points and JavaScript's `.length` counts UTF-16 units, so the port
  counts code points.
- `bge-base-en-v1.5` reads only 512 tokens an input, and a chunk can be
  about 800, so the end of a long section would never be searched.
  `bge-m3` reads 60,000 and is cheaper. Read the model's input limit, not
  just its context window.
- The index is 72 vectors of 1,024 floats, stored as base64 float32
  (533 KiB, 326 KiB gzipped). A cosine scan over 72 vectors is nothing;
  Vectorize would be overkill.
- Only the query is embedded per request, through the Worker's AI binding.
  The query vectors for the tests were made with the index, so the search
  test runs offline.
- d03 ("Leave out the port") ranks its page 6th, the same miss coati-agent
  has: the answer is in a table on a narrow page, and broad hosted-MCP pages
  win. It's a known miss in the test, which fails once it gets fixed.

## Task 6: /invoke and the redactor (2026-11-11)

- `src/index.ts` exports only the Worker. workerd reads every named export
  of the main module as an entrypoint, so exporting a constant from it
  stops the Worker from starting ("Incorrect type for map entry"), and Node
  tests can't see that. The handler lives in `src/invoke.ts`.
- `/invoke` checks shape only (roles, strings, tool calls, sizes); the site
  checks the conversation rules first. Errors answer with no details, and
  the log keeps only the error's name: an upstream message can carry a key.
- LangSmith is on only with `LANGSMITH_API_KEY`. The `Client` is built from
  the Worker's env, with `hideInputs` and `hideOutputs` set to the
  redactor, and `ctx.waitUntil(flush)` sends the trace after the answer.
- The redactor is the site's `redact`, copied, plus the provider keys this
  Worker holds. It reads LangChain messages through their `toJSON`, so it
  never changes the agent's own copies.

## Task 8: real models (2026-11-11)

- Workers AI through ChatOpenAI: the base URL is the account's `/ai/v1`, and
  the header `cf-aig-gateway-id` routes the call through the AI Gateway, so
  its rate limit applies.
- A LangGraph node gets the run's config as its second argument. Pass it on
  to `model.invoke(messages, config)`, or the callbacks (LangSmith) stop at
  the node and the trace has no LLM runs. A test now checks this.
- First real turns: gpt-oss-120b 13.9 s, qwen3-30b-a3b 9.7 s, both about
  30,000 input tokens a turn (the prompt alone is about 13,600).
