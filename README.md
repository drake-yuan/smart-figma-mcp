# smart-figma-mcp

> **Map Figma designs to your local shadcn/ui components, generate code, and write files.**
>
> BYOK · Variant-level mapping · Deterministic write · Zero external dependencies

[![npm version](https://img.shields.io/npm/v/smart-figma-mcp.svg)](https://www.npmjs.com/package/smart-figma-mcp)
[![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)

## Why smart-figma-mcp?

When you paste a Figma link into Cursor / Claude Code, AI doesn't know your project components. It generates raw `<div>` soup every time — wrong styles, no variants, garbage `data-node-id` attributes.

**smart-figma-mcp** bridges this gap:

|  | Figma Official MCP | smart-figma-mcp |
|---|---|---|
| Read Figma / suggest mapping | ✅ Native | ✅ |
| Write to your codebase | ❌ | ✅ Deterministic write |
| Variant mapping (zero config) | ❌ (needs Code Connect) | ✅ shadcn/ui + cva auto-align |
| Token cost attribution | Unclear | ✅ BYOK — on YOUR bill |
| data-node-id cleanup | ❌ | ✅ Stripped on save |

**We don't compete on "read and suggest". We win on "write and land".**

## Quick Start (5 minutes)

```bash
npx smart-figma-mcp
```

### IDE Setup

smart-figma-mcp uses MCP (Model Context Protocol). Add this to your IDE's MCP config:

**Cursor / Kiro / Windsurf** — same JSON, different config paths:

| IDE | Config File |
|-----|-------------|
| Cursor | `~/.cursor/mcp.json` |
| Kiro | `~/.kiro/mcp.json` or `.kiro/mcp.json` (project-level) |
| Windsurf | `~/.windsurf/mcp.json` |

```json
{
  "mcpServers": {
    "smart-figma": {
      "command": "npx",
      "args": ["smart-figma-mcp"],
      "env": {
        "SMART_FIGMA_LICENSE": "<your-license-token>",
        "FIGMA_ACCESS_TOKEN": "<your-figma-personal-access-token>",
        "LLM_PROVIDER": "anthropic",
        "LLM_API_KEY": "sk-..."
      }
    }
  }
}
```

**Claude Code** — use shell env variables instead of inline env:

```json
{
  "mcpServers": {
    "smart-figma": {
      "command": "npx",
      "args": ["smart-figma-mcp"]
    }
  }
}
```
```bash
export SMART_FIGMA_LICENSE="<your-license-token>"
export FIGMA_ACCESS_TOKEN="<your-figma-personal-access-token>"
```

## Tools

| Tool | Description |
|---|---|
| `compile_figma_component` | Compile Figma node → Tailwind/CSS + variant mapping + assembly context |
| `fetch_figma_node` | Fetch raw Figma node via Figma REST API |
| `save_component` | Deterministic write: clean data-node-id, save file, update index.ts |
| `remember_mapping` | Save user-confirmed mapping → private asset library |
| `scan_components` | Auto-scan project component library (shadcn/ui / antd / mui) |
| `check_mapping_health` | Check if mapped component files still exist |
| `export_mappings` | Export mapping assets as JSON |
| `import_mappings` | Import mapping assets from JSON (merge, non-destructive) |
| `cache_clear` | Clear compilation cache |
| `refresh_crl` | Refresh License revocation list from remote |

## Modes

### Free Tier (Hacker)
- Pure digital compilation (PURE_DIGITAL path)
- No LLM call, zero token consumption
- Auto Layout nodes → Tailwind/CSS output
- Good for: well-structured Figma files with Auto Layout

### BYOK (Bring Your Own Key)
- **$9/month** or **$19 lifetime** (early bird)
- Plug your own API key (OpenAI / Anthropic / DeepSeek / Zhipu)
- Tokens go on YOUR bill — zero cost on our side
- Semantic + Visual compilation paths enabled
- All tools unlocked

### Supported LLM Providers
| Provider | Env Var | Base URL |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| Anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1` |
| DeepSeek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` |
| Zhipu (GLM) | `ZHIPU_API_KEY` | `https://open.bigmodel.cn/api/paas/v4` |

Set `LLM_PROVIDER` + `LLM_API_KEY` (or the provider-specific env var) to enable BYOK.

## Compilation Strategy

The compiler auto-detects node complexity with an additive score and routes accordingly:

| Score | Level | Strategy | Token Cost |
|---|---|---|---|
| `< 35` | **SIMPLE** | PURE_DIGITAL — direct math computation | 0 |
| `35–74` | **MODERATE** | SEMANTIC — coordinate-flow clustering | ~1 credit |
| `≥ 75` | **COMPLEX** | VISUAL — multi-modal LLM | ~5 credits |

Score terms: no Auto Layout `+30`, absolute-positioned child `+15` each,
coordinate-flow child `+5` each (capped at 50, `+20` more beyond 10),
depth beyond 4 `+8` per level.

Non-standard layouts don't fail — they return `SUGGEST_AUTOLAYOUT`, guiding you to fix at the Figma source.

## Architecture

```
┌─────────────┐  JSON-RPC   ┌──────────────────────┐
│  Cursor /   │  over stdio  │  smart-figma-mcp     │
│  Claude Code│◄────────────►│                      │
└─────────────┘              │  ┌────────────────┐  │
                             │  │ Offline         │  │
                             │  │ Ed25519 License │  │
                             │  │ (zero network)  │  │
                             │  └────────────────┘  │
                             │  ┌────────────────┐  │
                             │  │ Variant Mapping │  │
                             │  │ + Compiler       │  │
                             │  └────────────────┘  │
                             │  ┌────────────────┐  │
                             │  │ Daemon (cache)  │  │
                             │  │ Unix Socket IPC │  │
                             │  └────────────────┘  │
                             └──────────────────────┘
                                     │
                              Figma REST API
                              (fetch_figma_node)
```

## Engineering Notes

What follows is the reasoning behind the parts that are not obvious from the
tool list. If you only want to use it, skip this section.

### 3,700 lines, no runtime dependencies

| Module | Lines | Responsibility |
|---|---:|---|
| `server.js` | 763 | MCP surface, tool routing, Figma REST orchestration |
| `compiler.js` | 525 | Tiered compile strategy, recursive subtree compile |
| `mapping.js` | 319 | Variant resolution against the local component library |
| `daemon.js` / `daemon-client.js` | 387 | Long-lived cache process, socket IPC |
| `figma-client.js` / `figma-normalizer.js` | 311 | REST fetch + node normalization |
| `license.js` / `quota.js` / `byok.js` | 413 | Entitlement, quota accounting, provider routing |
| `cache.js` / `figma-screenshot.js` | 309 | Compile cache, screenshot fallback |
| `tools/*` | 336 | Key generation, license issuing, quota service |
| `test/smoke.mjs` | 341 | End-to-end smoke coverage |

No runtime `dependencies` field in `package.json` — MCP over stdio plus `fetch`
and `node:crypto` are all that is required. This keeps install fast and avoids
the supply-chain surface a dependency tree would add.

### Why a tiered compile strategy

A single strategy wastes money and produces bad output. `compiler.js` scores
every node and routes it by additive score (the table above). Two details in
that scoring are deliberate:

**Coordinate-flow children are counted separately from absolute-positioned
ones.** A child with `x`/`y` but no Auto Layout is a grid the compiler can
recover; a child tagged `layoutPositioning === "ABSOLUTE"` is an overlay it
cannot. Treating the two the same is what makes naive implementations fail on
real design files.

**Depth is a hard limit, not a hint.** `MAX_DEPTH = 6`; `compileRecursive()`
records a `depthWarning` and skips rather than recursing deeper. Unbounded
recursion on a pathological Figma tree is a real failure mode, and a skipped
subtree is visible in the output instead of silently truncating.

**Degrade to advice, not to a guess.** When a node is too complex to compile
reliably, the compiler returns `SUGGEST_AUTOLAYOUT` and points at the
`figma_auto_layoutify` plugin — a source-side fix. It does not emit code it
cannot stand behind. The free tier is `PURE_DIGITAL` only, which means the free
path is genuinely deterministic rather than quietly degraded.

**Naming reflects what actually ran.** The router reports `PURE_DIGITAL` /
`SEMANTIC` / `VISUAL`, while the recursive compiler emits `PURE_DIGITAL` /
`COORDINATE_FLOW` / `LEAF`. The first is a cost decision; the second is the
executed path. They line up in practice but are not the same vocabulary, and
`MappingResult.strategy` reflects the executed path.

### Variant mapping without a config file

`mapping.js` resolves a Figma node to a local component by inspecting the
project's own component library (shadcn/ui, antd, mui). Variants come from
Figma's own variant properties reconciled through `cva`, so adding a component
to the project is enough — there is no mapping file to maintain.

### Writing to the filesystem is the point

`save_component` is the only tool that mutates anything. Three guarantees:

- strips `data-node-id` before writing (Figma scaffolding, meaningless in code)
- updates the `index.ts` barrel export so the component is actually importable
- `remember_mapping` stores a user-confirmed mapping into a private asset
  library, so a known component resolves without re-derivation

`check_mapping_health` detects when a previously mapped component file has been
deleted or moved, so the library degrades visibly instead of silently producing
dead references.

### Long-lived process, bounded memory

Compilation is CPU- and network-bound with low per-request cost, so a
per-invocation process would pay Node startup on every tool call. A daemon
holds the cache and is reached over a socket; `daemon-client.js` handles
reconnection so a dead daemon degrades to a cold compile instead of an error.

### Entitlement without a network call

License validation is offline Ed25519 signature checking (`license.js`) against
`keys/public.pem`. The private key is never committed or published.
`refresh_crl` pulls a revocation list so a revoked token stops working without
shipping new code.

> **Disclosure:** the license issuing tools (`tools/keygen.js`,
> `tools/issue-license.js`, `tools/batch-issue.js`) and `tools/quota-server.js`
> are in this repository and in the published npm tarball. They are the
> operational side of a self-serve product, not secrets — the signing key is not
> here. If that trade-off stops being right, the fix is to move entitlement
> server-side, not to hide these files.

### Verification status

`npm test` runs `test/smoke.mjs` on every push (`.github/workflows/test.yml`).
It is a smoke suite, not a full test pyramid: it exercises tool routing, tier
selection, and the write path end-to-end. Coverage of the LLM assembly path is
inherently bounded — it needs live Figma files and a provider key, so CI does
not exercise it. Treat the free-tier compile path as the tested surface.

## FAQ

**Q: Does it work without Figma API access?**
A: Yes — you can pass `figmaNode` JSON directly to `compile_figma_component`. But `fetch_figma_node` needs `FIGMA_ACCESS_TOKEN`.

**Q: How do I get a license?**
A: Purchase from the payment link → receive your license token → paste in MCP config. License is validated offline (Ed25519, zero network calls).

**Q: Can I share my license across devices?**
A: Yes, up to 2 device fingerprints. Contact support for more.

**Q: Does it work with Kiro + Figma Power?**
A: Yes — smart-figma-mcp complements Kiro's built-in Figma Power. Figma Power reads designs; smart-figma-mcp deterministically writes code to your project. Use both side-by-side.

**Q: Does BYOK mode still consume credits?**
A: No — when using your own API key, credits are not deducted. Only the quotas service (if enabled) records usage counts.

**Q: My Figma file has no Auto Layout — will it work?**
A: The compiler returns `SUGGEST_AUTOLAYOUT` for complex non-layout nodes. We strongly recommend using our Auto Layoutify Figma plugin for best results.

## Platform Support

| IDE / Tool | Support |
|---|---|
| Cursor | ✅ Full |
| Kiro | ✅ Full |
| Claude Code | ✅ Full |
| Windsurf | ✅ Full |
| VS Code (MCP extension) | ✅ |
| Continue.dev | ⚠️ Limited |
| Cline | ⚠️ Limited |

## Pricing

| Tier | Price | Quota | BYOK | Visual Compilation |
|---|---|---|---|---|
| **Hacker** | Free | 10/day | ❌ | ❌ |
| **Maker** | $9/mo | 300/mo | ✅ | ✅ |
| **Pro** | $29/mo | 1,500/mo | ✅ | ✅ |
| **Early Bird Lifetime** | $19 once | Maker plan | ✅ | ✅ |

[Buy License →](https://www.npmjs.com/package/smart-figma-mcp#pricing)

---

## License

**Source available, not open source.** The code is published so it can be read,
studied, and evaluated — but you may not redistribute it, build a competing
product from it, or use it under an open source license. See
[LICENSE](./LICENSE) for the granted rights and restrictions. Commercial
licensing is available separately via the
[purchase page](https://www.npmjs.com/package/smart-figma-mcp#pricing).

Questions about the license: https://github.com/drake-yuan/smart-figma-mcp/issues

---

**[Privacy Policy](./PRIVACY.md)** · **[Terms of Service](./TERMS.md)**
