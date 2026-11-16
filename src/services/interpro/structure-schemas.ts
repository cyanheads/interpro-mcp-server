/**
 * @fileoverview PDB identifier grammar and lossless structure match schemas.
 * @module services/interpro/structure-schemas
 */
import { z } from '@cyanheads/mcp-ts-core';
import { EntrySummarySchema, JsonValueSchema, LocationSchema } from './schemas.js';

/** Classic four-character PDB IDs; InterPro answers extended `pdb_0000…` IDs with 404. */
export const PDB_ID_PATTERN = /^[0-9][A-Za-z0-9]{3}$/;
/** Chain IDs as InterPro lists them: case-sensitive, one to four letters or digits. */
export const CHAIN_PATTERN = /^[A-Za-z0-9]{1,4}$/;
/** Caller-supplied PDB ID, matched case-insensitively and sent lowercase. */
export const PdbIdSchema = z
  .string()
  .trim()
  .max(4)
  .regex(PDB_ID_PATTERN, 'Expected a four-character PDB ID such as 1tsr.')
  .describe(
    'Four-character PDB ID such as 1tsr; case-insensitive. Extended pdb_0000… IDs are not supported.',
  );
/** Caller-supplied chain ID, compared exactly against the structure's protein chains. */
export const ChainSchema = z
  .string()
  .trim()
  .max(4)
  .regex(CHAIN_PATTERN, 'Expected a chain ID of one to four letters or digits.')
  .describe('Case-sensitive PDB chain ID, one to four letters or digits.');
/** Whether an upstream value is exactly a chain ID, the only form server-written text names it in. */
export const isChain = (value: unknown): value is string =>
  typeof value === 'string' && CHAIN_PATTERN.test(value);
/** Structure detail metadata: `chains` lists protein chains only; other fields are retained. */
export const StructureMetadataSchema = z
  .object({
    accession: z.string().describe('Lowercase PDB ID.'),
    source_database: z.string().describe('Structure source database.'),
    chains: z
      .array(z.string().describe('Protein chain ID.'))
      .describe('Protein chain IDs; nucleic-acid chains are not listed.'),
  })
  .catchall(JsonValueSchema)
  .describe('Complete upstream structure metadata.');
/**
 * One upstream chain record of a structure match. `entry_structure_locations` fragments carry
 * 1-based chain `start`/`end` beside author `auth_start`/`auth_end`, which may be null; the
 * UniProt `protein`, its residue maps, and both protein-side location arrays may be null or empty.
 */
export const StructureRecordSchema = z
  .object({
    accession: z.string().describe('Lowercase PDB ID.'),
    chain: z.string().describe('Case-sensitive chain ID.'),
    protein: z
      .string()
      .nullable()
      .describe('Lowercase UniProt accession mapped to the chain; null when unmapped.'),
    entry_structure_locations: z
      .array(LocationSchema)
      .describe(
        'Match locations in chain numbering: start/end are 1-based chain positions; auth_start/auth_end are author residue numbers, possibly null.',
      ),
    entry_protein_locations: z
      .array(LocationSchema)
      .nullable()
      .optional()
      .describe('Match locations in UniProt numbering; null or empty without a usable mapping.'),
    structure_protein_locations: z
      .array(LocationSchema)
      .nullable()
      .optional()
      .describe(
        'Chain-to-UniProt residue maps: start/end in chain numbering, protein_start/protein_end in UniProt numbering.',
      ),
  })
  .catchall(JsonValueSchema)
  .describe('Complete upstream chain record.');
/** Upstream structure match row: entry metadata plus at most 20 nested chain records. */
export const StructureMatchSchema = z
  .object({
    metadata: EntrySummarySchema.describe('Entry metadata.'),
    structures: z.array(StructureRecordSchema).describe('Nested chain records.'),
  })
  .catchall(JsonValueSchema);
/**
 * InterPro nests at most this many chain records in one structure-map match or structure list row,
 * whatever the page size.
 */
export const NESTED_CHAIN_LIMIT = 20;
/** Structure list metadata; NMR and some EM structures carry a null resolution, which stays null. */
export const StructureSummarySchema = z
  .object({
    accession: z
      .string()
      .describe('Lowercase PDB ID, accepted as pdbId by interpro_get_structure_domains.'),
    source_database: z.string().describe('Structure source database.'),
    name: z.string().nullable().optional().describe('Structure title when supplied.'),
    experiment_type: z
      .string()
      .nullable()
      .optional()
      .describe('Experimental method as upstream writes it, such as x-ray, nmr, or em.'),
    resolution: z
      .number()
      .nullable()
      .optional()
      .describe('Resolution in ångströms; null where the method reports none, such as NMR.'),
  })
  .catchall(JsonValueSchema);
/**
 * A protein-route chain record: one chain of the structure mapped to the queried UniProt protein,
 * its `structure_protein_locations` fragments pairing chain `start`/`end` with UniProt
 * `protein_start`/`protein_end`. Some records carry a null `accession` and `source_database`.
 */
export const ProteinChainRecordSchema = z
  .object({
    accession: z
      .string()
      .nullable()
      .describe('Lowercase UniProt accession of the queried protein; null when upstream omits it.'),
    chain: z.string().describe('Case-sensitive chain ID.'),
    structure_protein_locations: z
      .array(LocationSchema)
      .describe(
        'Chain-to-UniProt residue maps: start/end in chain numbering, protein_start/protein_end in UniProt numbering.',
      ),
  })
  .catchall(JsonValueSchema);
/**
 * An entry-route chain record: the queried entry's match on one chain, in chain numbering beside
 * author numbering and, when the chain maps to UniProt, in UniProt numbering. Unmapped chains
 * carry a null `protein` and null or empty `entry_protein_locations`.
 */
export const EntryChainRecordSchema = z
  .object({
    accession: z.string().describe('Accession of the queried entry.'),
    chain: z.string().describe('Case-sensitive chain ID.'),
    protein: z
      .string()
      .nullable()
      .describe('Lowercase UniProt accession mapped to the chain; null when unmapped.'),
    entry_structure_locations: z
      .array(LocationSchema)
      .describe(
        'Match locations in chain numbering: start/end are 1-based chain positions; auth_start/auth_end are author residue numbers, possibly null.',
      ),
    entry_protein_locations: z
      .array(LocationSchema)
      .nullable()
      .optional()
      .describe('Match locations in UniProt numbering; null or empty without a usable mapping.'),
  })
  .catchall(JsonValueSchema);
/** Protein-route list row: structure metadata plus at most 20 chain records for the protein. */
export const ProteinStructureRowSchema = z
  .object({
    metadata: StructureSummarySchema,
    proteins: z.array(ProteinChainRecordSchema),
  })
  .catchall(JsonValueSchema);
/** Entry-route list row: structure metadata plus at most 20 chain records the entry matches. */
export const EntryStructureRowSchema = z
  .object({
    metadata: StructureSummarySchema,
    entries: z.array(EntryChainRecordSchema),
  })
  .catchall(JsonValueSchema);
