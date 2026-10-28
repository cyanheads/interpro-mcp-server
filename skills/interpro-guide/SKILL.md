---
name: interpro-guide
description: Identifier chains, gates, and numbering conventions for the interpro_* tools - domain maps for UniProt proteins, PDB chains, and raw sequences; member signatures versus InterPro entries; Pfam clans; GO terms; same-architecture protein discovery. Use when asked which domains a protein, structure chain, or sequence carries, when converting chain, author, and UniProt residue numbers, or when an interpro_* result feeds the next call.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

InterPro signature annotation, keyless: which InterPro entries and member-database signatures (Pfam, CDD, SMART, PANTHER, CATH-Gene3D, SUPERFAMILY, PROSITE, PRINTS, and others) match a UniProt protein, a PDB chain, or a raw sequence; entry metadata and GO terms; Pfam, CDD, and PIRSF clans; and the UniProt proteins that carry a signature.

Not covered: protein name or gene search, similarity search, structure coordinates, curated protein function. Resolve a gene or protein name to a UniProt accession with a UniProt server before calling here.

## Identifiers

| Identifier | Shape | Where it comes from | Where it goes |
|:--|:--|:--|:--|
| InterPro entry | `IPR011615` | `interpro_search_entries`; a member signature's `integrated` | `interpro_get_entry`, `interpro_find_proteins_by_domain` |
| Member signature | `PF00870`, `cd08367`, `G3DSA:2.60.40.720` | map matches; an InterPro entry's `member_databases`; scan `signature.accession` | `interpro_get_entry`, `interpro_find_proteins_by_domain` |
| Clan | `CL0073` (Pfam), `cl…` (CDD), `PIRSF…` | `set_info.accession` on a Pfam, CDD, or PIRSF signature | `interpro_get_clan` |
| GO term | `GO:0000976` | `go_terms` on an InterPro entry | `interpro_search_entries` GO filter |
| Architecture | 40 hex characters | `protein.ida_accession`, first segment of `interpro_get_protein_domains` | `interpro_find_proteins_by_domain` |
| Proteome and taxon | `UP000005640`, `9606` | `protein.proteome` and `protein.source_organism.taxId`, same first segment | `interpro_find_proteins_by_domain`, as a pair |
| PDB chain | `A`, case-sensitive | `structure.chains`, first segment of `interpro_get_structure_domains` | the same tool, one chain |
| Chain's UniProt protein | `p04637`, lowercase | `record.protein` in structure records; null when unmapped | `interpro_get_protein_domains`, any case |
| Scan job | `iprscan6-R…` | `interpro_scan_sequence` when no precalculated result exists | `interpro_get_scan_result`, for seven days |

Continuation segments omit the first segment's `protein` or `structure` metadata, so take these identifiers from the call without a cursor.

## Gates

- **Clans hang off member signatures.** An InterPro entry's `set_info` is null even when its Pfam member sits in a clan (IPR011615: null; its member PF00870: CL0073). From an InterPro entry, read `member_databases`, then the Pfam, CDD, or PIRSF member's `set_info`. `set_info` is core metadata, kept even when `sections` is empty.
- **GO terms live on InterPro entries only.** A member signature returns no `go_terms` (PF00870 has none; IPR011615 carries GO:0000976). Follow the member's `integrated` to its InterPro entry first. `integrated: null` marks an unintegrated signature: it has no InterPro entry, so no GO terms reach it.
- **Pass the proteome with its taxon.** Take `protein.proteome` and `protein.source_organism.taxId` from the same map and pass both. PF00870 in mouse proteome UP000000589 returns 0 proteins under the default taxon and 3 with taxon 10090.
- **Zero proteins is not proof of absence.** The upstream returns the same empty result for a wrong accession, an unknown taxon or proteome, and a true empty intersection. Confirm the accession with `interpro_get_entry` and the taxon against a mapped protein before reporting that none exist.
- **A capped structure match can hide chains.** Before saying a chain lacks a match that has `chainRecordLimitReached`, map that chain alone (1ryp has 28 protein chains; IPR001353 and G3DSA:3.60.20.10 list 20 each).
- **A missing match is not missing function.** No signature hit means no model matched, not that the protein lacks the activity or fold.
- **Read a scan job by its jobId.** `interpro_scan_sequence` hands back an existing job only while that job is pending and this server process is tracking it. Once the finished result has been read, or after a server restart, calling it again with the same sequence submits a new job. After the first call, poll and page only through `interpro_get_scan_result`. Each poll waits well under a minute, so expect several over a run, and give the user the jobId when the work may outlast the session.
- **The precalculated lookup is an exact-sequence match.** It keys on the MD5 of the residues, so one substitution misses, and a designed or mutated sequence nearly always needs a job. A server that cannot submit jobs answers `scan_not_configured`: tell the user only sequences already in UniParc can be scanned there, and don't retry.
- **Prefer the accession when one exists.** For a sequence that is a UniProt protein, `interpro_get_protein_domains` returns what a scan lacks: protein metadata with `ida_accession`, `proteome`, and GO terms, plus optional residue rules.

