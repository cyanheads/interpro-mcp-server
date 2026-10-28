# interpro-mcp-server - Directory Structure

Generated on: 2026-10-28 15:39:38

```text
interpro-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-skill/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── prune-musl-packages.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
│   └── interpro-guide/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── interpro-find-proteins-by-domain.tool.ts
│   │           ├── interpro-get-clan.tool.ts
│   │           ├── interpro-get-entry.tool.ts
│   │           ├── interpro-get-protein-domains.tool.ts
│   │           ├── interpro-get-scan-result.tool.ts
│   │           ├── interpro-get-structure-domains.tool.ts
│   │           ├── interpro-list-reference.tool.ts
│   │           ├── interpro-scan-sequence.tool.ts
│   │           └── interpro-search-entries.tool.ts
│   ├── services/
│   │   ├── interpro/
│   │   │   ├── budget.ts
│   │   │   ├── cursors.ts
│   │   │   ├── description-text.ts
│   │   │   ├── format.ts
│   │   │   ├── http-adapter.ts
│   │   │   ├── interpro-service.ts
│   │   │   ├── reference.ts
│   │   │   ├── relationships.ts
│   │   │   ├── routing.ts
│   │   │   ├── schemas.ts
│   │   │   ├── structure-schemas.ts
│   │   │   └── upstream-errors.ts
│   │   └── sequence-scan/
│   │       ├── scan-output.ts
│   │       ├── scan-schemas.ts
│   │       ├── sequence-scan-service.ts
│   │       └── sequence.ts
│   └── index.ts
├── tests/
│   ├── fuzz/
│   ├── integration/
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   ├── fixtures/
│   │   │   └── sequence-scan/
│   │   │       ├── iprscan6-akt1-variant.json
│   │   │       ├── iprscan6-calmodulin-variant.json
│   │   │       ├── matches-batch.json
│   │   │       └── sequences.json
│   │   ├── interpro-budget.test.ts
│   │   ├── interpro-description-text.test.ts
│   │   ├── interpro-foundation.test.ts
│   │   ├── interpro-http-adapter.test.ts
│   │   ├── sequence-scan-sequence.test.ts
│   │   └── sequence-scan-service.test.ts
│   ├── smoke/
│   └── tools/
│       ├── fixtures/
│       │   └── interpro-structures.json
│       ├── contract-helpers.ts
│       ├── interpro-entries.test.ts
│       ├── interpro-list-reference.tool.test.ts
│       ├── interpro-proteins.test.ts
│       ├── interpro-sequence-scan.test.ts
│       └── interpro-structures.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── mcp.json
├── package.json
├── plugin.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
