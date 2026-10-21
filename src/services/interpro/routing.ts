/**
 * @fileoverview Validated accession routing and fixed-origin InterPro URLs.
 * @module services/interpro/routing
 */
import { notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { AccessionSchema, type SourceDatabase } from './schemas.js';

/** Canonical API origin; no upstream continuation URL is fetched directly. */
export const API_BASE = 'https://www.ebi.ac.uk/interpro/api/';
/** Official reference documentation. */
export const DOCUMENTATION_URL = 'https://interpro-documentation.readthedocs.io/en/latest/api.html';
/** Routing patterns and examples are shared with the reference vocabulary. */
export const ENTRY_ROUTES: readonly { source: SourceDatabase; pattern: RegExp; example: string }[] =
  [
    { source: 'interpro', pattern: /^IPR\d{6}$/i, example: 'IPR011615' },
    { source: 'pfam', pattern: /^PF\d{5}$/i, example: 'PF00870' },
    { source: 'prosite', pattern: /^PS00\d{3}$/i, example: 'PS00107' },
    { source: 'profile', pattern: /^PS5\d{4}$/i, example: 'PS50011' },
    { source: 'smart', pattern: /^SM\d{5}$/i, example: 'SM00220' },
    { source: 'cdd', pattern: /^cd\d+$/i, example: 'cd08367' },
    { source: 'panther', pattern: /^PTHR\d+(?::SF\d+)?$/i, example: 'PTHR11447' },
    { source: 'cathgene3d', pattern: /^G3DSA:\d+\.\d+\.\d+\.\d+$/i, example: 'G3DSA:3.30.200.20' },
    { source: 'ssf', pattern: /^SSF\d+$/i, example: 'SSF56112' },
    { source: 'ncbifam', pattern: /^(?:TIGR|NF)\d+$/i, example: 'TIGR00001' },
    { source: 'hamap', pattern: /^MF_\d+$/i, example: 'MF_00001' },
    { source: 'prints', pattern: /^PR\d+$/i, example: 'PR00386' },
    { source: 'pirsf', pattern: /^PIRSF\d+$/i, example: 'PIRSF000047' },
    { source: 'sfld', pattern: /^SFLD[A-Z]?\d+$/i, example: 'SFLDF00001' },
    { source: 'antifam', pattern: /^ANF\d+$/i, example: 'ANF00001' },
  ];
/** Pfam clan (`CL`) and CDD superfamily (`cl`) accessions name sets, never entries. */
const CLAN_PATTERN = /^cl\d+$/i;
/** Resolve one entry accession without guessing alternate databases after a miss. */
export function resolveEntry(
  accession: string,
  sourceDatabase?: SourceDatabase,
): { accession: string; sourceDatabase: SourceDatabase } {
  const safe = AccessionSchema.parse(accession);
  if (CLAN_PATTERN.test(safe))
    throw notFound(`${safe} is a set accession, not an entry accession.`, {
      reason: 'entry_not_found',
      retryable: false,
      accession: safe,
      recovery: {
        hint: 'Call interpro_get_clan with this accession to read the set and its member entries.',
      },
    });
  const inferred = ENTRY_ROUTES.find((route) => route.pattern.test(safe))?.source;
  if (inferred && sourceDatabase && inferred !== sourceDatabase)
    throw validationError(
      `Accession ${safe} routes to sourceDatabase ${inferred} by its prefix, not ${sourceDatabase}.`,
      {
        reason: 'database_mismatch',
        retryable: false,
        accession: safe,
        sourceDatabase,
        inferredSourceDatabase: inferred,
      },
    );
  const source = sourceDatabase ?? inferred;
  if (!source)
    throw validationError(
      `Accession ${safe} matches no standard prefix, and no sourceDatabase was supplied.`,
      { reason: 'accession_source_unknown', retryable: false, accession: safe },
    );
  return {
    accession: inferred ? (source === 'cdd' ? safe.toLowerCase() : safe.toUpperCase()) : safe,
    sourceDatabase: source,
  };
}
/** Resolve case-sensitive CL clan prefixes, with explicit source disambiguation. */
export function resolveClan(
  accession: string,
  sourceDatabase?: 'pfam' | 'cdd' | 'pirsf',
): { accession: string; sourceDatabase: 'pfam' | 'cdd' | 'pirsf' } {
  const safe = AccessionSchema.parse(accession);
  const isCl = CLAN_PATTERN.test(safe);
  const isPirsf = /^PIRSF\d+$/i.test(safe);
  const inferred = /^CL\d+$/.test(safe)
    ? 'pfam'
    : /^cl\d+$/.test(safe)
      ? 'cdd'
      : isPirsf
        ? 'pirsf'
        : undefined;
  if (
    (isPirsf && sourceDatabase && sourceDatabase !== 'pirsf') ||
    (isCl && sourceDatabase === 'pirsf')
  )
    throw validationError(
      `Set accession ${safe} routes to sourceDatabase ${inferred ?? 'pfam or cdd'} by its prefix, not ${sourceDatabase}.`,
      {
        reason: 'database_mismatch',
        retryable: false,
        accession: safe,
        sourceDatabase,
        ...(inferred ? { inferredSourceDatabase: inferred } : {}),
      },
    );
  const source = sourceDatabase ?? inferred;
  if (!source)
    throw validationError(
      isCl
        ? `Set accession ${safe} has a mixed-case CL prefix, which can name a Pfam or CDD set, and no sourceDatabase was supplied.`
        : `Set accession ${safe} matches no set prefix, and no sourceDatabase was supplied.`,
      { reason: 'accession_source_unknown', retryable: false, accession: safe },
    );
  return {
    accession: isCl
      ? source === 'cdd'
        ? safe.toLowerCase()
        : safe.toUpperCase()
      : inferred
        ? safe.toUpperCase()
        : safe,
    sourceDatabase: source,
  };
}
/** Build fixed-origin requests from independently validated, encoded path segments. */
export function apiUrl(
  segments: readonly string[],
  query: Readonly<Record<string, string | number | boolean | undefined>> = {},
): string {
  const path = segments.map((part) => encodeURIComponent(AccessionSchema.parse(part))).join('/');
  const url = new URL(`${path}${path ? '/' : ''}`, API_BASE);
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) url.searchParams.set(key, String(value));
  return url.href;
}
