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
