import { describe, expect, it } from 'vitest';
import { EXPORT } from '../src/prompt.ts';
import { TOOL_SPECS, clientToolError, parsePlans, plansTool } from '../src/tools.ts';

describe('get_plans', () => {
  const getPlans = plansTool(parsePlans(EXPORT.files['plans.jsonl']!));

  it('finds a plan by id or name, in any case, and cites the pricing page', async () => {
    for (const plan of ['pro', ' Pro ', 'PRO']) {
      const result = await getPlans({ plan });
      expect(JSON.parse(result.content).map((r: { id: string }) => r.id)).toEqual(['pro']);
      expect(result.citations).toEqual([{ title: 'Pricing', url: 'https://latitude10.tech/pricing' }]);
    }
  });

  it('gives every plan without an argument, and drops empty fields', async () => {
    const rows = JSON.parse((await getPlans({})).content);
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['free', 'pro', 'business', 'enterprise']);
    for (const row of rows) {
      expect(Object.values(row)).not.toContain(null);
      expect('builds' in row).toBe(false); // renamed, as coati-agent does (eval d08)
    }
  });

  it('says so for a plan that does not exist', async () => {
    const result = await getPlans({ plan: 'Gold' });
    expect(result.content).toBe("No plan is called 'Gold'. The plans are Free, Pro, Business and Enterprise.");
    expect(result.citations).toEqual([]);
  });

  it('refuses an argument that is not a string', async () => {
    await expect(async () => getPlans({ plan: 3 })).rejects.toThrow(TypeError);
  });
});

describe('the client tool check', () => {
  it('passes a public https URL and refuses the rest', () => {
    expect(clientToolError('check_readiness', { url: 'https://api.example.com/openapi.json' })).toBeNull();
    expect(clientToolError('check_readiness', {})).toMatch(/needs a url/);
    expect(clientToolError('check_readiness', { url: 'http://api.example.com/x' })).toMatch(/public https URL/);
    expect(clientToolError('check_readiness', { url: `https://a.example/${'x'.repeat(2048)}` })).toMatch(/public https URL/);
  });
});

describe('the tool schemas', () => {
  it('are the three coati-agent tools, in OpenAI function format', () => {
    expect(TOOL_SPECS.map((t) => t.function.name)).toEqual(['search_docs', 'get_plans', 'check_readiness']);
  });
});
