/**
 * @fileoverview interpro_scan_sequence and interpro_get_scan_result through their public contracts,
 * with the network stubbed at the fetch seam below the service's retry, deadline, and status mapping.
 * @module tests/tools/interpro-sequence-scan
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interproGetScanResult } from '@/mcp-server/tools/definitions/interpro-get-scan-result.tool.js';
import { interproScanSequence } from '@/mcp-server/tools/definitions/interpro-scan-sequence.tool.js';
import { jsonByteLength, RESPONSE_BYTE_BUDGET } from '@/services/interpro/budget.js';
import { cursorScope, encodePositionCursor } from '@/services/interpro/cursors.js';
import { parseSequence } from '@/services/sequence-scan/sequence.js';
import { initSequenceScanService } from '@/services/sequence-scan/sequence-scan-service.js';
import akt1Result from '../services/fixtures/sequence-scan/iprscan6-akt1-variant.json' with {
  type: 'json',
};
import calmodulinResult from '../services/fixtures/sequence-scan/iprscan6-calmodulin-variant.json' with {
  type: 'json',
};
import matchesBatch from '../services/fixtures/sequence-scan/matches-batch.json' with {
  type: 'json',
};
import sequences from '../services/fixtures/sequence-scan/sequences.json' with { type: 'json' };
import { failure, serverLines, settle, text, twin } from './contract-helpers.js';

const EMAIL = 'scan-operator@example.test';
const CALMODULIN_MD5 = 'EBD0AA0BC77B635530A6938487B7099B';
const AKT1_MD5 = '1620296E269940B19BAFA78CA71E003A';
const VARIANT_MD5 = '6A4866B2B971131F9DA9B818F1E3508B';
const JOB = 'iprscan6-R20261028-131532-0930-13189043-p1m';
type Match = (typeof matchesBatch.results)[number]['matches'][number];

const precalculated = (md5: string) =>
  matchesBatch.results.find((entry) => entry.md5 === md5 && entry.found)?.matches as Match[];
/** Copies of real records under distinct accessions, enough to overflow the response budget. */
const inflate = (matches: readonly Match[], copies: number) =>
  Array.from({ length: copies }, (_, copy) =>
    matches.map((match) => ({
      ...match,
      signature: { ...match.signature, accession: `${match.signature.accession}-copy${copy}` },
    })),
  ).flat();
const plain = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } });
const notice = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { notice?: string } | undefined)?.notice;

interface Routes {
  matches?: (md5: string) => { found: boolean; matches: unknown[] };
  result?: (jobId: string) => Response;
  status?: (jobId: string) => string;
}
/** `email: null` leaves submission unconfigured; omitted, the test address is configured. */
function network(routes: Routes = {}, email: string | null = EMAIL) {
  const calls: { kind: string; url: string; body: string }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const { pathname } = new URL(url);
    const body = typeof init.body === 'string' ? init.body : '';
    if (pathname.endsWith('/matches')) {
      calls.push({ kind: 'matches', url, body });
      const md5 = JSON.parse(body).md5[0] as string;
      const found = routes.matches?.(md5) ?? {
        found: Boolean(precalculated(md5)),
        matches: precalculated(md5) ?? [],
      };
      return Response.json({ results: [{ md5, ...found }] });
    }
    if (pathname.endsWith('/run')) {
      calls.push({ kind: 'run', url, body });
      return plain(JOB);
    }
    const jobId = pathname.split('/').find((segment) => segment.startsWith('iprscan6-')) ?? '';
    if (pathname.includes('/status/')) {
      calls.push({ kind: 'status', url, body });
      return plain(routes.status?.(jobId) ?? 'RUNNING');
    }
    calls.push({ kind: 'result', url, body });
    return routes.result?.(jobId) ?? Response.json(calmodulinResult);
  });
  initSequenceScanService(email ?? undefined, fetch);
  return { calls, kinds: () => calls.map((call) => call.kind) };
}
const scan = (input: Parameters<typeof runToolContract<typeof interproScanSequence>>[1]) =>
  settle(runToolContract(interproScanSequence, input));
