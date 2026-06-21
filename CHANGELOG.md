# Changelog

## [1.0.0] — 2026-06-21
### Module 07: npm Publishing + Distribution
- `package.json`: description, keywords, repository, homepage, bugs, files whitelist, engines ≥18.0.0
- `bin/cli.js`: `npx smart-figma-mcp` one-command launch
- `.npmignore`: exclude private.pem, issue-log, tests, figma-plugin
- `.github/workflows/test.yml`: CI smoke test on push/PR
- `prepublishOnly` hook: auto smoke test before publish
- Enhanced README: quick start, tools table, modes, providers, FAQ, pricing

### Module 09: Payment + Compliance
- `tools/batch-issue.js`: batch license issuance from CSV/JSON
- `tools/issue-license.js` refactored: export `issueLicense()` for reuse
- `PRIVACY.md`: privacy policy (no data collection, no telemetry)
- `TERMS.md`: terms of service (subscription, refund, liability)
- Renewal reminder: `gate()` returns `renewal` 7 days before expiry

### Module 08: Marketing
- `docs/VIDEO_SCRIPT.md`: 60-second comparison video script
- `docs/COPY.md`: Chinese + English marketing copy templates
- Pricing page template (LemonSqueezy)

## [0.5.0] — 2026-06-21
### Module 02: BYOK + License + Quota
- License token v2 (ver/jti/iat/exp/devices/quota)
- CRL revocation list support (`.smart-figma/crl.json`)
- Renewal warnings (7 days before expiry)
- BYOK multi-provider: OpenAI / Anthropic / DeepSeek / Zhipu
- `probeKey()` API key validity check
- `securityWarning()` plaintext key detection
- Server-side quota: `debit()` → `/quota/debit` REST API
- Local fallback: `quota_snapshot.json` → ledger optimistic deduction
- UUID idempotency key against replay attacks
- `tools/quota-server.js`: Express server (port 3030), 3 endpoints
- `tools/issue-license.js` v2: `--devices`, `--quota-monthly`

### Module 04: Mapping Asset Management
- 30+ alias entries with custom override support
- `parseCVA()` CVA variant dimension parsing
- `scanLocalComponents()` auto-scan shadcn/ui / antd / mui
- `resolveMapping()` conflict resolution algorithm
- `checkMappingHealth()` / `exportMappings()` / `importMappings()`
- 5 new MCP tools: scan_components, check_mapping_health, export_mappings, import_mappings, refresh_crl

## [0.4.0] — 2026-06-21
### Module 05: Daemon Architecture
- Unix Domain Socket IPC daemon
- L1 (memory) + L2 (disk JSON) multi-level cache
- TTL 30 days, contentHash = sha256(nodeId + bbox + lastModified)
- Auto fallback to DIRECT mode on daemon unreachable
- Prefetch warm-up + idle 30min auto exit
- Cache hit compilation latency <10ms

## [0.3.0] — 2026-06-21
### Module 03: Compiler Enhancement
- Coordinate-flow extraction + spatial grid clustering
- Multi-format output: Tailwind / CSS Modules / SCSS / Styled Components
- Recursive compilation (children tree)
- Responsive breakpoint detection (desktop/mobile)
- Complexity scoring with visual report
- Non-standard layout → `SUGGEST_AUTOLAYOUT`

## [0.2.0] — 2026-06-21
### Module 01: MCP Protocol + Module 06: Figma API
- JSON-RPC error codes: PARSE_ERROR / INVALID_REQUEST / METHOD_NOT_FOUND / INVALID_PARAMS / INTERNAL_ERROR / NOT_INITIALIZED / QUOTA_EXCEEDED
- `ping` / `health` / `initialize` state machine
- Graceful shutdown (SIGTERM/SIGINT) + log levels (debug/info/warn/error)
- Figma REST API client with retry + timeout
- Node data normalizer (Auto Layout / fills / strokes / effects)
- `parseFigmaUrl()` URL → (fileKey, nodeId)
- `fetch_figma_node` tool added

## [0.1.0] — 2026-06-21
### Initial Skeleton
- Ed25519 offline license verification
- BYOK economic model (OpenAI / Anthropic / Google)
- Server-side quota (local JSON ledger)
- Variant-level mapping (figma name → cva props)
- Deterministic write (clean + save + barrel export)
- Compiler: analyzeComplexity + PURE_DIGITAL / SEMANTIC / VISUAL strategies
- `compile_figma_component` / `save_component` / `remember_mapping` tools
