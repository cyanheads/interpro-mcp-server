/**
 * @fileoverview Static API vocabulary and common taxonomy examples.
 * @module services/interpro/reference
 */
import { z } from '@cyanheads/mcp-ts-core';
import { DOCUMENTATION_URL, ENTRY_ROUTES } from './routing.js';
import type { SourceDatabase } from './schemas.js';
import { CHAIN_PATTERN, PDB_ID_PATTERN } from './structure-schemas.js';

/** Available reference topics; only release performs network operations. */
export const ReferenceTopicSchema = z
  .enum(['databases', 'entry_types', 'accession_patterns', 'taxa', 'release'])
  .describe('Reference topic; release retrieves current upstream metadata.');
/** Applicable reference fields, without fabricated empty annotations. */
export const ReferenceItemSchema = z
  .object({
    id: z.string().describe('Reference identifier.'),
    label: z.string().describe('Human-readable label.'),
    description: z.string().optional().describe('Meaning and coverage.'),
    sourceDatabase: z.string().optional().describe('Entry API database slug.'),
    accessionPattern: z
      .string()
      .optional()
      .describe(
        'Accession routing pattern, case-insensitive except where the item description says otherwise.',
      ),
    example: z
      .string()
      .optional()
      .describe('Example accession spelling; assignment is not guaranteed.'),
    taxonId: z.string().optional().describe('NCBI taxonomy identifier.'),
  })
  .describe('One reference vocabulary item.');
/** A reference vocabulary row. */
export type ReferenceItem = z.infer<typeof ReferenceItemSchema>;
const databaseLabels: Record<SourceDatabase, string> = {
  interpro: 'InterPro',
  pfam: 'Pfam',
  prosite: 'PROSITE patterns',
  profile: 'PROSITE profiles',
  smart: 'SMART',
  cdd: 'CDD',
  panther: 'PANTHER',
  cathgene3d: 'CATH-Gene3D',
  ssf: 'SUPERFAMILY',
  ncbifam: 'NCBIFAM',
  hamap: 'HAMAP',
  prints: 'PRINTS',
  pirsf: 'PIRSF',
  sfld: 'SFLD',
  antifam: 'AntiFam',
};
const types = [
  ['domain', 'Domain', 'A distinct structural or functional protein unit.'],
  ['family', 'Family', 'A group of evolutionarily related proteins.'],
  ['repeat', 'Repeat', 'A repeated sequence or structural unit.'],
  [
    'homologous_superfamily',
    'Homologous superfamily',
    'Proteins or domains with a shared evolutionary origin.',
  ],
  ['active_site', 'Active site', 'Residues involved in catalysis.'],
  ['binding_site', 'Binding site', 'Residues involved in binding.'],
  ['conserved_site', 'Conserved site', 'A conserved functional sequence site.'],
  ['ptm', 'Post-translational modification', 'A post-translational modification site.'],
  [
    'region',
    'Region',
    'A sequence region; AntiFam signatures of spurious protein predictions use this type.',
  ],
  [
    'coiled_coil',
    'Coiled coil',
    'A coiled-coil region, where alpha-helices wind around each other.',
  ],
  [
    'disordered',
    'Disordered region',
    'An intrinsically disordered region without a fixed three-dimensional structure.',
  ],
] as const;
const taxa = [
  ['9606', 'Human'],
  ['10090', 'Mouse'],
  ['10116', 'Rat'],
  ['7955', 'Zebrafish'],
  ['7227', 'Fruit fly'],
  ['6239', 'Nematode'],
  ['559292', 'Budding yeast'],
  ['3702', 'Arabidopsis'],
  ['562', 'Escherichia coli'],
] as const;
/** Structure identifiers, listed after the entry routes under accession_patterns. */
const structureIdentifiers: ReferenceItem[] = [
  {
    id: 'pdb',
    label: 'PDB entry',
    accessionPattern: PDB_ID_PATTERN.source,
    example: '1tsr',
    description:
      'Four-character structure ID for interpro_get_structure_domains, matched case-insensitively; extended pdb_0000… IDs are not supported.',
  },
  {
    id: 'pdb_chain',
    label: 'PDB chain',
    accessionPattern: CHAIN_PATTERN.source,
    example: 'A',
    description:
      'Case-sensitive chain ID within one PDB entry, one of its structure.chains; a and A are different chains.',
  },
];
/** Return bounded local reference data without making upstream requests. */
export function staticReference(topic: Exclude<z.infer<typeof ReferenceTopicSchema>, 'release'>): {
  items: ReferenceItem[];
  sourceUrls: string[];
} {
  if (topic === 'entry_types')
    return {
      items: types.map(([id, label, description]) => ({ id, label, description })),
      sourceUrls: [DOCUMENTATION_URL],
    };
  if (topic === 'taxa')
    return {
      items: taxa.map(([taxonId, label]) => ({
        id: taxonId,
        label,
        taxonId,
        description: 'Common taxonomy example; this is not an exhaustive taxonomy.',
      })),
      sourceUrls: [DOCUMENTATION_URL, 'https://www.ncbi.nlm.nih.gov/taxonomy'],
    };
  return {
    items: ENTRY_ROUTES.map(
      ({ source, pattern, example }): ReferenceItem => ({
        id: source,
        label: databaseLabels[source],
        sourceDatabase: source,
        accessionPattern: pattern.source,
        example,
        description:
          topic === 'accession_patterns'
            ? 'Routing syntax does not guarantee that an accession is assigned.'
            : source === 'interpro'
              ? 'Integrating database combining member signatures.'
              : source === 'antifam'
                ? 'Additional API source for spurious protein predictions.'
                : source === 'prosite'
                  ? 'PROSITE pattern signatures; profiles use the profile route.'
                  : source === 'profile'
                    ? 'PROSITE profile signatures; patterns use the prosite route.'
                    : 'Member-database signatures exposed through the InterPro entry API.',
      }),
    ).concat(topic === 'accession_patterns' ? structureIdentifiers : []),
    sourceUrls: [DOCUMENTATION_URL],
  };
}
