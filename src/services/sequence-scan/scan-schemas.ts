/**
 * @fileoverview Wire and output schemas for InterProScan match records, Matches API lookups, and
 * Job Dispatcher iprscan6 jobs. Match records pass through verbatim, unknown fields included.
 * @module services/sequence-scan/scan-schemas
 */
import { z } from '@cyanheads/mcp-ts-core';
import { JsonValueSchema } from '@/services/interpro/schemas.js';

/**
 * Job Dispatcher iprscan6 job identifier, e.g. `iprscan6-R20261028-131532-0930-13189043-p1m`:
 * submission channel letter and date, time, two numeric fields, then a short host suffix. The
 * channel letter and suffix are kept open beyond the observed `R` and `p1m`.
 */
export const JOB_ID_PATTERN = /^iprscan6-[A-Z]\d{8}-\d{6}-\d{4}-\d{1,12}-[a-z0-9]{1,8}$/;
/** Longest job identifier the pattern admits, so the input bound and the grammar agree. */
export const MAX_JOB_ID_CHARS = 64;

/** Job Dispatcher `status` vocabulary; NOT_FOUND arrives as HTTP 200 for unknown and expired IDs. */
export const JobStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'FINISHED',
  'ERROR',
  'FAILURE',
  'NOT_FOUND',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

const ScanFragmentSchema = z
  .object({
    start: z.number().int().positive().describe('Inclusive 1-based start residue.'),
    end: z.number().int().positive().describe('Inclusive 1-based end residue.'),
    'dc-status': z
      .string()
      .describe('Discontinuity status, such as CONTINUOUS, N_TERMINAL_DISC, or C_TERMINAL_DISC.'),
  })
  .catchall(JsonValueSchema)
  .describe('One continuous piece of a possibly discontinuous match location.');

const ScanLocationSchema = z
  .object({
    start: z.number().int().positive().describe('Inclusive 1-based start residue.'),
    end: z.number().int().positive().describe('Inclusive 1-based end residue.'),
    'location-fragments': z
      .array(ScanFragmentSchema)
      .min(1)
      .describe('Nonempty fragments of this location.'),
  })
  .catchall(JsonValueSchema)
  .describe(
    'One match location with every upstream field, such as scores, e-values, HMM bounds, envelope, sites, and alignments.',
  );

/** One InterProScan match record, the shape the Matches API and iprscan6 JSON share. */
export const ScanMatchSchema = z
  .object({
    signature: z
      .object({
        accession: z.string().describe('Member-database signature accession, such as PF13499.'),
        signatureLibraryRelease: z
          .object({
            library: z
              .string()
              .describe('Member database name exactly as the source spells it, such as Pfam.'),
            version: z.string().describe('Member database release that produced this match.'),
          })
          .catchall(JsonValueSchema)
          .describe('Library and release of this signature.'),
        entry: z
          .object({
            accession: z.string().describe('Integrated InterPro entry accession.'),
          })
          .catchall(JsonValueSchema)
          .nullable()
          .optional()
          .describe('InterPro entry the signature is integrated into; null when unintegrated.'),
      })
      .catchall(JsonValueSchema)
      .describe('Matched signature, including name, description, and type when supplied.'),
    'model-ac': z.string().nullable().describe('Model accession within the signature.'),
    source: z
      .string()
      .describe(
        'Method that produced the match, such as Pfam or InterPro-N, exactly as the source spells it.',
      ),
    locations: z.array(ScanLocationSchema).describe('Match locations on the sequence.'),
  })
  .catchall(JsonValueSchema)
  .describe('One InterProScan match record, verbatim.');
export type ScanMatch = z.infer<typeof ScanMatchSchema>;

const Md5Schema = z.string().regex(/^[0-9a-fA-F]{32}$/);

/** `POST /interpro/matches/api/matches` response for one MD5. */
export const MatchesLookupSchema = z.object({
  results: z
    .array(z.object({ md5: Md5Schema, found: z.boolean(), matches: z.array(ScanMatchSchema) }))
    .length(1),
});

/** `result/{jobId}/json` body for a single-sequence iprscan6 job. */
export const ScanResultSchema = z.object({
  'interproscan-version': z.string(),
  'interpro-version': z.string(),
  results: z
    .array(
      z
        .object({ md5: Md5Schema, sequence: z.string(), matches: z.array(ScanMatchSchema) })
        .catchall(JsonValueSchema),
    )
    .length(1),
});
