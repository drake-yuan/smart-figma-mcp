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

Then add this to your Cursor MCP config (`~/.cursor/mcp.json`):

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

### Claude Code

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
Set `SMART_FIGMA_LICENSE` + `FIGMA_ACCESS_TOKEN` as shell env variables.

### Windsurf

Same as Cursor — add to `~/.windsurf/mcp.json`.

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

The compiler auto-detects node complexity:

| Complexity | Strategy | Token Cost |
|---|---|---|
| **SIMPLE** (Auto Layout ✅, depth ≤ 3) | PURE_DIGITAL — direct math computation | 0 |
| **MODERATE** (Mixed layout, depth 4–6) | SEMANTIC — coordinate-flow clustering | ~1 credit |
| **COMPLEX** (Absolute positioning, depth 7+) | VISUAL — multi-modal LLM | ~5 credits |

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

## FAQ

**Q: Does it work without Figma API access?**
A: Yes — you can pass `figmaNode` JSON directly to `compile_figma_component`. But `fetch_figma_node` needs `FIGMA_ACCESS_TOKEN`.

**Q: How do I get a license?**
A: Purchase from the payment link → receive your license token → paste in MCP config. License is validated offline (Ed25519, zero network calls).

**Q: Can I share my license across devices?**
A: Yes, up to 2 device fingerprints. Contact support for more.

**Q: Does BYOK mode still consume credits?**
A: No — when using your own API key, credits are not deducted. Only the quotas service (if enabled) records usage counts.

**Q: My Figma file has no Auto Layout — will it work?**
A: The compiler returns `SUGGEST_AUTOLAYOUT` for complex non-layout nodes. We strongly recommend using our Auto Layoutify Figma plugin for best results.

## Platform Support

| IDE / Tool | Support |
|---|---|
| Cursor | ✅ Full |
| Claude Code | ✅ Full |
| Windsurf | ✅ Full |
| VS Code (with MCP extension) | ✅ |
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

**[Privacy Policy](./PRIVACY.md)** · **[Terms of Service](./TERMS.md)**
