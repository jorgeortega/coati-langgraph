// The coati's tools: the same names, schemas and rules as coati-agent
// (src/coati_agent/tools.py, plans.py and index.py there). The schemas are
// copied word for word, in OpenAI's function format, which bindTools takes
// for both ChatOpenAI and ChatAnthropic.

export type Citation = { title: string; url: string };
export type ToolResult = { content: string; citations: Citation[] };

// A server tool runs here, in the Worker, with the model's arguments.
export type ServerTool = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

export type ToolSpec = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export const TOOL_SPECS: ToolSpec[] = [
  {
    "type": "function",
    "function": {
      "name": "search_docs",
      "description": "Search the Latitude 10 platform documentation (docs.latitude10.tech): the registry, hosted API reference and API client, hosted docs, SDKs, hosted MCP, keys, plans and limits, enterprise. Returns numbered passages with their URLs.",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "What to look for, in a few words."
          }
        },
        "required": [
          "query"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "get_plans",
      "description": "Latitude 10's plans (Free, Pro, Business, Enterprise): monthly and annual price, the APIs, seats and SDK endpoints each allows, and the features each adds. A plan with includes_everything_in also has every feature of that plan. Use it for a plan's price or those three limits. For any other limit (custom domains, versions, requests, storage) or how a feature works, call search_docs instead. A plan with no price has none published: never guess one.",
      "parameters": {
        "type": "object",
        "properties": {
          "plan": {
            "type": "string",
            "description": "One plan's id or name. Leave it out for every plan."
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "check_readiness",
      "description": "Score how ready an OpenAPI document is for AI agents (0 to 100), with the same rules as https://latitude10.tech/agent-readiness. Use it when the visitor gives the URL of their OpenAPI document and asks about it.",
      "parameters": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "The https URL of an OpenAPI 3.0 or 3.1 document."
          }
        },
        "required": [
          "url"
        ]
      }
    }
  }
];

// Client tools are run by the caller (the site's Worker), never here: the
// readiness rules are the site's TypeScript. The graph hands the call back
// and resumes when the result arrives.
export const CLIENT_TOOLS: ReadonlySet<string> = new Set(['check_readiness']);

// What a client tool's answer cites: the page that runs the same rules.
export const READINESS: Citation = { title: 'Agent readiness check', url: 'https://latitude10.tech/agent-readiness' };
export const CLIENT_CITATIONS: Record<string, Citation> = { check_readiness: READINESS };

/** Why a client call can't be handed back, or null. The site checks again. */
export function clientToolError(name: string, args: Record<string, unknown>): string | null {
  const raw = args.url;
  if (typeof raw !== 'string') return `Error: ${name} needs a url: the https URL of an OpenAPI document.`;
  const url = raw.trim();
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // not a URL at all
  }
  if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname || url.length > 2048) {
    return `Error: ${name} only checks a public https URL of an OpenAPI document. Ask the visitor for one.`;
  }
  return null;
}

// --- get_plans, over the exported plans.jsonl ------------------------------

export const PRICING: Citation = { title: 'Pricing', url: 'https://latitude10.tech/pricing' };

// v4 read Business's `builds: "Pro"` as "has none of Pro's features" (eval d08).
const RENAMED: Record<string, string> = { builds: 'includes_everything_in' };

export type PlanRow = Record<string, unknown> & { id: string; name: string };

export const parsePlans = (text: string): PlanRow[] =>
  text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as PlanRow);

const isEmpty = (value: unknown) => value === null || (Array.isArray(value) && value.length === 0);

function answer(rows: PlanRow[], plan: string | undefined): ToolResult {
  if (!rows.length) {
    return { content: `No plan is called '${plan}'. The plans are Free, Pro, Business and Enterprise.`, citations: [] };
  }
  const compact = rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([, v]) => !isEmpty(v)).map(([k, v]) => [RENAMED[k] ?? k, v])),
  );
  return { content: JSON.stringify(compact), citations: [PRICING] };
}

/** get_plans: one plan by id or name (any case, trimmed), or every plan. */
export function plansTool(rows: PlanRow[]): ServerTool {
  return ({ plan, ...rest }) => {
    if (Object.keys(rest).length || (plan != null && typeof plan !== 'string')) {
      throw new TypeError('get_plans takes one optional string, plan');
    }
    if (plan == null) return answer(rows, undefined);
    const key = plan.trim().toLowerCase();
    return answer(rows.filter((r) => r.id.toLowerCase() === key || r.name.toLowerCase() === key), plan);
  };
}
