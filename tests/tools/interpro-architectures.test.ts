/**
 * @fileoverview Architecture discovery with native rows, modifiers, and continuation fixtures.
 * @module tests/tools/interpro-architectures
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failure, queuedFetch, settle, text, twin } from './contract-helpers.js';

let architectures: typeof import('@/mcp-server/tools/definitions/interpro-find-architectures.tool.js')['interproFindArchitectures'];
let init: typeof import('@/services/interpro/interpro-service.js')['initInterproService'];

const domain = {
  accession: 'PF00069',
  name: 'Pkinase',
  coordinates: [{ fragments: [{ start: 31, end: 283, status: 'complete' }], score: null }],
  flags: ['retained'],
};
const row = {
  ida: 'PF00069:IPR000719-PF00017:IPR000980',
  ida_id: '619edbb2b445bfa3ad51bd894e3c115b025a5f25',
  unique_proteins: 26,
  representative: {
    accession: 'B0E6J5',
    length: 490,
    domains: [
      domain,
      {
        accession: 'PF00017',
        name: 'SH2',
        coordinates: [
          {
            fragments: [
              { start: 384, end: 410 },
              { start: 415, end: 440 },
            ],
          },
          { fragments: [{ start: 450, end: 480 }] },
        ],
      },
    ],
    extra: { version: 1 },
  },
  unknown: [true, null],
};
const page = (rows: unknown[], next: string | null = null, count = rows.length) =>
  Response.json({ count, next, previous: null, results: rows });

function network(responses: Response[]) {
  const fetch = queuedFetch(responses);
  init(fetch);
  return fetch;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  ({ interproFindArchitectures: architectures } = await import(
    '@/mcp-server/tools/definitions/interpro-find-architectures.tool.js'
  ));
  ({ initInterproService: init } = await import('@/services/interpro/interpro-service.js'));
});
afterEach(() => vi.useRealTimers());

describe('architecture discovery', () => {
  it('passes native IDs and complete representative coordinates to both surfaces', async () => {
    const fetch = network([page([row])]);
    const result = await settle(
      runToolContract(architectures, { domains: [' pf00069 ', 'ipr000980'], cursor: ' ' }),
    );
    const output = twin(result);
    expect(output).toMatchObject({
      query: { domains: ['PF00069', 'IPR000980'], ordered: false, exact: false },
      architectures: [row],
      page: { total: 1, returned: 1, limit: 20, hasMore: false },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(fetch.mock.calls[0]?.[0] ?? '');
    expect(url.pathname).toBe('/interpro/api/entry/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ida_search: 'PF00069,IPR000980',
      page_size: '20',
    });
    const { interproFindProteinsByDomain } = await import(
      '@/mcp-server/tools/definitions/interpro-find-proteins-by-domain.tool.js'
    );
    const id = output.architectures[0].ida_id;
    const proteinFetch = network([
      page(
        [
          {
            metadata: { accession: 'B0E6J5', length: 490, source_database: 'unreviewed' },
            extra_fields: { ida_id: id },
          },
        ],
        null,
        26,
      ),
    ]);
    const proteins = twin(
      await settle(
        runToolContract(interproFindProteinsByDomain, {
          accession: 'PF00069',
          architectureId: id,
          taxonId: '1',
          reviewedOnly: false,
        }),
      ),
    );
    expect(proteins.page.total).toBe(26);
    expect(proteins.proteins[0].extra_fields.ida_id).toBe(row.ida_id);
    expect(new URL(proteinFetch.mock.calls[0]?.[0] ?? '').searchParams.get('ida')).toBe(row.ida_id);
  });

  it('keeps normalized filters and a fresh opaque cursor across three pages', async () => {
    const secondRow = { ...row, ida_id: 'd29104c18408f488a4fd5276036ed312bcfe2b11' };
    const fetch = network([
      page([row], 'https://ignored.example/outside?cursor=26%7Cfirst&ordered=false', 2),
      page([secondRow], '?cursor=3%7Csecond', 2),
      page([], null, 2),
    ]);
    const input = { domains: ['PF00069', 'PF00017', 'PF00069'], ignore: ['PF07714'], exact: true };
    const first = twin(await settle(runToolContract(architectures, { ...input, limit: 1 })));
    expect(first.query).toEqual({ ...input, ordered: true });
    expect(first.architectures).toEqual([row]);
    for (const changed of [
      { domains: ['PF00017', 'PF00069', 'PF00069'] },
      { ignore: ['PF00870'] },
      { exact: false, ordered: true },
    ]) {
      failure(
        await settle(
          runToolContract(architectures, { ...input, ...changed, cursor: first.page.nextCursor }),
        ),
        'invalid_cursor',
        architectures,
      );
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    const secondResult = await settle(
      runToolContract(architectures, {
        ...input,
        ordered: true,
        cursor: first.page.nextCursor,
        limit: 250,
      }),
    );
    const second = twin(secondResult);
    expect(second.architectures).toEqual([secondRow]);
    expect(second.page).toMatchObject({ limit: 200, hasMore: true });
    expect(text(secondResult)).toContain('was clamped to 200');
    const lastResult = await settle(
      runToolContract(architectures, { ...input, cursor: second.page.nextCursor }),
    );
    expect(twin(lastResult).page).toEqual({ total: 2, returned: 0, limit: 20, hasMore: false });
    expect(text(lastResult)).toContain('This continuation page is empty');
    const urls = fetch.mock.calls.map(([url]) => new URL(url));
    expect(urls.map((url) => url.searchParams.get('cursor'))).toEqual([
      null,
      '26|first',
      '3|second',
    ]);
    expect(urls.map((url) => url.searchParams.get('page_size'))).toEqual(['1', '200', '20']);
    for (const url of urls) {
      expect(url.href).toMatch(/^https:\/\/www\.ebi\.ac\.uk\/interpro\/api\/entry\/\?/);
      expect(url.searchParams.get('ordered')).toBe('');
      expect(url.searchParams.get('exact')).toBe('');
      expect(url.searchParams.get('ida_search')).toBe('PF00069,PF00017,PF00069');
      expect(url.searchParams.get('ida_ignore')).toBe('PF07714');
    }
  });

  it('returns an empty success for a valid-shaped domain with no results', async () => {
    const fetch = network([page([])]);
    const result = await settle(
      runToolContract(architectures, {
        domains: ['PF99999'],
        ignore: [],
        ordered: false,
        exact: false,
        limit: 201,
      }),
    );
    expect(twin(result)).toMatchObject({
      query: { domains: ['PF99999'], ordered: false, exact: false },
      architectures: [],
      page: { total: 0, returned: 0, limit: 200, hasMore: false },
    });
    expect(text(result)).toContain('InterPro found no architectures');
    expect(text(result)).toContain('was clamped to 200');
    expect(Object.fromEntries(new URL(fetch.mock.calls[0]?.[0] ?? '').searchParams)).toEqual({
      page_size: '200',
      ida_search: 'PF99999',
    });
  });

  it('continues a page with a long domain exclusion list', async () => {
    const fetch = network([page([row], '?cursor=next', 2), page([row], null, 2)]);
    const input = {
      domains: ['PF00069'],
      ignore: Array.from({ length: 300 }, (_, index) => `PF${String(20000 + index)}`),
      limit: 1,
    };
    const first = twin(await settle(runToolContract(architectures, input)));
    expect(first.page).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
    const second = twin(
      await settle(runToolContract(architectures, { ...input, cursor: first.page.nextCursor })),
    );
    expect(second.page).toEqual({ total: 2, returned: 1, limit: 1, hasMore: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { domains: [] },
    { domains: ['PF00069', 'PF00017,PF00870'] },
    { domains: ['PTHR11447'] },
    { domains: ['PF00069'], ignore: ['cd00165'] },
    { domains: ['PF00069'], limit: 0 },
  ])('rejects malformed input before requesting %j', async (input) => {
    const fetch = network([]);
    const result = await settle(runToolContract(architectures, input));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_arguments' } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    () => page([{ ...row, ida_id: 'invalid' }]),
    () => page([row], 'https://www.ebi.ac.uk/interpro/api/entry/?page_size=1'),
  ])('uses upstream recovery for an invalid row or continuation', async (response) => {
    const fetch = network([response()]);
    failure(
      await settle(runToolContract(architectures, { domains: ['PF00069'] })),
      'upstream_shape_invalid',
      architectures,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('returns the declared recovery when upstream rejects its continuation', async () => {
    const fetch = network([page([row], '?cursor=next', 2), new Response(null, { status: 404 })]);
    const input = { domains: ['PF00069'] };
    const first = twin(await settle(runToolContract(architectures, input)));
    const rejected = await settle(
      runToolContract(architectures, { ...input, cursor: first.page.nextCursor }),
    );
    failure(rejected, 'invalid_cursor', architectures);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('preserves upstream withdrawal status and recovery', async () => {
    network([Response.json({ accession: 'IPR011615' }, { status: 410 })]);
    const result = await settle(runToolContract(architectures, { domains: ['IPR011615'] }));
    failure(result, 'entry_withdrawn', architectures);
    expect(result.structuredContent).toMatchObject({
      error: { data: { accession: 'IPR011615', status: 410 } },
    });
  });
});
