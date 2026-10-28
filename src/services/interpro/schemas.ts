/**
 * @fileoverview Lossless InterPro wire schemas and shared input vocabulary.
 * @module services/interpro/schemas
 */
import { z } from '@cyanheads/mcp-ts-core';

/** JSON values retained verbatim from upstream records. */
export const JsonValueSchema = z.json().describe('An unmodified JSON value.');
/** An upstream object with every additional JSON field retained. */
export const JsonObjectSchema = z
  .record(z.string(), JsonValueSchema)
  .describe('Complete upstream JSON object.');
/** Supported entry API routes, including separate PROSITE pattern and profile routes. */
export const SourceDatabaseSchema = z
  .enum([
    'interpro',
    'pfam',
    'prosite',
    'profile',
    'smart',
    'cdd',
    'panther',
    'cathgene3d',
    'ssf',
    'ncbifam',
    'hamap',
    'prints',
    'pirsf',
    'sfld',
    'antifam',
  ])
  .describe('InterPro entry API database slug.');
/** Entry annotation categories. */
export const EntryTypeSchema = z
  .enum([
    'domain',
    'family',
    'repeat',
    'homologous_superfamily',
    'active_site',
    'binding_site',
    'conserved_site',
    'ptm',
    'region',
    'coiled_coil',
    'disordered',
  ])
  .describe('Entry annotation type.');
/** A validated database route. */
export type SourceDatabase = z.infer<typeof SourceDatabaseSchema>;
/** A blank or whitespace-only string from a form client reads as omitted. */
const omitBlank = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
/** Form clients may submit blank optional strings. */
export const optionalString = <T extends z.ZodType>(schema: T) =>
  z.preprocess(omitBlank, schema.optional());
/** A blank string takes the `.default()` that `schema` declares, as an omitted one does. */
export const defaultedString = <T extends z.ZodType>(schema: T) => z.preprocess(omitBlank, schema);
/** Safe identifiers are encoded as a single path segment after validation. */
export const AccessionSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .refine((value) => value !== '.' && value !== '..', 'Dot segments are not accessions.')
  .describe('Identifier encoded as one path segment; no URL syntax.');
/**
 * Whether an upstream value is exactly an accession, the only form server-written text may name
 * it in. The schema trims, so a value padded with blank lines must not pass as one.
 */
export const isAccession = (value: unknown): value is string =>
  typeof value === 'string' && AccessionSchema.safeParse(value).data === value;
/** Canonical UniProt accessions exclude isoform suffixes. */
export const ProteinAccessionSchema = z
  .string()
  .trim()
  .regex(/^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/i)
  .describe('Canonical six- or ten-character UniProt accession, without an isoform suffix.');
/** GO annotation returned by InterPro. */
export const GoTermSchema = z
  .object({
    identifier: z.string().describe('GO identifier.'),
    name: z.string().describe('GO term name.'),
    category: z
      .object({
        code: z.string().describe('GO category code.'),
        name: z.string().describe('GO category name.'),
      })
      .catchall(JsonValueSchema)
      .describe('GO category.'),
  })
  .catchall(JsonValueSchema)
  .describe('GO annotation.');
/** Sparse list metadata; only routing fields are required. */
export const EntrySummarySchema = z
  .object({
    accession: z.string().describe('Entry accession.'),
    source_database: z.string().describe('Upstream source database.'),
    name: z.string().nullable().optional().describe('Entry name when supplied.'),
    type: z.string().nullable().optional().describe('Entry type when supplied.'),
    integrated: z.string().nullable().optional().describe('Integrated InterPro accession.'),
    member_databases: z
      .record(z.string(), z.record(z.string(), z.string()))
      .nullable()
      .optional()
      .describe('Member signatures grouped by database.'),
    go_terms: z.array(GoTermSchema).nullable().optional().describe('GO annotations when supplied.'),
  })
  .catchall(JsonValueSchema);
/** Detail metadata differs from summary metadata: names are objects. */
export const EntryMetadataSchema = z
  .object({
    accession: z.string().describe('Entry accession.'),
    source_database: z.string().describe('Upstream database.'),
    name: z
      .object({
        name: z.string().nullable().optional().describe('Full name.'),
        short: z.string().nullable().optional().describe('Short name.'),
      })
      .catchall(JsonValueSchema)
      .nullable()
      .optional()
      .describe('Detail name object.'),
  })
  .catchall(JsonValueSchema);
