/**
 * @fileoverview Protein workflows tested through real handlers and injected HTTP Responses.
 * @module tests/tools/interpro-proteins
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '@/services/interpro/cursors.js';

let map: typeof import('@/mcp-server/tools/definitions/interpro-get-protein-domains.tool.js')['interproGetProteinDomains'];
let discovery: typeof import('@/mcp-server/tools/definitions/interpro-find-proteins-by-domain.tool.js')['interproFindProteinsByDomain'];
let init: typeof import('@/services/interpro/interpro-service.js')['initInterproService'];
const protein = {
  accession: 'P04637',
  length: 393,
  source_database: 'reviewed',
  gene: null,
  sequence: 'MEEP\nQSD',
  extra: { nested: ['retained'] },
};
const fragments = [
  { start: 10, end: 20, 'dc-status': 'N_TERMINAL_DISC' },
  { start: 30, end: 40, 'dc-status': 'C_TERMINAL_DISC' },
];
const location = {
  fragments,
  score: null,
  model: 'model',
  representative: true,
  extra: { url: 'https://example.test/model' },
};
const match = (accession = 'PF00870', locations = [location]) => ({
  metadata: { accession, source_database: 'pfam', name: null },
  proteins: [
    { accession: 'P04637', protein_length: 393, entry_protein_locations: locations, extra: [null] },
  ],
  extra: { retained: true },
});
const extra = {
  disorder: {
    accession: 'mobidb',
    source_database: 'mobidb_lite',
    locations: [location],
    extra: null,
  },
};
const detail = () => Response.json({ metadata: protein });
const page = (results: unknown[], next: string | null = null, count = results.length) =>
  Response.json({ count, previous: null, next, results });
function network(responses: Response[]) {
  const fetch = vi.fn(async (_url: string) => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected upstream call');
    return response;
  });
  init(fetch);
  return fetch;
}
async function settle<T>(promise: Promise<T>) {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}
function text(result: Awaited<ReturnType<typeof runToolContract>>) {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
function twin(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError, text(result)).not.toBe(true);
  const output = JSON.parse(text(result).match(/`+json\n([\s\S]*?)\n`+/)?.[1] ?? '');
  expect(
    Object.fromEntries(
      Object.entries(result.structuredContent ?? {}).filter(
        ([key]) =>
          !['notice', 'totalCount', 'truncated', 'shown', 'cap', 'effectiveQuery', 'echo'].includes(
            key,
          ),
      ),
    ),
  ).toEqual(output);
  return output;
}
function failure(
  result: Awaited<ReturnType<typeof runToolContract>>,
  reason: string,
  definition: typeof map | typeof discovery = map,
) {
  expect(result.isError).toBe(true);
  const contract = definition.errors?.find((entry) => entry.reason === reason);
  expect(contract).toBeDefined();
  expect(result.structuredContent).toMatchObject({
    error: { code: contract?.code, data: { reason, recovery: { hint: contract?.recovery } } },
  });
  expect(text(result)).toContain(contract?.recovery);
}
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  ({ interproGetProteinDomains: map } = await import(
    '@/mcp-server/tools/definitions/interpro-get-protein-domains.tool.js'
  ));
  ({ interproFindProteinsByDomain: discovery } = await import(
    '@/mcp-server/tools/definitions/interpro-find-proteins-by-domain.tool.js'
  ));
  ({ initInterproService: init } = await import('@/services/interpro/interpro-service.js'));
});
afterEach(() => vi.useRealTimers());

describe('protein workflow shared failure contracts', () => {
  it.each([
    [400, 'upstream_rejected', 1],
    [501, 'upstream_unavailable', 1],
    [503, 'upstream_unavailable', 2],
    [408, 'upstream_timeout', 2],
    [429, 'upstream_rate_limited', 2],
    [410, 'entry_withdrawn', 1],
  ] as const)('preserves HTTP %i reason and recovery', async (status, reason, attempts) => {
    for (const [definition, accession] of [
      [map, 'P04637'],
      [discovery, 'PF00870'],
    ] as const) {
      const fetch = network(Array.from({ length: attempts }, () => new Response(null, { status })));
      failure(await settle(runToolContract(definition, { accession })), reason, definition);
      expect(fetch).toHaveBeenCalledTimes(attempts);
    }
  });
  it('preserves malformed and oversized response contracts', async () => {
    for (const [definition, accession] of [
      [map, 'P04637'],
      [discovery, 'PF00870'],
    ] as const) {
      for (const [body, reason] of [
        ['{bad', 'upstream_shape_invalid'],
        ['x'.repeat(4 * 1024 * 1024 + 1), 'upstream_response_too_large'],
      ] as const) {
        const fetch = network([new Response(body)]);
        failure(await settle(runToolContract(definition, { accession })), reason, definition);
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    }
  });
});

describe('protein map', () => {
  it('shares fifty seconds across metadata, three match pages, and active extras', async () => {
    const responses = [
      detail(),
      page([match()], '?cursor=p2', 3),
      page([match()], '?cursor=p3', 3),
      page([match()], null, 3),
    ];
    const starts: number[] = [];
    const aborted = vi.fn();
    const fetch = vi.fn((_url: string, options?: RequestInit) => {
      starts.push(performance.now());
      const response = responses.shift();
      return new Promise<Response>((resolve, reject) => {
        const timer = response ? setTimeout(() => resolve(response), 11_000) : undefined;
        options?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            aborted(performance.now());
            reject(options.signal?.reason);
          },
          { once: true },
        );
      });
    });
    init(fetch);
    const pending = runToolContract(map, { accession: 'P04637', includeExtraFeatures: true });
    await vi.advanceTimersByTimeAsync(49_999);
    expect(starts).toEqual([0, 11_000, 22_000, 33_000, 44_000]);
    expect(aborted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: -32004,
        data: { reason: 'retry_deadline_exceeded', recovery: { hint: expect.any(String) } },
      },
    });
    const structured = result.structuredContent as {
      error: { data: { recovery: { hint: string } } };
    };
    expect(text(result)).toContain(structured.error.data.recovery.hint);
    expect(aborted).toHaveBeenCalledWith(50_000);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    [
      'P04637',
      175,
      393,
      [
        ['IPR011615', 100, 288],
        ['PF00870', 100, 288],
      ],
      ['IPR011615', 'PF00870'],
    ],
    [
      'P00533',
      858,
      1210,
      [
        ['IPR000719', 712, 979],
        ['IPR008266', 833, 845],
        ['IPR017441', 718, 745],
      ],
      ['IPR000719'],
    ],
  ] as const)(
    'retains the verified %s residue %i annotation selection',
    async (accession, residuePosition, length, records, selected) => {
      const rows = records.map(([entry, start, end]) => ({
        ...match(entry, [{ ...location, fragments: [{ start, end, 'dc-status': 'CONTINUOUS' }] }]),
        proteins: [
          {
            accession,
            protein_length: length,
            entry_protein_locations: [
              { ...location, fragments: [{ start, end, 'dc-status': 'CONTINUOUS' }] },
            ],
          },
        ],
      }));
      const fetch = network([
        Response.json({ metadata: { ...protein, accession, length } }),
        page(rows),
      ]);
      const output = twin(await settle(runToolContract(map, { accession, residuePosition })));
      expect(
        output.matches.map((row: { metadata: { accession: string } }) => row.metadata.accession),
      ).toEqual(selected);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it.each([10, 20, 30, 40])(
    'retains complete discontinuous locations and extras at inclusive residue %i',
    async (residuePosition) => {
      const fetch = network([detail(), page([match()]), Response.json(extra)]);
      const result = await settle(
        runToolContract(map, {
          accession: 'p04637',
          residuePosition,
          includeExtraFeatures: true,
          cursor: '',
        }),
      );
      const output = twin(result);
      expect(output.matches).toEqual([match()]);
      expect(output.extraFeatures).toEqual(extra);
      expect(output.protein).toEqual(protein);
      expect(output.coverage).toEqual({
        totalMatches: 1,
        scannedMatches: 1,
        returnedMatches: 1,
        complete: true,
        hasMore: false,
      });
      expect(result.structuredContent).toMatchObject({
        totalCount: 1,
        effectiveQuery: JSON.stringify({
          accession: 'P04637',
          residuePosition,
          includeExtraFeatures: true,
        }),
      });
      expect(text(result)).toContain('includeExtraFeatures');
      expect(text(result)).toContain('](<https://example.test/model>)');
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(new URL(fetch.mock.calls[2]?.[0] ?? '').searchParams.has('extra_features')).toBe(true);
    },
  );
  it('does not infer overlap in a discontinuity gap', async () => {
    const fetch = network([detail(), page([match()]), Response.json(extra)]);
    const result = await settle(
      runToolContract(map, {
        accession: 'P04637',
        residuePosition: 25,
        includeExtraFeatures: true,
      }),
    );
    const output = twin(result);
    expect(output.matches).toEqual([]);
    expect(output.extraFeatures).toEqual({});
    expect(output.coverage).toMatchObject({
      scannedMatches: 1,
      returnedMatches: 0,
      complete: true,
    });
    expect(text(result)).toContain('No match contains this position');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('sorts across multiple locations and proteins without losing nested records', async () => {
    const later = match('PF99999', [
      { ...location, fragments: [{ start: 100, end: 288, 'dc-status': 'CONTINUOUS' }] },
    ]);
    const earlier = {
      ...match('IPR011615'),
      proteins: [
        ...match().proteins,
        {
          ...match().proteins[0],
          accession: 'P04637',
          entry_protein_locations: [
            { ...location, fragments: [{ start: 1, end: 2, 'dc-status': 'CONTINUOUS' }] },
          ],
        },
      ],
    };
    const fetch = network([detail(), page([later, match('PF00001'), earlier])]);
    const output = twin(await settle(runToolContract(map, { accession: 'P04637' })));
    expect(output.matches).toEqual([earlier, match('PF00001'), later]);
    expect(output).not.toHaveProperty('extraFeatures');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])(
    'distinguishes extras omitted and proven empty: %s',
    async (includeExtraFeatures) => {
      const fetch = network([
        detail(),
        new Response(null, { status: 204 }),
        ...(includeExtraFeatures ? [Response.json({})] : []),
      ]);
      const result = await settle(
        runToolContract(map, { accession: 'P04637', includeExtraFeatures }),
      );
      const output = twin(result);
      if (includeExtraFeatures) expect(output.extraFeatures).toEqual({});
      else expect(output).not.toHaveProperty('extraFeatures');
      expect(output.coverage).toMatchObject({ totalMatches: 0, complete: true, hasMore: false });
      expect(text(result)).toContain('no returned signature matches');
      expect(fetch).toHaveBeenCalledTimes(includeExtraFeatures ? 3 : 2);
    },
  );
  it('caps traversal at three pages and keeps resumed final coverage incomplete', async () => {
    const fetch = network([
      detail(),
      page([match('PF00001')], '?cursor=p2', 4),
      page([match('PF00002')], '?cursor=p3', 4),
      page([match('PF00003')], 'https://evil.test/?cursor=p4', 4),
      detail(),
      page([], null, 4),
    ]);
    const first = await settle(runToolContract(map, { accession: 'P04637', residuePosition: 25 }));
    const output = twin(first);
    expect(output.coverage).toMatchObject({
      totalMatches: 4,
      scannedMatches: 3,
      returnedMatches: 0,
      complete: false,
      hasMore: true,
    });
    expect(first.structuredContent).toMatchObject({ truncated: true, cap: 600, shown: 0 });
    expect(text(first)).toContain('before concluding');
    expect(fetch).toHaveBeenCalledTimes(4);
    const resumed = await settle(
      runToolContract(map, {
        accession: 'P04637',
        residuePosition: 25,
        cursor: output.coverage.nextCursor,
      }),
    );
    expect(twin(resumed).coverage).toMatchObject({
      complete: false,
      hasMore: false,
      scannedMatches: 0,
    });
    expect(text(resumed)).toContain('Only the combined segments');
    expect(text(resumed)).not.toContain('No match contains this position');
    const url = new URL(fetch.mock.calls[5]?.[0] ?? '');
    expect(url.origin).toBe('https://www.ebi.ac.uk');
    expect(url.searchParams.get('cursor')).toBe('p4');
    expect(fetch).toHaveBeenCalledTimes(6);
    for (const selection of [
      { residuePosition: 24 },
      { residuePosition: 25, includeExtraFeatures: true },
    ])
      failure(
        await settle(
          runToolContract(map, {
            accession: 'P04637',
            ...selection,
            cursor: output.coverage.nextCursor,
          }),
        ),
        'invalid_cursor',
      );
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it.each(['repeat', 'later', 'extras'])('fails the whole call on %s failure', async (kind) => {
    const responses =
      kind === 'repeat'
        ? [detail(), page([match()], '?cursor=p2'), page([match()], '?cursor=p2')]
        : kind === 'later'
          ? [detail(), page([match()], '?cursor=p2'), new Response(null, { status: 403 })]
          : [detail(), page([match()]), new Response(null, { status: 403 })];
    const fetch = network(responses);
    failure(
      await settle(
        runToolContract(map, { accession: 'P04637', includeExtraFeatures: kind === 'extras' }),
      ),
      kind === 'repeat' ? 'upstream_shape_invalid' : 'upstream_rejected',
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('rejects out-of-range positions after metadata and before matches', async () => {
    const fetch = network([detail()]);
    failure(
      await settle(runToolContract(map, { accession: 'P04637', residuePosition: 394 })),
      'residue_out_of_range',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([204, 404])(
    'maps protein detail HTTP %i to a recoverable missing-record error',
    async (status) => {
      const fetch = network([new Response(null, { status })]);
      failure(await settle(runToolContract(map, { accession: 'P04637' })), 'protein_not_found');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects malformed positions and isoforms locally', async () => {
    const fetch = network([]);
    for (const input of [
      { accession: 'P04637-2' },
      { accession: 'P04637', residuePosition: 0 },
      { accession: 'P04637', residuePosition: 1.5 },
    ]) {
      expect((await settle(runToolContract(map, input))).structuredContent).toMatchObject({
        error: { code: -32602 },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('entry-scoped protein discovery', () => {
  const row = {
    metadata: protein,
    entries: [
      {
        accession: 'PF00870',
        entry_protein_locations: [location],
        protein_length: 393,
        entry_type: 'domain',
        entry_integrated: 'IPR011615',
      },
    ],
    taxa: [{ accession: '9606', lineage: [{ accession: '1', children: [{ accession: '2' }] }] }],
    extra: null,
  };
  it.each([true, false])(
    'applies reviewedOnly=%s without losing nested annotations or N+1 calls',
    async (reviewedOnly) => {
      const fetch = network([page([row])]);
      const result = await settle(
        runToolContract(discovery, {
          accession: 'pf00870',
          ...(reviewedOnly ? {} : { reviewedOnly: false }),
          sourceDatabase: '',
          cursor: '',
          limit: 1,
        }),
      );
      const output = twin(result);
      expect(output.query).toEqual({
        accession: 'PF00870',
        sourceDatabase: 'pfam',
        taxonId: '9606',
        reviewedOnly,
      });
      expect(result.structuredContent).toMatchObject({
        effectiveQuery: JSON.stringify(output.query),
        totalCount: 1,
      });
      expect(output.proteins).toEqual([row]);
      expect(output.page.hasMore).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(new URL(fetch.mock.calls[0]?.[0] ?? '').pathname).toBe(
        `/interpro/api/protein/${reviewedOnly ? 'reviewed' : 'uniprot'}/entry/pfam/PF00870/taxonomy/uniprot/9606/`,
      );
    },
  );
  it('supports empty intersections and changed limits while binding all selection fields', async () => {
    const fetch = network([
      page([row], '?cursor=proteins', 4),
      new Response(null, { status: 204 }),
    ]);
    const first = await settle(runToolContract(discovery, { accession: 'PF00870', limit: 1 }));
    const cursor = twin(first).page.nextCursor;
    expect(first.structuredContent).toMatchObject({ totalCount: 4, truncated: true });
    const last = await settle(
      runToolContract(discovery, { accession: 'PF00870', cursor, limit: 50 }),
    );
    expect(twin(last).page).toEqual({ total: 0, returned: 0, limit: 50, hasMore: false });
    expect(text(last)).toContain('reviewedOnly=false');
    for (const changed of [{ taxonId: '10090' }, { reviewedOnly: false }, { accession: 'PF00069' }])
      failure(
        await settle(runToolContract(discovery, { accession: 'PF00870', ...changed, cursor })),
        'invalid_cursor',
        discovery,
      );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid taxon, limits, and routing locally', async () => {
    const fetch = network([]);
    for (const input of [
      { taxonId: 'human' },
      { taxonId: '0' },
      { limit: 51 },
      { limit: 0 },
      { limit: 1.5 },
    ])
      expect(
        (await settle(runToolContract(discovery, { accession: 'PF00870', ...input })))
          .structuredContent,
      ).toMatchObject({ error: { code: -32602 } });
    failure(
      await settle(
        runToolContract(discovery, { accession: 'PF00870', sourceDatabase: 'interpro' }),
      ),
      'database_mismatch',
      discovery,
    );
    failure(
      await settle(runToolContract(discovery, { accession: 'unknown' })),
      'accession_source_unknown',
      discovery,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects upstream expired continuation with declared recovery', async () => {
    const cursor = encodeCursor(
      'interpro_find_proteins_by_domain',
      { accession: 'PF00870', sourceDatabase: 'pfam', taxonId: '9606', reviewedOnly: true },
      'expired',
    );
    const fetch = network([new Response(null, { status: 404 })]);
    failure(
      await settle(runToolContract(discovery, { accession: 'PF00870', cursor })),
      'invalid_cursor',
      discovery,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
