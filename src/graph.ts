// The graph: ask the model, run the tools it calls, repeat, answer. It is
// coati-agent's loop (src/coati_agent/agent.py there) written as a LangGraph
// StateGraph, so the two can be read side by side:
//
//   START → model ─┬─ answer ─────────────→ END
//                  ├─ empty, ask again ───→ model
//                  └─ tool calls → tools ─┬─ check_readiness pending → END
//                                         └─────────────────────────→ model
//
// No checkpointer: a pending client tool ends the run, and the caller sends
// the whole conversation back with the result. The Worker keeps no state.
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type ToolCall,
} from '@langchain/core/messages';
import type { Callbacks } from '@langchain/core/callbacks/manager';
import { Annotation, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { CLIENT_CITATIONS, CLIENT_TOOLS, type Citation, type ServerTool, clientToolError } from './tools.ts';
import { NO_USAGE, type Step, type Usage, addCitations, addUsage } from './trace.ts';

export const MAX_STEPS = 4;
// A client tool's result comes from the caller; cut it before the model reads
// it (a readiness summary is about 5 KB).
export const MAX_CLIENT_OUTPUT = 12_000;
export const CUT = '\n[cut: the result was too long]';
export const NOT_RUN = "Error: {name} wasn't run, so there is no result. Say so, and offer to try again.";
export const GIVE_UP =
  "Sorry, I couldn't finish that answer. Please try asking more simply, or write to us at https://latitude10.tech/contact.";

// --- the wire format (the /invoke contract) --------------------------------

export type WireCall = { id: string; name: string; args: Record<string, unknown> };
export type WireMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: WireCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export type Turn = {
  answer: string | null;
  pending: WireCall | null;
  // This run's new messages: what the caller sends back, with the client
  // tool's result after them, to resume a pending turn.
  messages: WireMessage[];
  citations: Citation[];
  usage: Usage;
  steps: Step[];
};

// What the graph needs from a chat model: tools already bound (src/model.ts).
export type ChatModel = { invoke(messages: BaseMessage[]): Promise<AIMessage> };

export type GraphOptions = {
  model: ChatModel;
  system: string;
  tools: Record<string, ServerTool>;
  clock?: () => number;
};

// --- state ------------------------------------------------------------------

const State = Annotation.Root({
  ...MessagesAnnotation.spec,
  steps: Annotation<Step[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  citations: Annotation<Citation[]>({ reducer: addCitations, default: () => [] }),
  usage: Annotation<Usage>({ reducer: addUsage, default: () => NO_USAGE }),
  calls: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  retried: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
  answer: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  pending: Annotation<WireCall | null>({ reducer: (_, b) => b, default: () => null }),
  // The ids of the last reply's calls whose arguments weren't JSON.
  invalid: Annotation<string[]>({ reducer: (_, b) => b, default: () => [] }),
});
type S = typeof State.State;

/** The text of a reply, whatever shape its content has (Anthropic sends blocks). */
export function textOf(message: BaseMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  return content
    .map((part) => (typeof part === 'string' ? part : part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

// A call whose arguments weren't JSON is kept with empty arguments, so its
// error result has a call to answer (chat APIs refuse a result with none).
function callsOf(reply: AIMessage): { calls: ToolCall[]; invalid: Set<string> } {
  const invalid = new Set<string>();
  const calls: ToolCall[] = [...(reply.tool_calls ?? [])];
  for (const [n, bad] of (reply.invalid_tool_calls ?? []).entries()) {
    const id = bad.id ?? `invalid_${n}`;
    invalid.add(id);
    calls.push({ id, name: bad.name ?? 'unknown', args: {}, type: 'tool_call' });
  }
  return { calls, invalid };
}

export function buildGraph({ model, system, tools, clock = () => Date.now() }: GraphOptions) {
  const msSince = (started: number) => Math.round(clock() - started);

  async function callModel(state: S): Promise<Partial<S>> {
    if (state.calls >= MAX_STEPS) return { answer: GIVE_UP };
    const started = clock();
    const reply = await model.invoke([new SystemMessage(system), ...state.messages]);
    const usage = {
      input_tokens: reply.usage_metadata?.input_tokens ?? 0,
      output_tokens: reply.usage_metadata?.output_tokens ?? 0,
    };
    const step: Step = { name: 'chat', type: 'CHAT_MODEL', ms: msSince(started), ...usage };
    const { calls, invalid } = callsOf(reply);
    if (calls.length) {
      const kept = new AIMessage({ content: reply.content, tool_calls: calls, id: reply.id });
      return { messages: [kept], invalid: [...invalid], steps: [step], usage, calls: 1 };
    }
    if (textOf(reply).trim()) return { answer: textOf(reply), steps: [step], usage, calls: 1 };
    // Some reasoning models spend the whole budget thinking and answer with
    // nothing. Ask once more; never show a blank.
    const empty: Step = { ...step, empty: true };
    if (state.retried) return { answer: GIVE_UP, steps: [empty], usage, calls: 1 };
    return { retried: true, steps: [empty], usage, calls: 1 };
  }

  async function runTools(state: S): Promise<Partial<S>> {
    const reply = state.messages.at(-1) as AIMessage;
    const invalid = new Set(state.invalid);
    const messages: ToolMessage[] = [];
    const steps: Step[] = [];
    let citations: Citation[] = [];
    let pending: WireCall | null = null;

    for (const call of reply.tool_calls ?? []) {
      const id = call.id!;
      if (CLIENT_TOOLS.has(call.name)) {
        const error = clientToolError(call.name, call.args);
        if (error === null) {
          pending ??= { id, name: call.name, args: call.args };
          continue;
        }
        steps.push({ name: call.name, type: 'CLIENT_TOOL', refused: true });
        messages.push(new ToolMessage({ content: error, tool_call_id: id }));
        continue;
      }
      const started = clock();
      let content: string;
      let found: Citation[] = [];
      const tool = tools[call.name];
      if (!tool) {
        content = `Error: unknown tool '${call.name}'. Use only the tools you were given.`;
      } else if (invalid.has(id)) {
        content = `Error: invalid arguments for ${call.name}: not a JSON object`;
      } else {
        try {
          const result = await tool(call.args);
          content = result.content;
          found = result.citations;
        } catch (error) {
          // The model gets the error, and the turn goes on.
          content = `Error: ${call.name} failed: ${error instanceof Error ? error.name : 'Error'}`;
        }
      }
      citations = addCitations(citations, found);
      steps.push({ name: call.name, type: 'TOOL', ms: msSince(started), sources: found });
      messages.push(new ToolMessage({ content, tool_call_id: id }));
    }
    return { messages, steps, citations, pending };
  }

  const afterModel = (state: S) => {
    if (state.answer !== null) return 'done';
    const last = state.messages.at(-1);
    return last instanceof AIMessage && last.tool_calls?.length ? 'tools' : 'model';
  };
  const afterTools = (state: S) => (state.pending ? 'pending' : 'model');

  return new StateGraph(State)
    .addNode('model', callModel)
    .addNode('tools', runTools)
    .addEdge(START, 'model')
    .addConditionalEdges('model', afterModel, { done: END, tools: 'tools', model: 'model' })
    .addConditionalEdges('tools', afterTools, { pending: END, model: 'model' })
    .compile();
}

// --- one turn ----------------------------------------------------------------

type Graph = ReturnType<typeof buildGraph>;

/**
 * Give every tool call a result: chat APIs refuse a call left open. A
 * follow-up that drops a pending call's result gets NOT_RUN in its place.
 */
export function closeUnanswered(messages: WireMessage[]): { messages: WireMessage[]; notRun: Set<string> } {
  const closed: WireMessage[] = [];
  const notRun = new Set<string>();
  let i = 0;
  while (i < messages.length) {
    const message = messages[i++]!;
    closed.push(message);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    const answered = new Set<string>();
    while (i < messages.length && messages[i]!.role === 'tool') {
      const result = messages[i++] as Extract<WireMessage, { role: 'tool' }>;
      answered.add(result.tool_call_id);
      closed.push(result);
    }
    for (const call of message.tool_calls) {
      if (answered.has(call.id)) continue;
      closed.push({ role: 'tool', tool_call_id: call.id, content: NOT_RUN.replace('{name}', call.name) });
      notRun.add(call.id);
    }
  }
  return { messages: closed, notRun };
}

/** Cap, record and cite the client results that resume this question. */
export function takeClientResults(messages: WireMessage[], notRun: Set<string>): { messages: WireMessage[]; steps: Step[]; citations: Citation[] } {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const names = new Map<string, string>();
  for (const m of messages.slice(lastUser + 1)) {
    if (m.role === 'assistant') for (const call of m.tool_calls ?? []) names.set(call.id, call.name);
  }
  const steps: Step[] = [];
  let citations: Citation[] = [];
  const out = messages.map((m, i) => {
    if (i <= lastUser || m.role !== 'tool') return m;
    const name = names.get(m.tool_call_id);
    if (!name || !CLIENT_TOOLS.has(name) || notRun.has(m.tool_call_id)) return m;
    const found = CLIENT_CITATIONS[name] ? [CLIENT_CITATIONS[name]] : [];
    citations = addCitations(citations, found);
    steps.push({ name, type: 'CLIENT_TOOL', sources: found });
    const content = m.content.length > MAX_CLIENT_OUTPUT ? m.content.slice(0, MAX_CLIENT_OUTPUT) + CUT : m.content;
    return { ...m, content };
  });
  return { messages: out, steps, citations };
}

export function toLangChain(message: WireMessage): BaseMessage {
  switch (message.role) {
    case 'user':
      return new HumanMessage(message.content);
    case 'tool':
      return new ToolMessage({ content: message.content, tool_call_id: message.tool_call_id });
    case 'assistant':
      return new AIMessage({
        content: message.content,
        tool_calls: (message.tool_calls ?? []).map((c) => ({ ...c, type: 'tool_call' as const })),
      });
  }
}

export function toWire(message: BaseMessage): WireMessage {
  if (message instanceof ToolMessage) {
    return { role: 'tool', content: textOf(message), tool_call_id: message.tool_call_id };
  }
  if (message instanceof AIMessage) {
    const calls = (message.tool_calls ?? []).map(({ id, name, args }) => ({ id: id!, name, args }));
    return { role: 'assistant', content: textOf(message), ...(calls.length ? { tool_calls: calls } : {}) };
  }
  return { role: 'user', content: textOf(message) };
}

// Each step is one model call and one tools call; the last model call may
// only say it gives up. One spare for the empty-answer retry's edge.
const RECURSION_LIMIT = 2 * MAX_STEPS + 2;

export async function runTurn(graph: Graph, input: WireMessage[], config: { callbacks?: Callbacks } = {}): Promise<Turn> {
  const closed = closeUnanswered(input);
  const resumed = takeClientResults(closed.messages, closed.notRun);
  const messages = resumed.messages.map(toLangChain);
  const state = await graph.invoke(
    { messages, steps: resumed.steps, citations: resumed.citations },
    { recursionLimit: RECURSION_LIMIT, callbacks: config.callbacks, runName: 'coati_langgraph' },
  );
  const pending = state.answer === null ? state.pending : null;
  return {
    answer: pending ? null : (state.answer ?? GIVE_UP),
    pending,
    messages: pending ? state.messages.slice(messages.length).map(toWire) : [],
    citations: state.citations,
    usage: state.usage,
    steps: state.steps,
  };
}
