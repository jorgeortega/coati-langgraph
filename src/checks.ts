// coati-agent's code checks (src/coati_agent/evals.py there), ported for the
// LangSmith dataset run (scripts/langsmith-evals.ts). The scoreboard's numbers
// come from coati-agent's runner and its judge; these show LangSmith's own
// evaluate() on the same cases.

export type Expectations = { category?: string; expected_url?: string };

/** check_readiness called with the case's URL on tool cases, and never elsewhere. */
export function toolOk(output: string, expectations: Expectations): boolean {
  const called = output.startsWith('CALL check_readiness');
  if (expectations.category === 'tool') return called && output.includes(expectations.expected_url ?? '\u0000');
  return !output.startsWith('CALL ');
}

const DOCS_SECTIONS = ['get-started', 'quickstart', 'registry', 'registry-api', 'api-reference', 'api-client', 'docs-hosting', 'sdks', 'hosted-mcp'];
// A docs path written on the site's host, or as a bare path. /enterprise is a
// site page too, so only its subpages (/enterprise/sso) count as docs paths.
const WRONG_HOST = new RegExp(
  String.raw`(?:https?://(?:www\.)?latitude10\.tech|(?<![\w.:/])|(?<=\())` +
    String.raw`/(?:(?:${DOCS_SECTIONS.join('|')})(?=[/\s).,;:]|$)|enterprise/[a-z])`,
);

export const docsLinksOk = (output: string) => !WRONG_HOST.test(output);

const PRICE = /\$\s?(\d[\d,]*)(?:\.\d+)?/g;

export const knownPrices = (exportText: string) =>
  new Set([...exportText.matchAll(PRICE)].map((m) => m[1]!.replaceAll(',', '')));

export const pricesOk = (output: string, prices: Set<string>) =>
  [...output.matchAll(PRICE)].every((m) => prices.has(m[1]!.replaceAll(',', '')));
