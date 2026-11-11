// What may leave for LangSmith: the full trace, with no email, key or token.
// The rules are the site's (latitude10 app/_lib/observability/scrub.ts,
// `redact`), copied because this repo can't import the site; keep them equal.
// Added here: the provider keys this Worker itself holds (Anthropic, OpenAI-
// style, LangSmith), in case one ever ends up in an error or a tool output.

// The site's: every prefix it issues (l10_, l10p_, l10m_, l10a_, l10r_, l10c_
// and any other l10x_), Stripe's secret, restricted and webhook keys.
const TOKEN = /\b(l10[a-z]?_|sk_(?:live|test)_|rk_|whsec_)[A-Za-z0-9_-]+/g;
const BEARER = /\bBearer\s+\S+/gi;
const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi;
const URL_QUERY = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g;
// This Worker's: sk-ant-…, sk-proj-… / sk-…, lsv2_pt_… / lsv2_sk_….
const PROVIDER_KEY = /\b(sk-ant-|sk-proj-|sk-|lsv2_(?:pt|sk)_)[A-Za-z0-9_-]{8,}/g;

export const redact = (text: string) =>
  text
    .replace(URL_QUERY, '$1')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(TOKEN, '$1[redacted]')
    .replace(PROVIDER_KEY, '$1[redacted]')
    .replace(EMAIL, '[email]');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// A copy with every string redacted. LangChain objects (messages) are read
// through their toJSON, so the agent's own copies are never changed.
function walk(value: unknown, depth: number): Json {
  if (depth > 40) return '[cut]';
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  if (typeof value === 'object') {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    const plain = typeof toJSON === 'function' ? toJSON.call(value) : value;
    if (plain !== value) return walk(plain, depth + 1);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, depth + 1)]));
  }
  return null; // functions, symbols, undefined: nothing to send
}

/** LangSmith's hideInputs and hideOutputs: the run's values, redacted. */
export const redactValues = (values: Record<string, unknown>): Record<string, Json> =>
  walk(values, 0) as Record<string, Json>;
