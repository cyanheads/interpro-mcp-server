/**
 * @fileoverview Entry and clan contracts at the injected HTTP boundary.
 * @module tests/tools/interpro-entries
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let interproGetClan: typeof import('@/mcp-server/tools/definitions/interpro-get-clan.tool.js')['interproGetClan'];
let interproGetEntry: typeof import('@/mcp-server/tools/definitions/interpro-get-entry.tool.js')['interproGetEntry'];
let interproSearchEntries: typeof import('@/mcp-server/tools/definitions/interpro-search-entries.tool.js')['interproSearchEntries'];
let initInterproService: typeof import('@/services/interpro/interpro-service.js')['initInterproService'];

const summary = {
  accession: 'PF00870',
  source_database: 'pfam',
  name: null,
  future: { nested: [null, 'literal\n``` <b>[text]</b>'] },
};
const graph = {
  nodes: [{ id: 'PF00870', nested: { flag: true } }],
  links: [{ source: 'PF00870', target: 'PF00069', score: 0.8, method: ['alignment'] }],
};
const clan = {
  accession: 'CL0016',
  source_database: 'pfam',
  description: null,
  relationships: graph,
  wikipedia: { thumbnail: 'iVBORw0KGgoAAA', url: 'https://example.test/wiki?a=1&b=2' },
};
const list = (results: unknown[], next: string | null = null, count = results.length) =>
  Response.json({ count, next, previous: null, results });
const detail = (metadata: unknown) => Response.json({ metadata });

function network(responses: Response[]) {
  const fetch = vi.fn(async (_url: string) => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected upstream call');
    return response;
  });
  initInterproService(fetch);
  return fetch;
}
async function settle<T>(promise: Promise<T>): Promise<T> {
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
  expect(result.isError).not.toBe(true);
  const json = text(result).match(/`+json\n([\s\S]*?)\n`+/)?.[1];
  const domain = JSON.parse(json ?? '');
  expect(
    Object.fromEntries(
      Object.entries(result.structuredContent ?? {}).filter(
        ([key]) =>
          !['notice', 'totalCount', 'truncated', 'shown', 'cap', 'effectiveQuery', 'echo'].includes(
            key,
          ),
      ),
    ),
  ).toEqual(domain);
  return domain;
}
function failure(
  result: Awaited<ReturnType<typeof runToolContract>>,
  reason: string,
  definition: typeof interproGetEntry | typeof interproGetClan | typeof interproSearchEntries,
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
  ({ interproGetClan } = await import('@/mcp-server/tools/definitions/interpro-get-clan.tool.js'));
  ({ interproGetEntry } = await import(
    '@/mcp-server/tools/definitions/interpro-get-entry.tool.js'
  ));
  ({ interproSearchEntries } = await import(
    '@/mcp-server/tools/definitions/interpro-search-entries.tool.js'
  ));
  ({ initInterproService } = await import('@/services/interpro/interpro-service.js'));
});
afterEach(() => vi.useRealTimers());

describe('entry search contracts', () => {
  it('accepts documented GO and integration filters and emits their exact API names', async () => {
    const fetch = network([list([{ metadata: summary }])]);
    const result = await settle(
      runToolContract(interproSearchEntries, {
        sourceDatabase: 'pfam',
        goTerm: 'GO:0003677',
        integratedInto: 'IPR011615',
        goCategory: 'F',
        entryType: 'domain',
      }),
    );
    twin(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(fetch.mock.calls[0]?.[0] ?? '');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      go_term: 'GO:0003677',
      integrated: 'IPR011615',
      go_category: 'F',
      type: 'domain',
    });
  });
  it.each([0, 1, 2])('preserves sparse rows on a terminal page of %i records', async (count) => {
    const fetch = network([list(Array.from({ length: count }, () => ({ metadata: summary })))]);
    const result = await settle(
      runToolContract(interproSearchEntries, {
        sourceDatabase: 'pfam',
        limit: 2,
        query: '',
        entryType: '',
        goTerm: '',
        goCategory: '',
        integratedInto: '',
        cursor: '',
      }),
    );
    const output = twin(result);
    expect(output.entries).toEqual(Array.from({ length: count }, () => summary));
    expect(output.page).toEqual({ total: count, returned: count, limit: 2, hasMore: false });
    expect(result.structuredContent).toMatchObject({
      totalCount: count,
      effectiveQuery: JSON.stringify({ sourceDatabase: 'pfam' }),
    });
    expect(text(result)).toContain('{"sourceDatabase":"pfam"}');
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(fetch).toHaveBeenCalledTimes(1);
    if (!count) expect(text(result)).toContain('No entries matched');
  });

  it('continues at the fixed origin with a changed limit and rejects changed scope locally', async () => {
    const fetch = network([
      list([{ metadata: summary }], 'https://evil.test/private?cursor=opaque%7Cs%7Ctoken', 3),
      list([{ metadata: summary }]),
    ]);
    const first = await settle(
      runToolContract(interproSearchEntries, { sourceDatabase: 'pfam', query: 'p53', limit: 1 }),
    );
    const firstOutput = twin(first);
    expect(first.structuredContent).toMatchObject({
      truncated: true,
      shown: 1,
      cap: 1,
      totalCount: 3,
    });
    expect(text(first)).toContain('truncated');
    const cursor = firstOutput.page.nextCursor;
    const resumed = twin(
      await settle(
        runToolContract(interproSearchEntries, {
          sourceDatabase: 'pfam',
          query: 'p53',
          limit: 2,
          cursor,
        }),
      ),
    );
    expect(resumed.page.hasMore).toBe(false);
    const url = new URL(fetch.mock.calls[1]?.[0] ?? '');
    expect(url.origin).toBe('https://www.ebi.ac.uk');
    expect(url.pathname).toBe('/interpro/api/entry/pfam/');
    expect(url.searchParams.get('cursor')).toBe('opaque|s|token');
    expect(url.searchParams.get('page_size')).toBe('2');
    failure(
      await settle(
        runToolContract(interproSearchEntries, {
          sourceDatabase: 'pfam',
          query: 'changed',
          cursor,
        }),
      ),
      'invalid_cursor',
      interproSearchEntries,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('maps empty 204 and guides member accession searches', async () => {
    const fetch = network([new Response(null, { status: 204 })]);
    const result = await settle(runToolContract(interproSearchEntries, { query: 'PF00870' }));
    expect(twin(result).page.total).toBe(0);
    expect(text(result)).toContain('Use interpro_get_entry');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('entry metadata contracts', () => {
  it('retains complete deep metadata and renders every URL and normalized image', async () => {
    const entry = {
      ...summary,
      name: { name: null, short: 'p53' },
      description: [
        { text: '<b>literal</b>\n``` [citation] https://example.test/paper', checked: false },
      ],
      literature: { paper: { url: 'https://example.test/paper' } },
      hierarchy: { children: [{ children: [{ accession: 'IPR011615' }] }] },
      counters: { structural_models: 17 },
      wikipedia: {
        thumbnail: `iVBORw0KGgo${'A'.repeat(10000)}`,
        url: 'https://example.test/image.png',
      },
      go_terms: null,
    };
    const fetch = network([detail(entry)]);
    const result = await settle(
      runToolContract(interproGetEntry, { accession: 'pf00870', sourceDatabase: '' }),
    );
    const output = twin(result);
    expect(output).toMatchObject({
      accession: 'PF00870',
      sourceDatabase: 'pfam',
      entry: {
        ...entry,
        wikipedia: {
          ...entry.wikipedia,
          thumbnail: `data:image/png;base64,${entry.wikipedia.thumbnail}`,
        },
      },
    });
    expect(output.entry).not.toHaveProperty('gene');
    for (const url of [
      'https://example.test/paper',
      'https://example.test/image.png',
      output.url,
      output.sourceUrl,
    ])
      expect(text(result)).toContain(`](<${url}>)`);
    expect(text(result)).toContain(
      `![Image 1](<data:image/png;base64,${entry.wikipedia.thumbnail}>)`,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([204, 404, 410])(
    'renders recovery for detail HTTP %i without alternate lookups',
    async (status) => {
      const fetch = network([
        status === 410
          ? Response.json(
              { accession: 'PF00870', history: [{ replacement: 'PF00069' }], secret: 'private' },
              { status },
            )
          : new Response(null, { status }),
      ]);
      const result = await settle(runToolContract(interproGetEntry, { accession: 'PF00870' }));
      failure(result, status === 410 ? 'entry_withdrawn' : 'entry_not_found', interproGetEntry);
      expect(text(result)).not.toContain('private');
      if (status === 410)
        expect(result.structuredContent).toMatchObject({
          error: { data: { accession: 'PF00870', history: [{ replacement: 'PF00069' }] } },
        });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe('clan contracts', () => {
  it.each([
    ['Cl0016', undefined, 'accession_source_unknown', 'pfam', 'CL0016'],
    ['Cl0016', undefined, 'accession_source_unknown', 'cdd', 'cl0016'],
    ['CL0016', 'pirsf', 'database_mismatch', 'pfam', 'CL0016'],
    ['PIRSF000047', 'pfam', 'database_mismatch', 'pirsf', 'PIRSF000047'],
  ] as const)(
    'recovers clan routing for %s with explicit %s',
    async (accession, sourceDatabase, reason, correctedSource, correctedAccession) => {
      const fetch = network([
        detail({ accession: correctedAccession, source_database: correctedSource }),
        list([]),
      ]);
      const result = await settle(runToolContract(interproGetClan, { accession, sourceDatabase }));
      failure(result, reason, interproGetClan);
      const hint = interproGetClan.errors?.find((entry) => entry.reason === reason)?.recovery;
      expect(hint).toContain('uppercase CL');
      expect(hint).toContain('lowercase cl');
      expect(hint).toContain('mixed-case');
      expect(hint).toContain('PIRSF');
      expect(hint).not.toContain('interpro_search_entries');
      expect(fetch).not.toHaveBeenCalled();
      const recovered = twin(
        await settle(
          runToolContract(interproGetClan, { accession, sourceDatabase: correctedSource }),
        ),
      );
      expect(recovered).toMatchObject({
        accession: correctedAccession,
        sourceDatabase: correctedSource,
      });
      expect(new URL(fetch.mock.calls[0]?.[0] ?? '').pathname).toBe(
        `/interpro/api/set/${correctedSource}/${correctedAccession}/`,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it.each([false, true])(
    'projects the complete graph on both surfaces: %s',
    async (includeRelationships) => {
      const member = {
        metadata: summary,
        sets: [{ accession: 'CL0016', nested: ['retained'] }],
        unknown: null,
      };
      const fetch = network([detail(clan), list([member])]);
      const result = await settle(
        runToolContract(interproGetClan, {
          accession: 'CL0016',
          sourceDatabase: '',
          includeRelationships,
          limit: 1,
          cursor: '',
        }),
      );
      const output = twin(result);
      expect(output.members).toEqual([member]);
      expect(output.page).toEqual({ total: 1, returned: 1, limit: 1, hasMore: false });
      if (includeRelationships) expect(output.clan.relationships).toEqual(graph);
      else {
        expect(output.clan).not.toHaveProperty('relationships');
        expect(text(result)).toContain('Relationships are omitted');
      }
      expect(text(result)).toContain('![Image 1](<data:image/png;base64,iVBORw0KGgoAAA>)');
      expect(text(result)).toContain('](<https://example.test/wiki?a=1&amp;b=2>)');
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('accepts a changed member limit but rejects target and projection changes before I/O', async () => {
    const fetch = network([
      detail(clan),
      list([], '?cursor=members', 3),
      detail(clan),
      new Response(null, { status: 204 }),
    ]);
    const first = await settle(runToolContract(interproGetClan, { accession: 'CL0016', limit: 1 }));
    const cursor = twin(first).page.nextCursor;
    expect(first.structuredContent).toMatchObject({ truncated: true, totalCount: 3, shown: 0 });
    const last = await settle(
      runToolContract(interproGetClan, { accession: 'CL0016', cursor, limit: 3 }),
    );
    expect(twin(last).members).toEqual([]);
    expect(text(last)).toContain('member page is empty');
    expect(new URL(fetch.mock.calls[3]?.[0] ?? '').searchParams.get('page_size')).toBe('3');
    for (const input of [
      { accession: 'CL0016', includeRelationships: true, cursor },
      { accession: 'CL0017', cursor },
    ])
      failure(
        await settle(runToolContract(interproGetClan, input)),
        'invalid_cursor',
        interproGetClan,
      );
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('does not present metadata as success after a member request fails', async () => {
    const fetch = network([detail(clan), new Response(null, { status: 403 })]);
    failure(
      await settle(runToolContract(interproGetClan, { accession: 'CL0016' })),
      'upstream_rejected',
      interproGetClan,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('local routing and schema failures', () => {
  it.each([
    [400, 'upstream_rejected', 1],
    [501, 'upstream_unavailable', 1],
    [503, 'upstream_unavailable', 2],
    [408, 'upstream_timeout', 2],
    [429, 'upstream_rate_limited', 2],
  ] as const)(
    'preserves HTTP %i error/recovery on every entry workflow',
    async (status, reason, attempts) => {
      for (const [definition, input] of [
        [interproSearchEntries, {}],
        [interproGetEntry, { accession: 'PF00870' }],
        [interproGetClan, { accession: 'CL0016' }],
      ] as const) {
        const fetch = network(
          Array.from({ length: attempts }, () => new Response(null, { status })),
        );
        failure(await settle(runToolContract(definition, input)), reason, definition);
        expect(fetch).toHaveBeenCalledTimes(attempts);
      }
    },
  );
  it('preserves malformed/oversized response errors on every entry workflow', async () => {
    for (const [definition, input] of [
      [interproSearchEntries, {}],
      [interproGetEntry, { accession: 'PF00870' }],
      [interproGetClan, { accession: 'CL0016' }],
    ] as const) {
      for (const [body, reason] of [
        ['{bad', 'upstream_shape_invalid'],
        ['x'.repeat(4 * 1024 * 1024 + 1), 'upstream_response_too_large'],
      ] as const) {
        const fetch = network([new Response(body)]);
        failure(await settle(runToolContract(definition, input)), reason, definition);
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    }
  });
  it('rejects invalid integration semantics and reports missing clans', async () => {
    const fetch = network([new Response(null, { status: 204 })]);
    failure(
      await settle(runToolContract(interproSearchEntries, { integratedInto: 'IPR011615' })),
      'database_mismatch',
      interproSearchEntries,
    );
    failure(
      await settle(runToolContract(interproGetClan, { accession: 'CL0016' })),
      'clan_not_found',
      interproGetClan,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects unsafe arguments and semantic conflicts without network calls', async () => {
    const fetch = network([]);
    for (const accession of ['..', 'a/b', 'x%2fy', 'x?y', 'x\\y']) {
      const result = await settle(runToolContract(interproGetEntry, { accession }));
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
      expect(text(result)).toContain('accession');
    }
    failure(
      await settle(
        runToolContract(interproGetEntry, { accession: 'PF00870', sourceDatabase: 'interpro' }),
      ),
      'database_mismatch',
      interproGetEntry,
    );
    failure(
      await settle(runToolContract(interproGetEntry, { accession: 'unknown' })),
      'accession_source_unknown',
      interproGetEntry,
    );
    failure(
      await settle(runToolContract(interproGetClan, { accession: 'Cl0016' })),
      'accession_source_unknown',
      interproGetClan,
    );
    failure(
      await settle(
        runToolContract(interproGetClan, { accession: 'CL0016', sourceDatabase: 'pirsf' }),
      ),
      'database_mismatch',
      interproGetClan,
    );
    failure(
      await settle(runToolContract(interproSearchEntries, { cursor: 'invalid' })),
      'invalid_cursor',
      interproSearchEntries,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