const read = (input: Parameters<typeof runToolContract<typeof interproGetScanResult>>[1]) =>
  settle(runToolContract(interproGetScanResult, input));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('interpro_scan_sequence precalculated path', () => {
  it.each([EMAIL, null])(
    'returns calmodulin P0DP23 matches on both surfaces with no Job Dispatcher request (address %s)',
    async (email) => {
      const net = network({}, email);
      const result = await scan({ sequence: sequences.calmodulinFasta });
      const output = twin(result);
      expect(output).toMatchObject({
        source: 'precalculated',
        status: 'finished',
        md5: CALMODULIN_MD5,
        length: 149,
        coverage: { totalMatches: 23, offset: 0, returnedMatches: 23, hasMore: false },
        sourceUrl: 'https://www.ebi.ac.uk/interpro/matches/api/matches',
      });
      expect(output).not.toHaveProperty('jobId');
      expect(new Set(output.matches)).toEqual(new Set(precalculated(CALMODULIN_MD5)));
      const starts = output.matches.map((match: Match) =>
        Math.min(...match.locations.map((location) => location.start)),
      );
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      expect(result.structuredContent).toMatchObject({ totalCount: 23 });
      serverLines(text(result));
      expect(net.kinds()).toEqual(['matches']);
    },
  );

  it('returns all 113 AKT1 P31749 matches in one segment under the budget', async () => {
    network();
    const result = await scan({ sequence: sequences.akt1 });
    const output = twin(result);
    expect(output.coverage).toEqual({
      totalMatches: 113,
      offset: 0,
      returnedMatches: 113,
      hasMore: false,
    });
    expect(jsonByteLength(output)).toBeLessThan(RESPONSE_BYTE_BUDGET);
  });

  it('splits an over-budget result into whole-match segments that a cursor walk reassembles', async () => {
    const big = inflate(precalculated(AKT1_MD5), 4);
    const net = network({ matches: () => ({ found: true, matches: big }) });
    const seen: Match[] = [];
    let cursor: string | undefined;
    let segments = 0;
    do {
      const result = await scan({ sequence: sequences.akt1, ...(cursor ? { cursor } : {}) });
      const output = twin(result);
      expect(jsonByteLength(output)).toBeLessThanOrEqual(RESPONSE_BYTE_BUDGET);
      expect(output.coverage.offset).toBe(seen.length);
      expect(output.coverage.totalMatches).toBe(big.length);
      seen.push(...output.matches);
      cursor = output.coverage.nextCursor;
      expect(output.coverage.hasMore).toBe(cursor !== undefined);
      if (cursor) {
        expect(result.structuredContent).toMatchObject({
          truncated: true,
          shown: output.matches.length,
        });
        expect(notice(result)).toContain('interpro_scan_sequence');
        serverLines(text(result));
      }
      segments++;
    } while (cursor);
    expect(segments).toBeGreaterThanOrEqual(3);
    expect(seen).toHaveLength(big.length);
    // Key order may differ after validation; records compare as canonical JSON.
    expect(new Set(seen.map(cursorScope))).toEqual(new Set(big.map(cursorScope)));
    expect(net.kinds().every((kind) => kind === 'matches')).toBe(true);
  });

  it('names a continuation an agent can run as printed, with no placeholder argument', async () => {
    network({ matches: () => ({ found: true, matches: inflate(precalculated(AKT1_MD5), 4) }) });
    const result = await scan({ sequence: sequences.akt1 });
    expect(twin(result).coverage.nextCursor).toBeDefined();
    const printed = notice(result) ?? '';
    // Any JSON arguments the notice prints must be a call that runs as written.
    for (const [, json] of printed.matchAll(/interpro_scan_sequence (\{.*?\})(?= before)/g))
      expect(parseSequence(JSON.parse(json ?? '{}').sequence ?? '').ok).toBe(true);
    expect(printed).toContain(
      'interpro_scan_sequence, passing the same sequence and cursor set to coverage.nextCursor,',
    );
  });

  it('reports a precalculated result with no matches as an empty, complete result', async () => {
    network({ matches: () => ({ found: true, matches: [] }) });
    const result = await scan({ sequence: 'MKVLAAGIW' });
    expect(twin(result)).toMatchObject({
      status: 'finished',
      matches: [],
      coverage: { totalMatches: 0, offset: 0, returnedMatches: 0, hasMore: false },
    });
    expect(notice(result)).toContain('no signature matches');
  });

  it.each([
    ['a cursor for another sequence', () => ({ md5: AKT1_MD5 }), { offset: 1, total: 23 }],
    ['a cursor past the end', () => ({ md5: CALMODULIN_MD5 }), { offset: 23, total: 23 }],
    ['a cursor for a changed result', () => ({ md5: CALMODULIN_MD5 }), { offset: 1, total: 24 }],
  ])('rejects %s before submitting anything', async (_name, scope, position) => {
    const net = network();
    const cursor = encodePositionCursor('interpro_scan_sequence.precalculated', scope(), position);
    const result = await scan({ sequence: sequences.calmodulin, cursor });
    failure(result, 'invalid_cursor', interproScanSequence);
    expect(net.kinds()).not.toContain('run');
  });

  it('rejects a precalculated cursor once the lookup misses, without submitting', async () => {
    const net = network({ matches: () => ({ found: false, matches: [] }) });
    const cursor = encodePositionCursor(
      'interpro_scan_sequence.precalculated',
      { md5: CALMODULIN_MD5 },
      { offset: 1, total: 23 },
    );
    failure(
      await scan({ sequence: sequences.calmodulin, cursor }),
      'invalid_cursor',
      interproScanSequence,
    );
    expect(net.kinds()).toEqual(['matches']);
  });
});