## Workflows

### Reading residue numbers

Structure records carry three numberings for each match. Never assume two of them agree:

| Field | Numbering |
|:--|:--|
| `entry_structure_locations` `start`/`end` | chain: position in the chain's own sequence, starting at 1 |
| `entry_structure_locations` `auth_start`/`auth_end` | author: residue numbers as deposited |
| `entry_protein_locations` | UniProt |

- On 1tsr chain B, PF00870 is chain 7–195, author 100–288, UniProt 100–288. On 1hho chain A, PF00042 is chain and author 26–136 but UniProt 27–137.
- `entry_protein_locations` is the signature's match on the whole UniProt protein, not clipped to what the chain covers. On 1tsr chain B, family IPR002117 spans UniProt 3–369 while the chain covers UniProt 94–312, and PRINTS PR00386 lists a sixth motif (326–350) that is not on the chain. To say what lies on the chain, read `entry_structure_locations`. To convert between chain and UniProt numbering, use `structure_protein_locations`.
- `auth_start`/`auth_end` can be null on some matches and not others (4 of 12 matches on 1tsr chain B). For those, no author numbering is available here: report chain or UniProt numbers labelled as such, never as author numbers.
- A match can have several locations (PRINTS motifs, repeats), and a location can have several fragments. A residue is covered only when it falls inside a fragment, not merely between a match's first start and last end.

### Counting and naming domains

- One region shows up once per database. On P04637 the DNA-binding domain is IPR011615, PF00870, and cd08367, and the map holds 22 match rows across 9 InterPro entries. Count InterPro entries, grouping members by `integrated`, and list unintegrated signatures separately.
- Report each match by its entry type. A family such as IPR002117 (P04637 3–369) describes the whole protein, not a domain.
- Scan results are InterProScan records verbatim, so match records are not domains. Calmodulin (P0DP23) returns 23 records, among them three CATH-Gene3D records for G3DSA:1.10.238.10. Records whose `source` is InterPro-N sit beside the member database's own record for the same signature and carry no score and no InterPro entry. PIRSR records are residue-site rules with no InterPro entry. Group by `signature.accession` and `source` before counting, and compare signatures by accession, not by name: library names vary within one result (`PROSITE profiles` and `PROSITE Profiles`), and types are capitalized (`Homologous_superfamily`) where the InterPro API writes them lowercase.

### Chains worth knowing

- **A structure chain in author numbering.** Call `interpro_get_structure_domains` with the PDB ID and the chain exactly as `structure.chains` spells it. Nucleic-acid chains are not listed. For residue rules or the architecture, follow `record.protein` to `interpro_get_protein_domains`.
- **Same architecture in the protein's proteome.** The first `interpro_get_protein_domains` segment gives `ida_accession`, `proteome`, and `source_organism.taxId`. Then call `interpro_find_proteins_by_domain` with any Pfam signature of that architecture plus all three. The query protein comes back too, so drop it when asked for others. For P04637 (PF00870, UP000005640, taxon 9606) the reviewed result is P04637 alone.
- **What else is in a clan.** `interpro_get_entry` on the Pfam signature, then `interpro_get_clan` with its `set_info.accession`. Members are signatures of that database, each with its own `integrated` InterPro entry (CL0073 has 17 Pfam members).
- **GO, both directions.** For an entry's GO terms, call `interpro_get_entry` on the InterPro entry with the `go_terms` section. For the entries carrying a term, call `interpro_search_entries` in the InterPro database, then read `member_databases` for the signatures.
