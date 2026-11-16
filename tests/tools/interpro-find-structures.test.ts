/**
 * @fileoverview PDB structure discovery tested through the real handler and injected HTTP Responses.
 * Fixtures are InterPro 111.0 responses; entry-route chain sequences are trimmed to 8 residues.
 * @module tests/tools/interpro-find-structures
 */
import { readFileSync } from 'node:fs';
import { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '@/services/interpro/cursors.js';
import { ChainSchema, PdbIdSchema } from '@/services/interpro/structure-schemas.js';
import {
  failure as assertFailure,
  queuedFetch,
  serverLines,
  settle,
  text,
  twin,
} from './contract-helpers.js';

type Json = Record<string, any>;
const fixtures: Record<string, Json> = JSON.parse(
  readFileSync(new URL('./fixtures/interpro-find-structures.json', import.meta.url), 'utf8'),
);
const fixture = (name: string): Json => structuredClone(fixtures[name] as Json);

let definition: typeof import('@/mcp-server/tools/definitions/interpro-find-structures.tool.js')['interproFindStructures'];
let init: typeof import('@/services/interpro/interpro-service.js')['initInterproService'];
const OPERATION = 'interpro_find_structures';
const PROTEIN_ROUTE = '/interpro/api/structure/pdb/protein/uniprot/P04637/';
const ENTRY_ROUTE = '/interpro/api/structure/pdb/entry/pfam/PF00870/';
const none = () => new Response(null, { status: 204 });
const status = (code: number) => new Response(null, { status: code });
/** One upstream list page holding `results`, with no continuation. */
const only = (results: Json[], count = results.length) =>
  Response.json({ count, next: null, previous: null, results });
function network(responses: Response[]) {
  const fetch = queuedFetch(responses);
  init(fetch);
  return fetch;
}
const urls = (fetch: ReturnType<typeof network>) => fetch.mock.calls.map(([url]) => new URL(url));
const call = (input: Json) => settle(runToolContract(definition, input as never));
const failure = (result: Parameters<typeof assertFailure>[0], reason: string) =>
  assertFailure(result, reason, definition);
const notice = (result: Awaited<ReturnType<typeof call>>) =>
  (result.structuredContent as { notice?: string }).notice ?? '';
const message = (result: Awaited<ReturnType<typeof call>>) =>
  (result.structuredContent as { error: { message: string } }).error.message;
const decoded = (token: string) => JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
/** The chains a page must carry: each upstream record unchanged, plus its structure's PDB ID. */
const lifted = (page: Json, key: 'proteins' | 'entries') =>
  page.results.flatMap((row: Json) =>
    row[key].map((record: Json) => ({ ...record, pdbId: row.metadata.accession })),
  );

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  ({ interproFindStructures: definition } = await import(
    '@/mcp-server/tools/definitions/interpro-find-structures.tool.js'
  ));
  ({ initInterproService: init } = await import('@/services/interpro/interpro-service.js'));
});
afterEach(() => vi.useRealTimers());