/** Detail-only output adds readable text without changing upstream description fields. */
export const EntryDetailMetadataSchema = EntryMetadataSchema.extend({
  descriptionText: z
    .string()
    .optional()
    .describe(
      'Readable description text decoded from source HTML fragments; absent without textual content.',
    ),
});
/** Complete location fragments retain discontinuity and arbitrary annotations. */
export const LocationSchema = z
  .object({
    fragments: z
      .array(
        z
          .object({
            start: z.number().int().positive().describe('Inclusive 1-based start residue.'),
            end: z.number().int().positive().describe('Inclusive 1-based end residue.'),
            'dc-status': z.string().optional().describe('Discontinuity status.'),
          })
          .catchall(JsonValueSchema)
          .refine((fragment) => fragment.start <= fragment.end, 'Fragment start exceeds end.')
          .describe('Complete continuous or discontinuous sequence fragment.'),
      )
      .min(1)
      .describe('Nonempty sequence fragments.'),
    representative: z.boolean().nullable().optional().describe('Representative match flag.'),
    model: z.string().nullable().optional().describe('Source model.'),
    score: z.number().nullable().optional().describe('Upstream match score.'),
  })
  .catchall(JsonValueSchema)
  .describe('Complete upstream match location.');
/** Protein metadata preserves omitted annotations and additional source fields. */
export const ProteinMetadataSchema = z
  .object({
    accession: z.string().describe('Protein accession.'),
    length: z.number().int().positive().describe('Sequence length in residues.'),
    source_database: z.string().describe('Protein source database.'),
    name: z.string().nullable().optional().describe('Protein name.'),
    gene: z.string().nullable().optional().describe('Gene name.'),
    source_organism: z
      .object({
        taxId: z
          .union([
            z.string().describe('Taxonomy identifier as supplied text.'),
            z.number().int().describe('Taxonomy identifier as supplied integer.'),
          ])
          .describe('Taxonomy identifier.'),
        scientificName: z.string().describe('Scientific organism name.'),
        fullName: z.string().nullable().optional().describe('Full organism name.'),
      })
      .catchall(JsonValueSchema)
      .optional()
      .describe('Source organism.'),
    proteome: z
      .string()
      .nullable()
      .optional()
      .describe(
        'UniProt proteome accession, such as UP000000625; pass it as interpro_find_proteins_by_domain proteomeId with taxonId set to source_organism.taxId or an ancestor. Null when the protein belongs to no proteome.',
      ),
  })
  .catchall(JsonValueSchema);
/** Protein match rows retain complete nested source records. */
export const MatchSchema = z
  .object({
    metadata: EntrySummarySchema.describe('Entry metadata.'),
    proteins: z
      .array(
        z
          .object({
            accession: z.string().describe('Matched protein accession.'),
            entry_protein_locations: z
              .array(LocationSchema)
              .min(1)
              .describe('Complete match locations.'),
          })
          .catchall(JsonValueSchema)
          .describe('Complete protein match object.'),
      )
      .min(1)
      .describe('Protein match objects.'),
  })
  .catchall(JsonValueSchema);
/** Feature-keyed extra annotations, not a protein detail envelope. */
export const ExtraFeaturesSchema = z.record(
  z.string(),
  z
    .object({
      accession: z.string().describe('Feature accession.'),
      source_database: z.string().describe('Feature source.'),
      locations: z.array(LocationSchema).describe('Feature locations.'),
    })
    .catchall(JsonValueSchema),
);
/** Separate residue-rule annotations retain complete provenance and location records. */
export const ResidueAnnotationsSchema = z.record(
  z.string(),
  z
    .object({
      accession: z.string().describe('Residue rule accession.'),
      source_database: z.string().describe('Rule source database.'),
      locations: z.array(LocationSchema).describe('Complete rule locations and residue fragments.'),
    })
    .catchall(JsonValueSchema),
);
/** Standard list envelope; callers select the operation-specific row schema. */
export const listSchema = <T extends z.ZodType>(row: T) =>
  z
    .object({
      count: z.number().int().nonnegative().describe('Total matching records.'),
      next: z.string().nullable().describe('Upstream continuation URL.'),
      previous: z.string().nullable().describe('Upstream previous URL.'),
      results: z.array(row).describe('Current page records.'),
    })
    .catchall(JsonValueSchema);
/** Detail response envelope. */
export const detailSchema = <T extends z.ZodType>(metadata: T) =>
  z.object({ metadata: metadata.describe('Complete detail metadata.') }).catchall(JsonValueSchema);
/** Server-owned page metadata. */
export const PageSchema = z.object({
  total: z.number().int().nonnegative().describe('Upstream total records.'),
  returned: z.number().int().nonnegative().describe('Records returned in this page.'),
  limit: z
    .number()
    .int()
    .positive()
    .describe('Effective page size after clamping to the tool maximum.'),
  hasMore: z.boolean().describe('Whether upstream advertises continuation.'),
  nextCursor: z
    .string()
    .optional()
    .describe('Opaque continuation with unchanged target and filters.'),
});
