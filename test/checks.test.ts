// coati-agent's three code checks, ported for the LangSmith run (its
// tests/test_evals.py cases, the same strings).
import { describe, expect, it } from 'vitest';
import { docsLinksOk, knownPrices, pricesOk, toolOk } from '../src/checks.ts';
import { EXPORT } from '../src/prompt.ts';

describe('the code checks', () => {
  const TOOL = { category: 'tool', expected_url: 'https://x.dev/openapi.json' };

  it('check_readiness only where it belongs, with the right URL', () => {
    expect(toolOk('CALL check_readiness {"url": "https://x.dev/openapi.json"}', TOOL)).toBe(true);
    expect(toolOk('CALL check_readiness {"url": "https://other.dev/a.json"}', TOOL)).toBe(false);
    expect(toolOk('Your spec looks great!', TOOL)).toBe(false);
    expect(toolOk('Pro costs $150.', { category: 'summary' })).toBe(true);
    expect(toolOk('CALL check_readiness {"url": "https://x"}', { category: 'refuse' })).toBe(false);
  });

  it('docs links on the docs host', () => {
    expect(docsLinksOk('See https://docs.latitude10.tech/hosted-mcp/setup.')).toBe(true);
    expect(docsLinksOk('See /pricing or https://latitude10.tech/platform/mcp.')).toBe(true);
    expect(docsLinksOk('Enterprise has SSO: https://latitude10.tech/enterprise')).toBe(true);
    expect(docsLinksOk('See /hosted-mcp/refused-hosts.')).toBe(false);
    expect(docsLinksOk('See https://latitude10.tech/sdks/python for details.')).toBe(false);
    expect(docsLinksOk('Read (/get-started/keys-and-tokens).')).toBe(false);
    expect(docsLinksOk('See https://latitude10.tech/enterprise/sso')).toBe(false);
  });

  it('only prices the site publishes', () => {
    const prices = knownPrices(Object.values(EXPORT.files).join(''));
    expect(prices.has('150')).toBe(true);
    expect(pricesOk('Pro is $150 a month, or $125 billed annually.', prices)).toBe(true);
    expect(pricesOk('Kits from $19, paid once.', prices)).toBe(true);
    expect(pricesOk('Pro is $99 a month.', prices)).toBe(false);
    expect(pricesOk('Kits from US$1,500.', prices)).toBe(false);
    expect(pricesOk('No prices here.', prices)).toBe(true);
  });
});