describe('protein target', () => {
  it('lists the first P04637 page: 20 structures from 1a1u in PDB ID order, chains lifted, on both surfaces', async () => {
    const fetch = network([Response.json(fixture('proteinP04637Page1'))]);
    const result = await call({ proteinAccession: 'P04637' });
    const output = twin(result);
    const [list] = urls(fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(list?.pathname).toBe(PROTEIN_ROUTE);
    expect(list?.searchParams.get('page_size')).toBe('20');
    expect(list?.searchParams.has('cursor')).toBe(false);
    expect(output.query).toEqual({ proteinAccession: 'P04637' });
    const ids: string[] = output.structures.map((row: Json) => row.metadata.accession);
    expect(ids).toHaveLength(20);
    expect([ids[0], ids.at(-1)]).toEqual(['1a1u', '1tup']);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(20);
    expect(output.structures[0]).toEqual({
      metadata: {
        accession: '1a1u',
        name: 'SOLUTION STRUCTURE DETERMINATION OF A P53 MUTANT DIMERIZATION DOMAIN, NMR, MINIMIZED AVERAGE STRUCTURE',
        source_database: 'pdb',
        experiment_type: 'nmr',
        resolution: null,
      },
      chainRecordCount: 2,
      chainRecordLimitReached: false,
    });
    const upstream = fixture('proteinP04637Page1');
    expect(output.structures).toEqual(
      upstream.results.map(({ metadata, proteins }: Json) => ({
        metadata,
        chainRecordCount: proteins.length,
        chainRecordLimitReached: false,
      })),
    );
    expect(output.chains).toEqual(lifted(upstream, 'proteins'));
    expect(output.chains.filter((record: Json) => record.pdbId === '1dt7')).toEqual([
      expect.objectContaining({ chain: 'X', accession: null, source_database: null }),
      expect.objectContaining({ chain: 'Y', accession: null, source_database: null }),
    ]);
    expect(output.chains.filter((record: Json) => record.pdbId === '1tsr')).toEqual(
      ['A', 'B', 'C'].map((chain) => ({
        accession: 'p04637',
        protein_length: 393,
        source_database: 'reviewed',
        organism: '9606',
        in_alphafold: true,
        chain,
        structure_protein_locations: [
          { fragments: [{ start: 1, end: 219, protein_start: 94, protein_end: 312 }] },
        ],
        pdbId: '1tsr',
      })),
    );
    expect(output.page).toEqual({
      total: 321,
      returned: 20,
      limit: 20,
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(decoded(output.page.nextCursor)).toEqual({
      v: 1,
      operation: OPERATION,
      scope: '{"proteinAccession":"P04637"}',
      upstreamCursor: 'source|s|1tup',
    });
    expect(result.structuredContent).toMatchObject({
      totalCount: 321,
      truncated: true,
      shown: 20,
      cap: 20,
      effectiveQuery: '{"proteinAccession":"P04637"}',
    });
    expect(notice(result)).toBe(
      'More structures remain: repeat interpro_find_structures with the same arguments and cursor set to page.nextCursor; limit may rise to 50 for larger pages.',
    );
    expect(output.sourceUrls).toEqual([list?.href]);
    serverLines(text(result));
  });

  it('canonicalizes a lowercase, padded accession to uppercase in the route, query, and scope', async () => {
    const fetch = network([Response.json(fixture('proteinP04637Page1'))]);
    const output = twin(await call({ proteinAccession: ' p04637 ' }));
    expect(urls(fetch)[0]?.pathname).toBe(PROTEIN_ROUTE);
    expect(output.query).toEqual({ proteinAccession: 'P04637' });
    expect(decoded(output.page.nextCursor).scope).toBe('{"proteinAccession":"P04637"}');
  });

  it('continues the keyset cursor at a changed limit, from 1uol onward', async () => {
    const fetch = network([
      Response.json(fixture('proteinP04637Page1')),
      Response.json(fixture('proteinP04637Page2')),
    ]);
    const first = twin(await call({ proteinAccession: 'P04637' }));
    const second = await call({
      proteinAccession: 'P04637',
      limit: 50,
      cursor: first.page.nextCursor,
    });
    const output = twin(second);
    const [, next] = urls(fetch);
    expect(next?.pathname).toBe(PROTEIN_ROUTE);
    expect(next?.searchParams.get('cursor')).toBe('source|s|1tup');
    expect(next?.searchParams.get('page_size')).toBe('50');
    const ids = output.structures.map((row: Json) => row.metadata.accession);
    expect(ids[0]).toBe('1uol');
    expect(ids.filter((id: string) => id <= '1tup')).toEqual([]);
    expect(output.page).toMatchObject({ total: 321, returned: 20, limit: 50, hasMore: true });
    expect(decoded(output.page.nextCursor).upstreamCursor).toBe('source|s|2foo');
    expect(notice(second)).not.toContain('limit may rise');
    expect(second.structuredContent).toMatchObject({ cap: 50, shown: 20 });
  });

  it('ends at an empty past-end continuation page with no total and no detail read', async () => {
    const cursor = encodeCursor(OPERATION, { proteinAccession: 'P04637' }, 'source|s|9zzz');
    const fetch = network([none()]);
    const result = await call({ proteinAccession: 'P04637', cursor });
    const output = twin(result);
    expect(output).toMatchObject({ structures: [], chains: [] });
    expect(output.page).toEqual({ returned: 0, limit: 20, hasMore: false });
    expect(output.sourceUrls).toHaveLength(1);
    expect(notice(result)).toBe(
      'This continuation page is empty: InterPro lists no further structure after the previous page.',
    );
    expect(result.structuredContent).not.toHaveProperty('totalCount');
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(urls(fetch)[0]?.searchParams.get('cursor')).toBe('source|s|9zzz');
  });

  it('rejects a cursor reused with another target or tool, or tampered, before any request', async () => {
    network([Response.json(fixture('proteinP04637Page1'))]);
    const { nextCursor } = twin(await call({ proteinAccession: 'P04637' })).page;
    const fetch = network([]);
    for (const input of [
      { entryAccession: 'PF00870', cursor: nextCursor },
      { proteinAccession: 'P00918', cursor: nextCursor },
      {
        proteinAccession: 'P04637',
        cursor: encodeCursor(
          'interpro_find_proteins_by_domain',
          { proteinAccession: 'P04637' },
          'source|s|1tup',
        ),
      },
      { proteinAccession: 'P04637', cursor: 'garbage' },
    ])
      failure(await call(input), 'invalid_cursor');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([400, 404])('reports an upstream %i on continuation as invalid_cursor', async (code) => {
    const cursor = encodeCursor(OPERATION, { proteinAccession: 'P04637' }, 'expired');
    const fetch = network([status(code)]);
    failure(await call({ proteinAccession: 'P04637', cursor }), 'invalid_cursor');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['204', none],
    ['an empty 200 page', () => only([])],
  ])(
    'succeeds empty for Q6GZX4 after %s and one detail read that finds the protein',
    async (_label, empty) => {
      const fetch = network([empty(), Response.json(fixture('proteinQ6GZX4Detail'))]);
      const result = await call({ proteinAccession: 'Q6GZX4' });
      const output = twin(result);
      expect(output).toMatchObject({ structures: [], chains: [] });
      expect(output.page).toEqual({ total: 0, returned: 0, limit: 20, hasMore: false });
      const [list, detail] = urls(fetch);
      expect(list?.pathname).toBe('/interpro/api/structure/pdb/protein/uniprot/Q6GZX4/');
      expect(detail?.pathname).toBe('/interpro/api/protein/uniprot/Q6GZX4/');
      expect(output.sourceUrls).toEqual([list?.href, detail?.href]);
      expect(notice(result)).toBe(
        'InterPro lists no PDB structure for protein Q6GZX4; interpro_get_protein_domains maps its signatures on the UniProt sequence.',
      );
      expect(result.structuredContent).toMatchObject({ totalCount: 0 });
      serverLines(text(result));
    },
  );

  it.each([204, 404])(
    'reports Z9ZZZ9 as protein_not_found when its detail answers %i',
    async (code) => {
      const fetch = network([none(), status(code)]);
      const result = await call({ proteinAccession: 'Z9ZZZ9' });
      failure(result, 'protein_not_found');
      expect(message(result)).toBe('InterPro could not find protein Z9ZZZ9 in uniprot.');
      expect(result.structuredContent).toMatchObject({
        error: { data: { accession: 'Z9ZZZ9', sourceDatabase: 'uniprot', status: code } },
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('reports a list 404 for the protein as protein_not_found with one request', async () => {
    const fetch = network([status(404)]);
    failure(await call({ proteinAccession: 'Z9ZZZ9' }), 'protein_not_found');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [410, 'entry_withdrawn'],
    [403, 'upstream_rejected'],
    [503, 'upstream_unavailable'],
    [504, 'upstream_timeout'],
    [429, 'upstream_rate_limited'],
  ] as const)(
    'propagates a detail-read HTTP %i as %s after an empty first page',
    async (code, reason) => {
      // Two answers, so the service's own retry policy decides how many it reads.
      const fetch = network([none(), status(code), status(code)]);
      failure(await call({ proteinAccession: 'Q6GZX4' }), reason);
      const [list, ...detail] = urls(fetch).map((url) => url.pathname);
      expect(list).toBe('/interpro/api/structure/pdb/protein/uniprot/Q6GZX4/');
      expect(detail.length).toBeGreaterThan(0);
      for (const path of detail) expect(path).toBe('/interpro/api/protein/uniprot/Q6GZX4/');
    },
  );

  it('flags a 3j3q row carrying 20 chain records and routes to interpro_get_structure_domains', async () => {
    network([Response.json(fixture('proteinQ79791With3j3q'))]);
    const result = await call({ proteinAccession: 'Q79791', limit: 1 });
    const output = twin(result);
    expect(output.structures).toEqual([
      {
        metadata: {
          accession: '3j3q',
          name: 'Atomic-level structure of the entire HIV-1 capsid',
          source_database: 'pdb',
          experiment_type: 'em',
          resolution: null,
        },
        chainRecordCount: 20,
        chainRecordLimitReached: true,
      },
    ]);
    expect(output.chains).toHaveLength(20);
    expect(notice(result)).toContain(
      "InterPro nests at most 20 chain records in one structure row, and one row carries that many (3j3q), so chains may omit some of its chains for this target. interpro_get_structure_domains with a capped row's metadata.accession as pdbId lists every protein chain in structure.chains; set chain there to read one chain completely.",
    );
    expect(notice(result)).toContain('page.nextCursor');
  });

  it('does not flag a row one chain record below the nesting limit', async () => {
    const page = fixture('proteinQ79791With3j3q');
    page.results[0].proteins.pop();
    network([only(page.results)]);
    const result = await call({ proteinAccession: 'Q79791' });
    expect(twin(result).structures[0]).toMatchObject({
      chainRecordCount: 19,
      chainRecordLimitReached: false,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it.each([
    [{}, 'Set proteinAccession or entryAccession.'],
    [{ sourceDatabase: 'pfam' }, 'Set proteinAccession or entryAccession.'],
    [{ proteinAccession: ' ', entryAccession: '' }, 'Set proteinAccession or entryAccession.'],
    [
      { proteinAccession: 'P04637', entryAccession: 'PF00870' },
      'proteinAccession and entryAccession are exclusive; set exactly one.',
    ],
    [
      { proteinAccession: 'P04637', sourceDatabase: 'pfam' },
      'sourceDatabase applies only beside entryAccession, never beside proteinAccession.',
    ],
  ])('rejects target %j as invalid_target before any request', async (input, expected) => {
    const fetch = network([]);
    const result = await call(input);
    failure(result, 'invalid_target');
    expect(message(result)).toBe(expected);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats blank entry fields beside a protein as omitted', async () => {
    const fetch = network([Response.json(fixture('proteinP04637Page1'))]);
    const output = twin(
      await call({ proteinAccession: 'P04637', entryAccession: '  ', sourceDatabase: '' }),
    );
    expect(output.query).toEqual({ proteinAccession: 'P04637' });
    expect(urls(fetch)[0]?.pathname).toBe(PROTEIN_ROUTE);
  });

  it.each([
    { proteinAccession: 'P04637-2' },
    { proteinAccession: 'NOTANACC' },
    { entryAccession: 'PF00870/x' },
    { proteinAccession: 'P04637', limit: 0 },
    { proteinAccession: 'P04637', limit: 1.5 },
    { proteinAccession: 'P04637', chain: 'A' },
  ])('rejects %j as an argument failure before any request', async (input) => {
    const fetch = network([]);
    expect((await call(input)).structuredContent).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_arguments' } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 20],
    [1, 1],
    [49, 49],
    [50, 50],
    [51, 50],
    [500, 50],
  ])(
    'pages at the effective limit for %s, clamping above 50 with a notice',
    async (requested, expected) => {
      const fetch = network([Response.json(fixture('proteinP04637Page1'))]);
      const result = await call({
        proteinAccession: 'P04637',
        ...(requested === undefined ? {} : { limit: requested }),
      });
      expect(twin(result).page.limit).toBe(expected);
      expect(urls(fetch)[0]?.searchParams.get('page_size')).toBe(String(expected));
      expect(result.structuredContent).toMatchObject({ cap: expected });
      const clamp = `Requested limit ${requested} was clamped to 50.`;
      if (requested !== undefined && requested > 50) expect(notice(result)).toContain(clamp);
      else expect(notice(result)).not.toContain('clamped');
      expect(notice(result).includes('limit may rise to 50')).toBe(expected < 50);
    },
  );

  it('advertises limit with a default and no maximum, and no required target', () => {
    const schema = z.toJSONSchema(definition.input, { io: 'input' }) as Json;
    expect(schema.properties.limit).toMatchObject({ default: 20, minimum: 1 });
    // Only the integer bound Zod emits for z.int(); 50 is a clamp, not an advertised maximum.
    expect(schema.properties.limit.maximum ?? Number.MAX_SAFE_INTEGER).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(schema.required ?? []).toEqual([]);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'cursor',
      'entryAccession',
      'limit',
      'proteinAccession',
      'sourceDatabase',
    ]);
  });
});

describe('entry target', () => {
  it('lists the first PF00870 page with entry-route chain records in every numbering', async () => {
    const fetch = network([Response.json(fixture('entryPF00870Page1'))]);
    const result = await call({ entryAccession: 'PF00870' });
    const output = twin(result);
    const [list] = urls(fetch);
    expect(list?.pathname).toBe(ENTRY_ROUTE);
    expect(output.query).toEqual({ entryAccession: 'PF00870', sourceDatabase: 'pfam' });
    expect(output.page).toMatchObject({ total: 233, returned: 20, hasMore: true });
    expect(decoded(output.page.nextCursor)).toMatchObject({
      scope: '{"entryAccession":"PF00870","sourceDatabase":"pfam"}',
      upstreamCursor: 'source|s|2ioi',
    });
    expect(output.structures[0].metadata).toMatchObject({
      accession: '1gzh',
      experiment_type: 'x-ray',
      resolution: 2.6,
    });
    expect(output.chains).toEqual(lifted(fixture('entryPF00870Page1'), 'entries'));
    const tsr = output.chains.filter((record: Json) => record.pdbId === '1tsr');
    expect(tsr.map((record: Json) => record.chain)).toEqual(['A', 'B', 'C']);
    for (const record of tsr) {
      expect(record).toMatchObject({ accession: 'PF00870', protein: 'p04637' });
      expect(record.entry_structure_locations[0].fragments).toEqual([
        { start: 7, end: 195, 'dc-status': 'CONTINUOUS', auth_start: 100, auth_end: 288 },
      ]);
      expect(record.entry_protein_locations[0].fragments).toEqual([
        { start: 100, end: 288, 'dc-status': 'CONTINUOUS' },
      ]);
    }
    expect(result.structuredContent).toMatchObject({
      totalCount: 233,
      effectiveQuery: '{"entryAccession":"PF00870","sourceDatabase":"pfam"}',
    });
    serverLines(text(result));
  });

  it.each([
    ['IPR011615', undefined, '/interpro/api/structure/pdb/entry/interpro/IPR011615/', 'interpro'],
    ['cd08367', undefined, '/interpro/api/structure/pdb/entry/cdd/cd08367/', 'cdd'],
    ['CD08367', 'cdd', '/interpro/api/structure/pdb/entry/cdd/cd08367/', 'cdd'],
    ['pf00870', 'pfam', ENTRY_ROUTE, 'pfam'],
  ])('routes %s (sourceDatabase %s) by its prefix', async (accession, source, path, database) => {
    const fetch = network([Response.json(fixture('entryPF00870With6lhd'))]);
    const output = twin(
      await call({ entryAccession: accession, ...(source ? { sourceDatabase: source } : {}) }),
    );
    expect(urls(fetch)[0]?.pathname).toBe(path);
    expect(output.query).toEqual({
      entryAccession: path.split('/').at(-2),
      sourceDatabase: database,
    });
  });

  it('keeps 6zj3 unmapped chains SD and SE: null protein and length, empty protein locations', async () => {
    network([Response.json(fixture('entryCd00165With6zj3'))]);
    const output = twin(await call({ entryAccession: 'cd00165', limit: 1 }));
    expect(output.chains.map((record: Json) => record.chain)).toEqual(['SD', 'SE']);
    for (const record of output.chains)
      expect(record).toMatchObject({
        pdbId: '6zj3',
        protein: null,
        protein_length: null,
        entry_integrated: null,
        entry_protein_locations: [],
      });
    expect(output.chains).toEqual(lifted(fixture('entryCd00165With6zj3'), 'entries'));
  });

  it('keeps a null entry_protein_locations on a mapped 6lhd chain null', async () => {
    network([Response.json(fixture('entryPF00870With6lhd'))]);
    const output = twin(await call({ entryAccession: 'PF00870' }));
    const chainB = output.chains.find((record: Json) => record.chain === 'B');
    expect(chainB).toMatchObject({
      pdbId: '6lhd',
      protein: 'q07817',
      entry_protein_locations: null,
    });
    expect(output.page).toEqual({ total: 233, returned: 1, limit: 20, hasMore: false });
  });

  it('flags 3j3q on PF00607 with 20 entry chain records', async () => {
    network([Response.json(fixture('entryPF00607With3j3q'))]);
    const result = await call({ entryAccession: 'PF00607', limit: 1 });
    const output = twin(result);
    expect(output.structures[0]).toMatchObject({
      metadata: { accession: '3j3q' },
      chainRecordCount: 20,
      chainRecordLimitReached: true,
    });
    expect(notice(result)).toContain('(3j3q)');
    expect(notice(result)).toContain('interpro_get_structure_domains');
  });

  it('names every capped row when several carry the nesting limit', async () => {
    const row = fixture('entryPF00607With3j3q').results[0];
    const second = structuredClone(row);
    second.metadata.accession = '3j3y';
    const hostile = structuredClone(row);
    hostile.metadata.accession = '**3j3q**';
    network([only([row, second, hostile])]);
    const result = await call({ entryAccession: 'PF00607' });
    expect(notice(result)).toContain(
      'and 3 rows carry that many (3j3q, 3j3y), so chains may omit some of their chains',
    );
    expect(notice(result)).not.toContain('**');
  });

  it('succeeds empty for PF17818 after one detail read that finds the entry', async () => {
    const fetch = network([none(), Response.json(fixture('entryPF17818Detail'))]);
    const result = await call({ entryAccession: 'PF17818' });
    const output = twin(result);
    expect(output.page).toEqual({ total: 0, returned: 0, limit: 20, hasMore: false });
    expect(urls(fetch).map((url) => url.pathname)).toEqual([
      '/interpro/api/structure/pdb/entry/pfam/PF17818/',
      '/interpro/api/entry/pfam/PF17818/',
    ]);
    expect(notice(result)).toBe(
      'InterPro lists no PDB structure that entry PF17818 in pfam matches; interpro_find_proteins_by_domain lists the proteins that carry it.',
    );
  });

  it.each([204, 404])(
    'reports PF99999 as entry_not_found when its detail answers %i',
    async (code) => {
      const fetch = network([none(), status(code)]);
      const result = await call({ entryAccession: 'PF99999' });
      failure(result, 'entry_not_found');
      expect(message(result)).toBe('InterPro could not find entry PF99999 in pfam.');
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('reports a list 404 for an accession invalid in its database as entry_not_found', async () => {
    const fetch = network([
      new Response('{"Error":"the level \'PF1\' is not a valid pdb level"}', { status: 404 }),
    ]);
    const result = await call({ entryAccession: 'PF1', sourceDatabase: 'pfam' });
    failure(result, 'entry_not_found');
    expect(text(result)).not.toContain('valid pdb level');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('routes CL0016, a mismatched database, and an unknown prefix locally', async () => {
    const fetch = network([]);
    const set = await call({ entryAccession: 'CL0016' });
    expect(set.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'entry_not_found',
          recovery: {
            hint: 'Call interpro_get_clan with this accession to read the set and its member entries.',
          },
        },
      },
    });
    const mismatch = await call({ entryAccession: 'PF00870', sourceDatabase: 'smart' });
    failure(mismatch, 'database_mismatch');
    expect(message(mismatch)).toBe(
      'Accession PF00870 routes to sourceDatabase pfam by its prefix, not smart.',
    );
    failure(await call({ entryAccession: 'unknown' }), 'accession_source_unknown');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('binds sourceDatabase into the cursor scope and continues at a changed limit', async () => {
    const fetch = network([
      Response.json(fixture('entryPF00870Page1')),
      Response.json(fixture('entryPF00870With6lhd')),
    ]);
    const { nextCursor } = twin(await call({ entryAccession: 'PF00870' })).page;
    failure(await call({ entryAccession: 'IPR011615', cursor: nextCursor }), 'invalid_cursor');
    failure(
      await call({ entryAccession: 'PF00870', sourceDatabase: 'interpro', cursor: nextCursor }),
      'database_mismatch',
    );
    const last = twin(await call({ entryAccession: 'PF00870', limit: 5, cursor: nextCursor }));
    expect(last.page).toEqual({ total: 233, returned: 1, limit: 5, hasMore: false });
    const [, next] = urls(fetch);
    expect(next?.searchParams.get('cursor')).toBe('source|s|2ioi');
    expect(next?.searchParams.get('page_size')).toBe('5');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('identifiers for interpro_get_structure_domains', () => {
  it('passes every listed PDB ID and chain, as returned, through its input schema', async () => {
    const { interproGetStructureDomains } = await import(
      '@/mcp-server/tools/definitions/interpro-get-structure-domains.tool.js'
    );
    network([Response.json(fixture('proteinP04637Page1'))]);
    const output = twin(await call({ proteinAccession: 'P04637' }));
    const chain = output.chains.find(
      (record: Json) => record.pdbId === '1tsr' && record.chain === 'B',
    );
    expect(
      interproGetStructureDomains.input.parse({ pdbId: chain.pdbId, chain: chain.chain }),
    ).toMatchObject({
      pdbId: '1tsr',
      chain: 'B',
    });
    for (const name of Object.keys(fixtures))
      for (const row of fixtures[name]?.results ?? []) {
        expect(PdbIdSchema.safeParse(row.metadata.accession).success).toBe(true);
        for (const record of row.proteins ?? row.entries)
          expect(ChainSchema.safeParse(record.chain).data).toBe(record.chain);
      }
  });
});
