# smart-figma-mcp

> **Map Figma designs to your local component library — shadcn/ui, antd, mui, or Astryx — generate code, and write files.**
>
> BYOK · Variant-level mapping · Deterministic write · Zero external dependencies

<div align="center">

![npm version](https://img.shields.io/npm/v/smart-figma-mcp.svg) ![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)

</div>

## Why smart-figma-mcp?

When you paste a Figma link into Cursor / Claude Code / Codex, AI doesn't know your project components. It generates raw `<div>` soup every time — wrong styles, no variants, garbage `data-node-id` attributes. Ask for a `<Button variant="ghost-primary">` and you'll get a prop that doesn't exist.

**smart-figma-mcp** bridges this gap:

|                                  | Figma Official MCP     | smart-figma-mcp                                     |
| -------------------------------- | ---------------------- | --------------------------------------------------- |
| Read Figma / suggest mapping     | ✅ Native               | ✅                                                   |
| Write to your codebase           | ❌                      | ✅ Deterministic write                               |
| Variant mapping (zero config)    | ❌ (needs Code Connect) | ✅ shadcn/ui + cva auto-align                        |
| Authoritative component contract | ❌                      | ✅ shadcn/ui, antd, mui, **Astryx (166 components)** |
| Token cost attribution           | Unclear                | ✅ BYOK — key-validated, no server token spend       |
| data-node-id cleanup             | ❌                      | ✅ Stripped on save                                  |

**We don't compete on "read and suggest". We win on "write and land".**

## Design-System Contract Engines

The core problem with AI-generated UI isn't layout — it's that the model

**guesses** at your component API. smart-figma-mcp resolves variants against a

real source of truth instead, and each supported library has its own engine:

| Library           | Contract source             | How variants are resolved                                                          |
| ----------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| shadcn/ui         | `cva()` call in your source | Parsed from the variant definition by `parseCVA()`                                 |
| radix-ui          | local `.tsx`                | Primitives + your own wrappers                                                     |
| **antd / mui**    | **shipped `.d.ts`**         | **`mui-antd-contract.js` reads each `<Component>Props` type and extracts the literal-union values (alias + `OverridableStringUnion` aware)** |
| **Astryx (Meta)** | **CLI JSON contract**       | **`@astryxdesign/cli` — the same machine-readable manifest Meta ships for agents** |

### Astryx: zero-hallucination mapping

[Astryx](https://github.com/facebook/astryx) is Meta's open-source design

system, built to be consumed by AI agents. It publishes its component API as

JSON, so smart-figma-mcp can validate props **deterministically** instead of

inferring them:

```bash
npm install @astryxdesign/core @stylexjs/stylex
npm install -D @astryxdesign/cli
```

```json
{
  "name": "Button",
  "importPath": "@astryxdesign/core/Button",
  "variants": {
    "variant": ["primary", "secondary", "ghost", "destructive"],
    "size": ["sm", "md", "lg"],
    "elevation": ["none", "low", "med", "high"]
  },
  "requiredProps": ["label"]
}
```

That `variants` map is the *shipped* contract, not a scrape — so

`variant="ghost-primary"` is rejected because it genuinely isn't in the enum,

not because a heuristic guessed wrong.

Two properties worth knowing:

- **Beta-contained.** Astryx is v0.x and may break between minors. Contract

  reads are cached per CLI version, and any failure degrades to "no Astryx

  components" — it never breaks component scanning for your other libraries.
- **Lazy by design.** The 166-component index is enumerated once; props are

  fetched per component on demand rather than all up front.

## Quick Start (5 minutes)

```bash
npx smart-figma-mcp
```

### IDE Setup

smart-figma-mcp uses MCP (Model Context Protocol). Add this to your IDE's MCP config:

**Cursor / Kiro / Windsurf** — same JSON, different config paths:

| IDE      | Config File                                            |
| -------- | ------------------------------------------------------ |
| Cursor   | `~/.cursor/mcp.json`                                   |
| Kiro     | `~/.kiro/mcp.json` or `.kiro/mcp.json` (project-level) |
| Windsurf | `~/.windsurf/mcp.json`                                 |

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

**Codex CLI / IDE extension** — config is TOML, not JSON. Add a  
`[mcp_servers.smart-figma]` table to `~/.codex/config.toml` (or  
`.codex/config.toml` in a trusted project):

```toml
[mcp_servers.smart-figma]
command = "npx"
args = ["smart-figma-mcp"]
startup_timeout_sec = 30
# "writes" prompts before any tool that mutates the filesystem, which is what
# you want for save_component; "auto" trusts the server without prompting.
default_tools_approval_mode = "writes"
```

Codex spawns the command directly rather than through a shell, so `command`  
takes the bare program name and everything else belongs in `args` — putting a  
whole command line in `command` is the most common setup error. Secrets are  
best passed by reference so they never land in the file:

```toml
[mcp_servers.smart-figma]
command = "npx"
args = ["smart-figma-mcp"]
env_vars = ["SMART_FIGMA_LICENSE", "FIGMA_ACCESS_TOKEN", "LLM_API_KEY"]
```

Or let the CLI write the block for you:

```bash
codex mcp add smart-figma --env SMART_FIGMA_LICENSE=<token> -- npx smart-figma-mcp
codex mcp list      # verify it registered
```

Two Codex-specific notes:

- **Startup timeout.** A cold `npx` downloads the package on first run, which  
  can exceed the 10s default and surface as a handshake failure. The  
  `startup_timeout_sec = 30` above avoids it.
- **IDE extension.** Servers registered via `config.toml` work in the CLI; the  
  VS Code extension has a known issue where it does not always pick them up  
  ([openai/codex#6465](https://github.com/openai/codex/issues/6465)). If tools  
  are missing in the extension but `/mcp` lists them in the TUI, this is why.

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

| Tool                      | Description                                                            |
| ------------------------- | ---------------------------------------------------------------------- |
| `compile_figma_component` | Compile Figma node → Tailwind/CSS + variant mapping + assembly context |
| `fetch_figma_node`        | Fetch raw Figma node via Figma REST API                                |
| `save_component`          | Deterministic write: clean data-node-id, save file, update index.ts    |
| `remember_mapping`        | Save user-confirmed mapping → private asset library                    |
| `scan_components`         | Auto-scan project component library (shadcn/ui / antd / mui / Astryx)  |
| `probe_astryx`            | Check whether the Astryx contract is available (CLI + core, version)   |
| `fetch_astryx_contract`   | Fetch authoritative Astryx components + props (types, enums, required) |
| `check_mapping_health`    | Check if mapped component files still exist                            |
| `export_mappings`         | Export mapping assets as JSON                                          |
| `import_mappings`         | Import mapping assets from JSON (merge, non-destructive)               |
| `cache_clear`             | Clear compilation cache                                                |
| `refresh_crl`             | Refresh License revocation list from remote                            |

## Modes

### Free Tier (Hacker)

- Pure digital compilation (PURE_DIGITAL path)
- No LLM call, zero token consumption
- Auto Layout nodes → Tailwind/CSS output
- Good for: well-structured Figma files with Auto Layout

### BYOK (Bring Your Own Key)

- **$9/month** or **$19 lifetime** (early bird)
- Plug your own API key (OpenAI / Anthropic / DeepSeek / Zhipu)
- Usage is attributed to your key; the server makes no LLM calls (code generation runs on your host LLM — already your subscription)
- Semantic + Visual compilation paths enabled
- All tools unlocked

### Supported LLM Providers

| Provider    | `LLM_PROVIDER` value | Base URL                                          |
| ----------- | -------------------- | ------------------------------------------------- |
| OpenAI      | `openai`             | `https://api.openai.com/v1`                        |
| Anthropic   | `anthropic`          | `https://api.anthropic.com/v1`                     |
| DeepSeek    | `deepseek`           | `https://api.deepseek.com/v1`                      |
| Zhipu (GLM) | `zhipu`              | `https://open.bigmodel.cn/api/paas/v4`             |
| Gemini      | `gemini`             | `https://generativelanguage.googleapis.com/v1beta` |

Set `LLM_PROVIDER` + `LLM_API_KEY` to enable BYOK. The server reads **only** these two variables — provider-specific vars like `OPENAI_API_KEY` are not consumed.

## Compilation Strategy

The compiler auto-detects node complexity with an additive score and routes accordingly:

| Score   | Level        | Strategy                               | Server Credit Cost |
| ------- | ------------ | -------------------------------------- | ------------------ |
| `< 35`  | **SIMPLE**   | PURE_DIGITAL — direct math computation | 0                  |
| `35–74` | **MODERATE** | SEMANTIC — coordinate-flow clustering  | ~1 credit          |
| `≥ 75`  | **COMPLEX**  | VISUAL — multi-modal LLM               | ~5 credits         |

> In BYOK mode the server makes **no** LLM calls, so this column is always **$0** — generation runs on your own host LLM. The costs above apply only to the Credits model.

Score terms: no Auto Layout `+30`, absolute-positioned child `+15` each,

coordinate-flow child `+5` each (capped at 50, `+20` more beyond 10),

depth beyond 4 `+8` per level.

Non-standard layouts don't fail — they return `SUGGEST_AUTOLAYOUT`, guiding you to fix at the Figma source.


## Architecture

```
┌─────────────┐  JSON-RPC   ┌──────────────────────┐
│  Cursor /   │  over stdio  │  smart-figma-mcp     │
│  Claude Code│◄────────────►│                      │
│  Codex      │              │  ┌────────────────┐  │
└─────────────┘              │  │ Offline         │  │
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

### ~4,200 lines, no runtime dependencies

| Module                                    | Lines | Responsibility                                            |
| ----------------------------------------- | ----: | --------------------------------------------------------- |
| `server.js`                               |   890 | MCP surface, tool routing, Figma REST orchestration       |
| `compiler.js`                             |   525 | Tiered compile strategy, recursive subtree compile        |
| `astryx-contract.js`                      |   480 | Astryx CLI contract adapter, union-type → enum resolution |
| `mui-antd-contract.js`                    |   286 | antd / mui `.d.ts` contract adapter, literal-union extraction |
| `mapping.js`                              |   404 | Variant resolution against the local component library    |
| `daemon.js` / `daemon-client.js`          |   387 | Long-lived cache process, socket IPC                      |
| `figma-client.js` / `figma-normalizer.js` |   311 | REST fetch + node normalization                           |
| `license.js` / `quota.js` / `byok.js`     |   413 | Entitlement, quota accounting, provider routing           |
| `cache.js` / `figma-screenshot.js`        |   309 | Compile cache, screenshot fallback                        |
| `tools/*`                                 |   336 | Key generation, license issuing, quota service            |
| `test/smoke.mjs`                          |   341 | End-to-end smoke coverage                                 |
| `test/astryx-*.mjs`                       |   288 | Astryx adapter + mapping contract tests (62 assertions)   |
| `test/mui-antd-contract.mjs`              |   101 | antd / mui `.d.ts` extraction + zero-hallucination tests  |

No runtime `dependencies` field in `package.json` — MCP over stdio plus `fetch`

and `node:crypto` are all that is required. This keeps install fast and avoids

the supply-chain surface a dependency tree would add.

### Why a tiered compile strategy

A single strategy wastes money and produces bad output. `compiler.js` scores

every node and routes it by additive score (the table above). Two details in

that scoring are deliberate:

\*\*Coordinate-flow children are counted separately from absolute-positioned

ones.\** A child with `x`/`y` but no Auto Layout is a grid the compiler can

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

project's own component library (shadcn/ui, antd, mui, Astryx). Variants come

from Figma's own variant properties reconciled against the library's contract,

so adding a component to the project is enough — there is no mapping file to

maintain.

### Three contract engines, one descriptor

All three supported paths end at the same shape — `{ name, importPath, variants }` —

so `mapToVariant()` and everything downstream stays library-agnostic. Only the

way the contract is *obtained* differs:

- **Source-derived (shadcn/ui).** `parseCVA()` reads the `cva()` call out of

  the component's `.tsx`. It is a heuristic over source that happens to be

  reliable because shadcn has a fixed convention.
- **Typed-declaration-derived (antd / mui).** `mui-antd-contract.js` reads the

  library's shipped `.d.ts` and extracts the literal-union values from each

  `<Component>Props` type — it resolves named type aliases (`type ButtonType = ...`)

  and peels mui's `OverridableStringUnion<T>` wrapper (which otherwise decays to

  `string` and loses the literals). No `cva`, no node_modules source scan needed.
- **Contract-derived (Astryx).** `astryx-contract.js` shells out to

  `@astryxdesign/cli` and reads the component's props table directly. The enum

  values are the ones Meta ships, so nothing is inferred.

The interesting part is what the CLI actually hands back: a prop's `type` is a

raw TypeScript union of string literals, e.g.

`"'primary' | 'secondary' | 'ghost' | 'destructive'"`. `parseUnionValues()`

turns that into the allowed set, and that set becomes the `variants` dimension.

A union that contains no literals (`string | number`) yields an empty set, which

`mapToVariant()` already handles by leaving that dimension unmapped — the

parser fails closed rather than inventing values.

### Beta dependencies are contained, not ignored

Astryx is v0.x and documents that breaking changes may land in any minor

release. Three decisions follow:

- **Degrade, never throw.** Every CLI call resolves to a tagged error. A missing

  or broken Astryx install reduces the component list to empty; it does not

  propagate into component scanning for the other libraries.
- **Version-stamped cache.** Contracts are cached under the CLI version that

  produced them, so an upgrade transparently invalidates rather than serving a

  stale enum that would produce wrong code.
- **Distinguish missing states.** The `component` command requires

  `@astryxdesign/core` to be present even if the CLI is installed — without it

  the call returns `ERR_CORE_NOT_FOUND`. `probe_astryx` reports

  `cliInstalled` / `coreInstalled` separately and returns the exact install

  command, instead of a generic failure the caller has to interpret.

If you use a different node runtime and the CLI cannot be spawned, set

`ASTRYX_NODE_BIN` to the interpreter to use.

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
>
> `tools/issue-license.js`, `tools/batch-issue.js`) and `tools/quota-server.js`
>
> are in this repository and in the published npm tarball. They are the
>
> operational side of a self-serve product, not secrets — the signing key is not
>
> here. If that trade-off stops being right, the fix is to move entitlement
>
> server-side, not to hide these files.

### Verification status

`npm test` runs `test/smoke.mjs` on every push (`.github/workflows/test.yml`).

It is a smoke suite, not a full test pyramid: it exercises tool routing, tier

selection, and the write path end-to-end. Coverage of the LLM assembly path is

inherently bounded — it needs live Figma files and a provider key, so CI does

not exercise it. Treat the free-tier compile path as the tested surface.

The Astryx contract has its own suite (62 assertions across three files), and the
typed-dts contract has a fourth suite:

| Test                          | Covers                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `test/astryx-adapter.mjs`     | Union-type parsing and the props → variants projection, including malformed and non-literal input     |
| `test/astryx-e2e.mjs`         | The full parse path against a real CLI capture, including that an out-of-contract variant is rejected |
| `test/astryx-mapping.mjs`     | `scanLocalComponents` integration, determinism, and that a project without Astryx is unaffected       |
| `test/mui-antd-contract.mjs`  | `.d.ts` literal-union extraction for antd/mui, alias + `OverridableStringUnion` handling, and that an out-of-contract value is dropped |

`test/astryx-contract-fixtures.mjs` is a captured Astryx CLI response (166

components) rather than a hand-written mock, so the tests fail if the upstream

contract shape changes. Regenerate it when bumping the Astryx version.


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

A: No — when using your own API key, credits are not deducted. Only the quotas service (if enabled) records usage counts. Note: the server does not call an LLM under BYOK either — code generation runs on your host LLM (Cursor / Claude Code / Codex), which is already covered by your own subscription.

**Q: My Figma file has no Auto Layout — will it work?**

A: The compiler returns `SUGGEST_AUTOLAYOUT` for complex non-layout nodes. We strongly recommend using our Auto Layoutify Figma plugin for best results.

## Platform Support

| IDE / Tool              | Support     |
| ----------------------- | ----------- |
| Cursor                  | ✅ Full      |
| Kiro                    | ✅ Full      |
| Claude Code             | ✅ Full      |
| Codex CLI               | ✅ Full      |
| Codex IDE extension     | ⚠️ See note |
| Windsurf                | ✅ Full      |
| VS Code (MCP extension) | ✅           |
| Continue.dev            | ⚠️ Limited  |
| Cline                   | ⚠️ Limited  |

Codex is supported via `config.toml` (TOML, not JSON) — see  
[IDE Setup](#ide-setup) for the exact block and two gotchas that produce  
confusing failures: a cold `npx` exceeding the 10s startup timeout, and the IDE  
extension not picking up servers that the CLI loads fine  
([openai/codex#6465](https://github.com/openai/codex/issues/6465)). The CLI is  
the reliable path today.

`Continue.dev` and `Cline` are Limited because their MCP clients implement the  
base protocol but have historically been inconsistent about long-running stdio  
servers and tool-result streaming. The limitation is in their clients, not in  
this server — if it works for you, it is worth reporting upstream.

## Pricing

| Tier                    | Price    | Quota      | BYOK | Visual Compilation |
| ----------------------- | -------- | ---------- | ---- | ------------------ |
| **Hacker**              | Free     | 10/day     | ❌    | ❌                  |
| **Maker**               | $9/mo    | 300/mo     | ✅    | ✅                  |
| **Pro**                 | $29/mo   | 1,500/mo   | ✅    | ✅                  |
| **Early Bird Lifetime** | $19 once | Maker plan | ✅    | ✅                  |

[Buy License →](https://www.npmjs.com/package/smart-figma-mcp#pricing)

---

## License

**Source available, not open source.** The code is published so it can be read,

studied, and evaluated — but you may not redistribute it, build a competing

product from it, or use it under an open source license. See

[LICENSE](./LICENSE) for the granted rights and restrictions. Commercial

licensing is available separately via the

[purchase page](https://www.npmjs.com/package/smart-figma-mcp#pricing).

Questions about the license: <https://github.com/drake-yuan/smart-figma-mcp/issues>

---

**[Privacy Policy](./PRIVACY.md)** · **[Terms of Service](./TERMS.md)**
