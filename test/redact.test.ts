// What may leave for LangSmith: the full trace, with no email, key or token
// in it (the rules of the site's app/_lib/observability/scrub.ts, plus the
// keys this Worker holds).
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { redact, redactValues } from '../src/redact.ts';

describe('redact', () => {
  it('removes emails, our tokens, provider keys, bearer headers and query strings', () => {
    const text = [
      'Mail me at jane.doe@example.com',
      'my key is l10p_AbCdEf123456 and l10m_zzz',
      'stripe sk_live_51Hxyz and whsec_abc',
      'anthropic sk-ant-api03-AbC_dEf-123',
      'openai sk-proj-AbCdEfGhIjKlMnOpQrStUv',
      'langsmith lsv2_pt_0123456789abcdef_0123456789',
      'Authorization: Bearer eyJhbGciOi.payload.sig',
      'https://api.example.com/openapi.json?token=secret#frag',
    ].join('\n');
    const out = redact(text);
    for (const leak of ['jane.doe', 'AbCdEf123456', 'zzz', '51Hxyz', 'whsec_abc', 'api03-AbC', 'AbCdEfGhIj', '0123456789abcdef', 'eyJhbGciOi', 'token=secret']) {
      expect(out, leak).not.toContain(leak);
    }
    expect(out).toContain('[email]');
    expect(out).toContain('l10p_[redacted]');
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('https://api.example.com/openapi.json');
  });

  it('leaves ordinary text alone', () => {
    const text = 'How do I rotate a CI key? See https://docs.latitude10.tech/registry/push.';
    expect(redact(text)).toBe(text);
  });
});

describe('redactValues, on a fixture trace', () => {
  // Shaped like what LangSmith's client is handed for a run: messages (as
  // LangChain objects), tool arguments and tool output.
  const trace = {
    messages: [
      new HumanMessage('I am ops@acme-billing.dev, my CI key l10p_LeakedKey123 fails'),
      new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'search_docs', args: { query: 'key for ops@acme-billing.dev' }, type: 'tool_call' }] }),
    ],
    tool: { input: { url: 'https://api.acme-billing.dev/openapi.json?api_key=sk_test_abc' }, output: 'Bearer abc.def.ghi' },
    nested: [[{ deep: 'lsv2_sk_deadbeef_cafe' }]],
    count: 3,
    flag: true,
    none: null,
  };

  it('loses its email, key and token, and keeps its shape', async () => {
    const out = await redactValues(trace);
    const text = JSON.stringify(out);
    for (const leak of ['ops@acme-billing.dev', 'l10p_LeakedKey123', 'api_key=', 'sk_test_abc', 'abc.def.ghi', 'deadbeef']) {
      expect(text, leak).not.toContain(leak);
    }
    expect(text).toContain('search_docs');
    expect(text).toContain('https://api.acme-billing.dev/openapi.json');
    expect(out).toMatchObject({ count: 3, flag: true, none: null });
  });

  it('does not change what the agent itself holds', async () => {
    await redactValues(trace);
    expect(trace.messages[0]!.content).toContain('ops@acme-billing.dev');
  });
});