describe('interpro_scan_sequence job path', () => {
  it('returns the job ID and pending status on both surfaces, without the address', async () => {
    const net = network({ status: () => 'QUEUED' });
    const result = await scan({ sequence: sequences.calmodulinVariant, waitSeconds: 10 });
    expect(twin(result)).toEqual({
      source: 'interproscan',
      status: 'queued',
      jobId: JOB,
      md5: VARIANT_MD5,
      length: 149,
      sourceUrl: `https://www.ebi.ac.uk/Tools/services/rest/iprscan6/status/${JOB}`,
    });
    expect(notice(result)).toContain(`interpro_get_scan_result {"jobId":"${JOB}"}`);
    serverLines(text(result));
    expect(JSON.stringify(result)).not.toContain(EMAIL);
    expect(net.kinds()).toEqual(['matches', 'run', 'status', 'status']);
  });

  it('settles a cancelled wait as RequestCancelled, never as a pending result', async () => {
    const net = network();
    const controller = new AbortController();
    const pending = runToolContract(
      interproScanSequence,
      { sequence: sequences.calmodulinVariant, waitSeconds: 30 },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(7_000);
    controller.abort(new Error('caller cancelled'));
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
    expect(result.structuredContent).not.toHaveProperty('jobId');
    const sent = net.calls.length;
    await vi.runAllTimersAsync();
    expect(net.calls).toHaveLength(sent);
  });

  it('starts the job and returns at once with waitSeconds 0', async () => {
    const net = network();
    expect(
      twin(await scan({ sequence: sequences.calmodulinVariant, waitSeconds: 0 })),
    ).toMatchObject({
      status: 'submitted',
      jobId: JOB,
    });
    expect(net.kinds()).toEqual(['matches', 'run']);
  });

  it('returns InterProScan matches with versions when the job finishes inside the window', async () => {
    network({ status: () => 'FINISHED' });
    const output = twin(await scan({ sequence: sequences.calmodulinVariant, waitSeconds: 10 }));
    expect(output).toMatchObject({
      source: 'interproscan',
      status: 'finished',
      jobId: JOB,
      md5: VARIANT_MD5,
      length: 149,
      interproVersion: '110.0',
      interproscanVersion: '6.0.2.2',
      coverage: { totalMatches: 13, hasMore: false },
    });
    expect(new Set(output.matches)).toEqual(new Set(calmodulinResult.results[0]?.matches));
  });

  it('fails a miss without a configured address as scan_not_configured', async () => {
    const net = network({}, null);
    const result = await scan({ sequence: sequences.calmodulinVariant });
    failure(result, 'scan_not_configured', interproScanSequence);
    expect(net.kinds()).toEqual(['matches']);
  });

  it.each([
    ['', 'empty_sequence'],
    ['>header only\n', 'empty_sequence'],
    ['MKVL*', 'invalid_residue'],
    ['>a\nMKV\n>b\nMKV', 'multiple_sequences'],
  ] as const)('rejects %j as %s before any request', async (sequence, reason) => {
    const net = network();
    const result = await scan({ sequence });
    failure(result, reason, interproScanSequence);
    expect(net.calls).toHaveLength(0);
  });

  it('names an invalid character by code point', async () => {
    network();
    const result = await scan({ sequence: 'MKV<script>' });
    expect(text(result)).toContain(
      'Character U+003C at position 4 is not a protein residue letter.',
    );
  });

  it('rejects an over-long argument at the schema', async () => {
    const net = network();
    const result = await scan({ sequence: 'A'.repeat(100_001) });
    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(net.calls).toHaveLength(0);
  });
});

describe('interpro_get_scan_result', () => {
  it.each([
    ['QUEUED', 'queued'],
    ['RUNNING', 'running'],
  ])('reports %s as pending on both surfaces', async (upstream, status) => {
    network({ status: () => upstream });
    const result = await read({ jobId: JOB, waitSeconds: 0 });
    expect(twin(result)).toEqual({
      source: 'interproscan',
      status,
      jobId: JOB,
      sourceUrl: `https://www.ebi.ac.uk/Tools/services/rest/iprscan6/status/${JOB}`,
    });
    serverLines(text(result));
  });

  it('returns the matches of a finished job', async () => {
    network({ status: () => 'FINISHED', result: () => Response.json(akt1Result) });
    const output = twin(await read({ jobId: JOB }));
    expect(output).toMatchObject({
      status: 'finished',
      md5: 'CBBF4B5F4FB746E5B01D6F31F9ADAE55',
      length: 480,
      coverage: { totalMatches: 96, offset: 0, returnedMatches: 96, hasMore: false },
      sourceUrl: `https://www.ebi.ac.uk/Tools/services/rest/iprscan6/result/${JOB}/json`,
    });
  });

  it('walks an over-budget job result in whole-match segments scoped to the job ID', async () => {
    const results = akt1Result.results[0] as (typeof akt1Result.results)[number];
    const big = inflate(results.matches as unknown as Match[], 4);
    const body = { ...akt1Result, results: [{ ...results, matches: big }] };
    network({ status: () => 'FINISHED', result: () => Response.json(body) });
    const seen: unknown[] = [];
    let cursor: string | undefined;
    let segments = 0;
    do {
      const output = twin(await read({ jobId: JOB, ...(cursor ? { cursor } : {}) }));
      expect(jsonByteLength(output)).toBeLessThanOrEqual(RESPONSE_BYTE_BUDGET);
      expect(output.coverage.offset).toBe(seen.length);
      seen.push(...output.matches);
      cursor = output.coverage.nextCursor;
      segments++;
    } while (cursor);
    expect(segments).toBeGreaterThanOrEqual(3);
    expect(seen).toHaveLength(big.length);

    const first = twin(await read({ jobId: JOB }));
    const other = await read({
      jobId: 'iprscan6-R20261028-133403-0430-54777767-p1m',
      cursor: first.coverage.nextCursor,
    });
    failure(other, 'invalid_cursor', interproGetScanResult);
  });

  it.each(['ERROR', 'FAILURE'])('fails %s as scan_failed', async (status) => {
    network({ status: () => status });
    failure(await read({ jobId: JOB }), 'scan_failed', interproGetScanResult);
  });

  it('fails NOT_FOUND as scan_not_found', async () => {
    network({ status: () => 'NOT_FOUND' });
    failure(await read({ jobId: JOB }), 'scan_not_found', interproGetScanResult);
  });

  it.each([
    'iprscan5-R20261028-132703-0675-89227650-p1m',
    'iprscan6-R20261028-131532-0930-13189043-p1m/../../run',
    '../status',
    'iprscan6',
  ])('rejects malformed job ID %j before any request', async (jobId) => {
    const net = network();
    const result = await read({ jobId });
    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(net.calls).toHaveLength(0);
  });

  it('accepts every job ID in the captured jobs and trims surrounding whitespace', async () => {
    const net = network({ status: () => 'RUNNING' });
    for (const jobId of [
      'iprscan6-R20261028-131532-0930-13189043-p1m',
      ' iprscan6-R20261028-133403-0430-54777767-p1m\n',
    ])
      twin(await read({ jobId, waitSeconds: 0 }));
    expect(net.calls.map((call) => call.url)).toEqual([
      'https://www.ebi.ac.uk/Tools/services/rest/iprscan6/status/iprscan6-R20261028-131532-0930-13189043-p1m',
      'https://www.ebi.ac.uk/Tools/services/rest/iprscan6/status/iprscan6-R20261028-133403-0430-54777767-p1m',
    ]);
  });
});

describe('configuration', () => {
  it('reads INTERPRO_SCAN_EMAIL lazily, treats blank as unset, and never echoes an invalid value', async () => {
    const load = async (value: string) => {
      vi.resetModules();
      vi.stubEnv('INTERPRO_SCAN_EMAIL', value);
      const { getServerConfig } = await import('@/config/server-config.js');
      return getServerConfig;
    };
    expect((await load(EMAIL))()).toEqual({ scanEmail: EMAIL });
    expect((await load(''))()).toEqual({});
    const invalid = 'not-an-address-7f3a';
    const getConfig = await load(invalid);
    let thrown: unknown;
    try {
      getConfig();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: -32008 });
    expect(JSON.stringify(thrown) + String((thrown as Error).message)).toContain(
      'INTERPRO_SCAN_EMAIL',
    );
    expect(JSON.stringify(thrown) + String((thrown as Error).message)).not.toContain(invalid);
  });

  it('describes both tools identically whether or not submission is configured', async () => {
    const surface = async (value: string | undefined) => {
      vi.resetModules();
      vi.stubEnv('INTERPRO_SCAN_EMAIL', value ?? '');
      const [{ interproScanSequence: scanTool }, { interproGetScanResult: resultTool }] =
        await Promise.all([
          import('@/mcp-server/tools/definitions/interpro-scan-sequence.tool.js'),
          import('@/mcp-server/tools/definitions/interpro-get-scan-result.tool.js'),
        ]);
      return JSON.stringify(
        [scanTool, resultTool].map((definition) => ({
          description: definition.description,
          input: definition.input.toJSONSchema(),
          output: definition.output?.toJSONSchema(),
          errors: definition.errors,
        })),
      );
    };
    const configured = await surface(EMAIL);
    expect(configured).toBe(await surface(undefined));
    expect(configured).not.toContain('INTERPRO_SCAN_EMAIL');
    expect(configured).not.toContain(EMAIL);
  });
});
