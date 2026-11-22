<div align="center">
  <h1>@cyanheads/interpro-mcp-server</h1>
  <p><b>Search InterPro entries, map domains and functional sites onto UniProt proteins and PDB structures, find proteins by domain, and scan raw protein sequences via MCP. STDIO or Streamable HTTP.</b>
  <div>11 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/interpro-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/interpro-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/interpro-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/interpro-mcp-server/releases/latest/download/interpro-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=interpro-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvaW50ZXJwcm8tbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22interpro-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Finterpro-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://interpro.caseyjhand.com/mcp](https://interpro.caseyjhand.com/mcp)

</div>

---

## Overview

Protein families, domains, repeats, and functional sites from [InterPro](https://www.ebi.ac.uk/interpro/) and the member databases it integrates (Pfam, PROSITE, SMART, CDD, PANTHER, and others), read through the keyless EMBL-EBI InterPro API. Search entries, read their full metadata, map a UniProt protein's or a PDB entry's chains to annotations with residue coordinates, list the PDB structures of a protein or entry, walk Pfam, CDD, and PIRSF clans, find architectures containing a combination of domains and the proteins that carry them, and scan a raw protein sequence. Runs over STDIO, Streamable HTTP, or the public hosted endpoint above, with no credentials to configure; starting new InterProScan jobs needs an operator-set contact email (see [Configuration](#configuration)).

### Tools

| Tool | Description |
|:---|:---|
| `interpro_search_entries` | Find InterPro entries by GO annotation, or InterPro entries and member signatures by accession or name, entry type, or integrating accession |
| `interpro_get_entry` | Read one entry's description, hierarchy, member signatures, GO terms, literature, cross-references, clan membership, and coverage counters |
| `interpro_get_protein_domains` | Map a UniProt protein's or isoform's domains, families, repeats, and functional sites to sequence coordinates, optionally at one residue |
| `interpro_get_clan` | Read a Pfam, CDD, or PIRSF set and page through its members, optionally with its relationship graph |
| `interpro_find_architectures` | Find Pfam domain architectures containing a set of domains and obtain the ID for a protein search |
| `interpro_find_proteins_by_domain` | Find UniProt proteins carrying an entry, defaulting to reviewed human proteins, optionally within one proteome |
| `interpro_get_structure_domains` | Map signatures onto the protein chains of one PDB entry, in chain, author, and UniProt numbering |
| `interpro_find_structures` | List the PDB structures that contain a UniProt protein or match an entry, with experiment type, resolution, and chain records |
| `interpro_scan_sequence` | Find domain, family, and site matches for a raw protein sequence: precalculated for UniParc sequences, otherwise an InterProScan job |
| `interpro_get_scan_result` | Read the status and matches of an InterProScan job started by `interpro_scan_sequence` |
| `interpro_list_reference` | Decode database slugs, entry types, accession patterns, common taxon IDs, and the current InterPro release |

## Capability reference

### `interpro_search_entries` <sub>tool</sub>

- `sourceDatabase` (default `interpro`) plus optional `query` (1-300 characters), `entryType`, `goTerm` (`GO:0003677` form), `goCategory` (`P`, `F`, `C`), and `integratedInto` (an `IPR` accession, member databases only); no filter is required, so omitting all of them browses the database
- Text search matches a case-insensitive substring of an accession, full name, or short name. Word order and punctuation matter. For a phrase miss, try one distinctive word
- `goTerm` and `goCategory` require `sourceDatabase: "interpro"`; choose one GO filter per call. Combining them fails before network access because upstream ignores the category when a term is supplied. For member signatures, search InterPro with the GO filter, then read `member_databases` with `interpro_get_entry` or search the member database with `integratedInto` set to the matching InterPro accession
- Cursor-paged, positive integer `limit` capped at 100 (default 20); larger requests are clamped with a notice. Returns `entries`, `page` (`total`, `returned`, `limit`, `hasMore`, `nextCursor`), and the applied `query`; `page.limit` is the effective page size

---

### `interpro_get_entry` <sub>tool</sub>

- `accession` required; `sourceDatabase` is inferred from standard accession prefixes when omitted. A set accession (`CL…`) fails as `entry_not_found` and points to `interpro_get_clan`
- Optional `sections` selects from `description`, `hierarchy`, `member_databases`, `go_terms`, `literature`, `cross_references`, `wikipedia`, `counters`, and `overlaps_with`. Core metadata and unknown upstream fields remain; omitted `sections` returns full detail
- An `overlaps_with` array of more than 20 records returns its first 20 with `overlapsPage` and the continuation call; shorter arrays return whole. Positive integer `overlapLimit` sets the page size (values above 10,000 are clamped with a notice), and `overlapOffset` starts at zero, pages on its own at 20 per page, and advances using `overlapsPage.nextOffset`. Paging requires overlaps to be retained. Selection and omissions are disclosed; absent or null overlap data stays distinct from an empty list
- Wikipedia thumbnails are omitted unless `includeThumbnail: true`, and a notice reports what was left out
- `entry.descriptionText` adds readable text with paragraph, list, and table boundaries alongside the unchanged source `entry.description`, including its HTML and annotation flags. It is omitted when description is excluded or no readable text is supplied
- A withdrawn record fails as `entry_withdrawn` with its deletion date and short name

---

### `interpro_get_protein_domains` <sub>tool</sub>

- UniProt `accession`: canonical (`P04637`) or an isoform, the canonical accession and a positive isoform number (`P04637-2`); optional `residuePosition` (1-based, inclusive) keeps every match with a fragment covering it, with all of that match's fragments intact; `includeExtraFeatures` adds predicted features such as disorder and transmembrane regions
- `includeResidueAnnotations: true` adds `residueAnnotations`, the provider's functional rule annotations. A residue filter keeps each whole rule with any fragment covering the position, preserving descriptions, residue letters, locations, and provenance. Extra features and residue annotations are served for canonical accessions only; an isoform accession with either fails as `isoform_annotations_unavailable`
- The first segment of a canonical protein that has isoforms lists their accessions in `isoforms`; pass one as `accession` to map that isoform, whose `protein` holds the isoform record and whose `url` is the canonical protein page. An isoform number InterPro does not hold fails as `isoform_not_found`
- Maps arrive in segments of up to `limit` whole records (default 20; values above 200 are clamped with a notice): matches, requested extra features, then requested residue rules. Follow `coverage.nextCursor` until `hasMore` is `false`; `limit` may change between segments. The first segment carries protein metadata; an empty segment cannot establish that nothing is annotated. Residue annotations are omitted until their stage is reached, while `{}` means that stage returned no selected rules
- `protein.sequence` is omitted unless `includeSequence: true`, and a notice says how to get it; `protein.length` always gives the residue count
- Discontinuous fragments, models, and upstream scores are kept as returned; `residue_out_of_range` and `protein_not_found` are typed failures

---

### `interpro_get_clan` <sub>tool</sub>

- `accession` for a Pfam (`CL0016`), CDD (`cl21453`), or PIRSF (`PIRSF000047`) set, with `sourceDatabase` (`pfam`, `cdd`, `pirsf`) inferred regardless of case: four digits after `CL` select Pfam and five select CDD; members page by `cursor`, with positive integer `limit` capped at 100 (default 20). Larger requests are clamped with a notice; `page.limit` reports the effective size
- `includeRelationships: true` adds the relationship graph in slices of `relationshipLimit` items, counting nodes, then links (default 20; values above 5,000 are clamped with a notice); `relationshipsPage.nextOffset` goes back in as `relationshipOffset`. A `relationshipOffset` above 0 or any `relationshipLimit` needs `includeRelationships` set, and `relationshipsPage.limit` reports the effective slice size
- `includeThumbnail` works as on `interpro_get_entry`; a missing set is `clan_not_found`
- Successive pages reuse the set detail while it is cached. Each request still fetches its own member page

---

### `interpro_find_architectures` <sub>tool</sub>

- Pass `domains` with one or more Pfam or InterPro accessions. `ordered` respects the supplied order, `exact` requires that exact order and composition, and `ignore` excludes architectures containing the named domains
- Each architecture carries `ida_id`, the number of proteins in the group, and a representative protein with its domain coordinates. Pass `ida_id` as `architectureId` to `interpro_find_proteins_by_domain` together with a domain from that architecture
- Follow `page.nextCursor` with the same selection. `limit` defaults to 20 and clamps at 200

---

### `interpro_find_proteins_by_domain` <sub>tool</sub>

- `accession` plus optional `sourceDatabase`; `taxonId` (NCBI, default `9606`; `1`, the taxonomy root, selects all organisms) and `reviewedOnly` (default `true`; `false` covers reviewed and unreviewed proteins) are echoed in `query`
- Optional `isFragment` selects proteins annotated as fragments (`true`) or not annotated as fragments (`false`); omit it to include both. False does not establish sequence completeness. Explicit selections appear in `query` and must stay unchanged when following cursors
- Optional `architectureId` accepts `ida_id` from `interpro_find_architectures` or `protein.ida_accession` from `interpro_get_protein_domains`: a 40-character hexadecimal identifier, normalized lowercase. Equality means the provider's Pfam architecture grouping, not equivalent function. Keep it unchanged when following cursors
- Cursor-paged, positive integer `limit` capped at 50 (default 20); larger requests are clamped with a notice, and `page.limit` is the effective size. Ordinary results keep the protein summary, matched entry locations, taxon lineage, and native `extra_fields.is_fragment` annotation; missing or null status remains unknown. Architecture-filtered rows retain native `extra_fields.ida_id` when supplied and use `detailAvailability` to distinguish unavailable entry/taxon details from actual empty arrays
- Optional `proteomeId` (`UP` plus nine digits, case-insensitive, canonicalized uppercase; for example `protein.proteome` from `interpro_get_protein_domains`) intersects one UniProt proteome with every other selection. `taxonId` still applies, including its `9606` default, and a proteome returns proteins only when `taxonId` is its organism or an ancestor. Echoed in `query`; keep it unchanged when following cursors. Rows then carry the upstream `proteomes` array, and architecture rows add `detailAvailability.proteomes`
- An empty first page checks the entry, taxon and any supplied proteome. Missing selectors return `entry_not_found`, `taxon_not_found`, or `proteome_not_found`. Known selectors with no shared proteins return an empty page

---

### `interpro_get_structure_domains` <sub>tool</sub>

- `pdbId` required: a four-character PDB ID such as `1tsr`, case-insensitive (`accession` is accepted as an alias); extended `pdb_0000…` IDs are not supported. Optional `chain` restricts the map to one protein chain, case-sensitive (`A` and `a` differ); nucleic-acid chains are not listed
- Each match lists its chain records in `structures`, joined by `entry`. A record carries locations in chain numbering (`start`/`end`, 1-based) beside author numbering (`auth_start`/`auth_end`, which can be `null` or skip), UniProt numbering, and the chain-to-UniProt residue map; `protein` is `null` for chains with no UniProt mapping
- InterPro nests at most 20 chain records per match. `chainRecordLimitReached` flags a match at that limit, which may cover chains not returned; set `chain` to read one chain completely
- Segments hold up to `limit` whole matches, each with all its chain records (default 10; values above 60 are clamped with a notice); follow `coverage.nextCursor` until `hasMore` is `false`, and `limit` may change between segments. A call reads at most four upstream requests, so a segment can end short of `limit` with a notice. The first segment carries `structure` (metadata, including the protein `chains`)
- A DNA-only entry succeeds with no matches and a notice; an unknown or obsolete ID fails as `structure_not_found`, and a chain outside the structure's protein chains as `chain_not_found` with `availableChains`
- When InterPro lists mapped proteins but no entry annotations, the first segment reports the available chain-to-UniProt mappings and their coverage. Follow the protein accession with `interpro_get_protein_domains`; `coverage.complete` refers to the structure match list

---

### `interpro_find_structures` <sub>tool</sub>

- Set exactly one of `proteinAccession` (canonical UniProt) or `entryAccession` (InterPro or member signature, with `sourceDatabase` inferred from standard prefixes when omitted); anything else fails as `invalid_target`. Echoed in `query`
- Filter either target with `experimentType` (`x-ray`, `nmr`, `em`) or `maxResolution` (inclusive upper bound in ångströms). A bound excludes structures with unknown resolution. An entry target also accepts an NCBI `taxonId`. Keep the filters when following a cursor
- Pages of PDB structures in PDB ID order, cursor-continued: positive integer `limit` clamped to 50 (default 20), with a notice. Each `structures` row carries `metadata` (the PDB ID as `metadata.accession`, experiment type, and resolution, which is `null` where InterPro records none, as for NMR and some EM structures); its chain records are in `chains`, joined by `pdbId`
- A protein target's chain records map chain positions to UniProt positions, and their `accession` and `source_database` can be `null`. An entry target's records hold the entry's match locations in chain numbering beside author `auth_start`/`auth_end` and in UniProt numbering, with `protein` `null` on unmapped chains, and each carries the chain's sequence, so entry pages can run to hundreds of kilobytes at a large `limit`
- InterPro nests at most 20 chain records per structure; `chainRecordLimitReached` flags a row at that limit, which may cover chains not returned. A row's `metadata.accession` and a record's case-sensitive chain go to `interpro_get_structure_domains` as `pdbId` and `chain`
- A target with no structures is a success with a notice, as is an empty continuation page; an unknown protein is `protein_not_found`, and an unknown entry is `entry_not_found`

---

### `interpro_scan_sequence` <sub>tool</sub>

- `sequence`: one protein sequence as residue letters, optionally after a single FASTA header line (up to 100,000 characters). Case, spaces, and line breaks are ignored; digits, gaps, and stop symbols (`*`) are rejected, as are multiple FASTA records. Required unless `cursor` is given; empty input without a cursor is `empty_sequence`
- Sequences already in UniParc return precalculated matches at once (`source: "precalculated"`). Any other sequence starts one InterProScan 6 job through the EBI Job Dispatcher (`source: "interproscan"`), which commonly runs about ten minutes, so the usual first result for a novel sequence is a `jobId` with status `submitted`, `queued`, or `running`
- `waitSeconds` (0-35, default 30) sets how long a newly started job is awaited before returning its `jobId`. Repeating a sequence whose job is still running returns the same `jobId` (tracked per server process); at most 25 jobs are in flight per process, beyond which the call fails as `rate_limited` with `retryAfter`
- Without `INTERPRO_SCAN_EMAIL` set, only precalculated matches are available and any other sequence fails as `scan_not_configured` (see [Configuration](#configuration)). The hosted endpoint does not set it
- Matches are InterProScan records verbatim, sorted by earliest location, 1-based and inclusive, in segments of up to `limit` whole records (default 20; values above 200 are clamped with a notice). Follow `coverage.nextCursor` for precalculated matches: it resumes without the sequence, and a `sequence` passed with it must be the same one. Finished results are kept in memory for 10 minutes, so the pages of one walk do not download them again. This tool is not read-only: a call can start a job

---

### `interpro_get_scan_result` <sub>tool</sub>

- `jobId` required, as returned by `interpro_scan_sequence`; `waitSeconds` (0-35, default 30) waits for a pending job, and `0` checks its status once
- Returns `status: "finished"` with matches, `queued` or `running` with no matches (check again later), plus `interproVersion` and `interproscanVersion` for a finished job. Matches arrive in segments of up to `limit` whole records (default 20; values above 200 are clamped with a notice), continued by `coverage.nextCursor` with the same `jobId`; a finished job's result is kept in memory for 10 minutes, so continuation pages do not download it again
- Jobs and results expire seven days after submission; an unknown or expired job fails as `scan_not_found`, and a job that ended in error as `scan_failed`, both pointing back to `interpro_scan_sequence`

---

### `interpro_list_reference` <sub>tool</sub>

- `topic` required: `databases`, `entry_types`, `accession_patterns`, `taxa`, or `release`. The first four are local and make no network call; `taxa` lists the taxonomy root `1` (all organisms) and common examples, not every taxon
- `release` reads the current InterPro version, date, and per-database entry counts, and fails as `release_changed` if the two upstream responses disagree on the version

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

InterPro-specific:

- 15 database slugs (`interpro`, `pfam`, `prosite`, `profile`, `smart`, `cdd`, `panther`, `cathgene3d`, `ssf`, `ncbifam`, `hamap`, `prints`, `pirsf`, `sfld`, `antifam`) and 11 entry types, with the entry database inferred from standard accession prefixes and conflicting routes rejected locally
- One process-wide request pacer for the InterPro API, starting at most one upstream request per second with up to three in flight, a 50-second budget per tool call covering pacing, retries, and every request, a 32-second bound on each attempt so InterPro's own long computations can answer, and a 4 MiB cap on upstream responses
- Output size is the caller's count `limit` on every paged tool, clamped with a notice, rather than a byte budget
- Sequence scanning checks the keyless Matches API for precalculated results before submitting an InterProScan 6 job, reuses a running job for a repeated sequence, and keeps finished results for 10 minutes so cursor pages do not download them again
- Upstream HTTP/1.1 client that handles the API's bodyless 204 responses, which native `fetch` rejects on Node
- Sparse upstream metadata passes through as `null` or omitted rather than filled in

Agent-friendly output:

- `content[]` carries the complete output as compact JSON plus an index of every URL as a link and every image as an image, so clients that read only one surface get the same data
- Opaque cursors bound to their query, with a notice naming the exact next call whenever a result is partial
- Typed failure reasons (`entry_not_found`, `invalid_cursor`, `upstream_rate_limited`, and others) each paired with a recovery hint
- Coordinates describe sequence annotation, not pathogenicity or clinical significance
- Publishes the `interpro-guide` agent skill (identifier chains, gates, and chain/author/UniProt numbering) over MCP and in plugin installs, the npm package, and the Docker image

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http interpro-mcp-server https://interpro.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add interpro-mcp-server -- npx -y @cyanheads/interpro-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "interpro-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/interpro-mcp-server"]
    }
  }
}
```

No API key is needed. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

The InterPro API is keyless. The server defines one optional variable, and these framework variables are the ones most often set:

| Variable | Description | Default |
|:---|:---|:---|
| `INTERPRO_SCAN_EMAIL` | Optional contact address the EBI Job Dispatcher requires to submit InterProScan jobs. Unset, `interpro_scan_sequence` still returns precalculated matches for sequences already in UniParc and fails other sequences as `scan_not_configured`; `interpro_get_scan_result` still reads existing jobs. One address is shared by every caller of the server, and EBI keeps it with job data for seven days. The hosted endpoint does not set it. | unset |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_HOST` | HTTP server host. | `127.0.0.1` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. With auth on, each tool requires its `tool:<tool_name>:read` scope; `interpro_scan_sequence`, which can start a job, requires `tool:interpro_scan_sequence:write`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the common framework overrides.

