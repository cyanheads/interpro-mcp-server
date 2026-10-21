/**
 * @fileoverview Public contract tests for local and live InterPro reference topics.
 * @module tests/tools/interpro-list-reference.tool
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('interpro_list_reference contract', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  });
  afterEach(() => vi.useRealTimers());

  async function setup(responses: Response[] = []) {
    const { initInterproService } = await import('@/services/interpro/interpro-service.js');
    const fetch = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected network operation');
      return response;
    });
    initInterproService(fetch);
    const { interproListReference } = await import(
      '@/mcp-server/tools/definitions/interpro-list-reference.tool.js'
    );
    return { definition: interproListReference, fetch };
  }

  it.each(['databases', 'entry_types', 'accession_patterns', 'taxa'] as const)(
    'returns complete %s vocabulary on both surfaces without network',
    async (topic) => {
      const { definition, fetch } = await setup();
      const result = await runToolContract(definition, { topic });
      expect(result.isError).not.toBe(true);
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      const json = text.match(/`+json\n([\s\S]*?)\n`+/)?.[1];
      expect(JSON.parse(json ?? '')).toEqual(result.structuredContent);
      expect(result.structuredContent).toMatchObject({ topic, items: expect.any(Array) });
      expect(fetch).not.toHaveBeenCalled();
      if (topic === 'databases') expect(text).toContain('profile');
      if (topic === 'taxa') expect(text).toContain('9606');
    },
  );

  it('lists every entry type the search filter accepts, including region', async () => {
    const { definition } = await setup();
    const { EntryTypeSchema } = await import('@/services/interpro/schemas.js');
    const result = await runToolContract(definition, { topic: 'entry_types' });
    const { items } = result.structuredContent as {
      items: { id: string; label: string; description: string }[];
    };
    expect(items.map((item) => item.id)).toEqual(EntryTypeSchema.options);
    expect(items.slice(-3)).toEqual([
      {
        id: 'region',
        label: 'Region',
        description:
          'A sequence region; AntiFam signatures of spurious protein predictions use this type.',
      },
      {
        id: 'coiled_coil',
        label: 'Coiled coil',
        description: 'A coiled-coil region, where alpha-helices wind around each other.',
      },
      {
        id: 'disordered',
        label: 'Disordered region',
        description:
          'An intrinsically disordered region without a fixed three-dimensional structure.',
      },
    ]);
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    for (const item of items.slice(-3)) expect(text).toContain(item.description);
  });

  it('returns nested live release counts through both consumption paths', async () => {
    const { definition, fetch } = await setup([
      Response.json({ '110.0': '2026-01-01' }),
      Response.json({ entries: { pfam: { entries: 99, nested: { unknown: null } } } }),
    ]);
    const pending = runToolContract(definition, { topic: 'release' });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      release: { databaseCounts: { entries: { pfam: { nested: { unknown: null } } } } },
    });
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(JSON.parse(text.match(/`+json\n([\s\S]*?)\n`+/)?.[1] ?? '')).toEqual(
      result.structuredContent,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns declared recovery with malformed upstream JSON on both error surfaces', async () => {
    const { definition } = await setup([new Response('{bad')]);
    const pending = runToolContract(definition, { topic: 'release' });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'upstream_shape_invalid',
          recovery: { hint: expect.stringContaining('interpro_list_reference') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('upstream_shape_invalid');
  });

  it('rejects missing topic through both error surfaces before network I/O', async () => {
    const { definition, fetch } = await setup();
    // The public runtime boundary accepts untrusted arguments despite its typed convenience API.
    const result = await runToolContract(
      definition,
      {} as Parameters<typeof definition.handler>[0],
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(JSON.stringify(result.content)).toContain('topic');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves cancellation on both surfaces and stops the release workflow', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const { definition, fetch } = await setup([new Response(new ReadableStream({ cancel }))]);
    const pending = runToolContract(
      definition,
      { topic: 'release' },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('reference request cancelled'));
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
    expect(JSON.stringify(result.content)).toContain('cancelled');
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['upstream_rejected', 403, false],
    ['upstream_unavailable', 503, true],
    ['upstream_timeout', 504, true],
    ['upstream_rate_limited', 429, true],
  ] as const)(
    'renders declared %s recovery on both surfaces',
    async (reason, status, retryable) => {
      const { definition, fetch } = await setup([
        new Response(null, { status }),
        new Response(null, { status }),
      ]);
      const pending = runToolContract(definition, { topic: 'release' });
      await vi.runAllTimersAsync();
      const result = await pending;
      const recovery = definition.errors?.find((error) => error.reason === reason)?.recovery;
      expect(recovery).toBeTruthy();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason, retryable, recovery: { hint: recovery } } },
      });
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(reason);
      expect(text).toContain(recovery ?? 'missing recovery');
      expect(fetch).toHaveBeenCalledTimes(retryable ? 2 : 1);
    },
  );

  it.each(['upstream_response_too_large', 'release_changed'] as const)(
    'renders declared %s recovery for multi-operation release failures',
    async (reason) => {
      const responses =
        reason === 'upstream_response_too_large'
          ? [new Response('x'.repeat(4 * 1024 * 1024 + 1))]
          : [
              Response.json({ '110.0': 'date' }, { headers: { 'interpro-version': '110.0' } }),
              Response.json({ entries: {} }, { headers: { 'interpro-version': '111.0' } }),
            ];
      const { definition } = await setup(responses);
      const pending = runToolContract(definition, { topic: 'release' });
      await vi.runAllTimersAsync();
      const result = await pending;
      const recovery = definition.errors?.find((error) => error.reason === reason)?.recovery;
      expect(recovery).toBeTruthy();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason, recovery: { hint: recovery } } },
      });
      const text = result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(reason);
      expect(text).toContain(recovery ?? 'missing recovery');
    },
  );
});