## Running the server

### Local development

Requires [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/interpro-mcp-server.git
  cd interpro-mcp-server && bun install
  cp .env.example .env   # optional; the server needs no keys
  ```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/interpro-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/interpro-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/interpro-mcp-server:latest"]`. To build locally, `docker build -t interpro-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the tools and starts the InterPro and sequence-scan services. |
| `src/config` | Server-specific environment parsing (`INTERPRO_SCAN_EMAIL`). |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/services/interpro` | InterPro service: HTTP/1.1 adapter, pacer and deadlines, accession routing, cursors, schemas, and the shared result formatter. |
| `src/services/sequence-scan` | Sequence parsing, the precalculated lookup, InterProScan job submission and polling, and scan result segmentation. |
| `skills/` | Published agent skill (`interpro-guide`), served over MCP and shipped with the package. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches, with no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- Register new tools in the `createApp()` array in `src/index.ts`
- Wrap external API calls: validate raw, normalize to the domain type, return the output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

Data comes from InterPro and its member databases through the EMBL-EBI API. Licensing varies by member database, so attribute InterPro and the originating database; see [InterPro's license page](https://interpro-documentation.readthedocs.io/en/latest/license.html) and the [EMBL-EBI terms of use](https://www.ebi.ac.uk/about/terms-of-use/).
