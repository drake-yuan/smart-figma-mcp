# Marketing Copy Templates

## Twitter / X (#buildinpublic)

### Main Thread
```
90% of frontend devs waste time when using Figma + AI.

Here's why:
→ You paste a Figma link
→ AI doesn't know your project's Button component
→ It generates a new <div> mess every time

I built smart-figma-mcp to fix this.

What it does:
✅ Maps Figma components → your local shadcn/ui variants
✅ Writes code directly to src/components/ui/
✅ Auto-updates index.ts barrel export
✅ Strips data-node-id garbage
✅ BYOK — tokens go on YOUR bill, zero cost on our side

Free tier: pure digital compilation, no LLM call, 0 token.

Early bird: $19 lifetime (first 50 only)
Link in bio 🧵👇
```

### Comparison Graphic Captions
| Figma Official MCP | smart-figma-mcp |
|---|---|
| Suggests mapping | Maps + writes files |
| No code write | Deterministic write |
| Needs Code Connect config | Zero config (shadcn/ui + cva) |
| — | BYOK = 0 token cost |

---

## Reddit (r/SideProject / r/cursor)

### Post
```
Title: I built a Figma-to-Code MCP that writes directly to your project

After months of copying Figma links into Cursor and getting 
random div-soup back, I built a tool that:

1. Knows your project components (shadcn/ui, antd, mui)
2. Matches Figma variants → cva() props
3. Writes clean component files
4. Updates index.ts exports

$19 lifetime for first 50 early adopters.
Source on GitHub + demo video in comments.
```

---

## IndieHackers

### Post
```
I shipped smart-figma-mcp — a Figma-to-Code MCP Server

What problem does it solve?
Pasting Figma links into Cursor/Claude Code gives you div-soup.
AI doesn't know your shadcn/ui components.

My solution:
• Variant-level mapping: Figma component → cva() props
• Deterministic write: code lands in src/components/ui/
• Barrel export auto-update
• data-node-id stripped on save
• BYOK — tokens on your bill, zero marginal cost for me

Tech: Node.js, JSON-RPC over stdio, Ed25519 offline license

Pricing: Free tier (pure digital) + $9/mo Maker + $19 early-bird lifetime

Revenue: $0 (just launched)
Goal: $100 MRR by end of month

Would love feedback from the community!
```

---

## Hacker News (Show HN)

### Title
```
Show HN: smart-figma-mcp — Figma to shadcn/ui with deterministic code write
```

### Body
```
I got tired of pasting Figma links into Cursor and getting back
div-soup that doesn't use my project's shadcn/ui components.

smart-figma-mcp is an MCP server that:

1. Fetches Figma nodes via REST API
2. Maps Figma component names → your local shadcn/ui variants
3. Compiles to Tailwind/CSS Modules/SCSS/Styled Components
4. Writes files deterministically to src/components/ui/
5. Auto-updates index.ts barrel export
6. Strips data-node-id and data-name

It's BYOK by default — you bring your own LLM API key, tokens go
on your bill. Free tier does pure digital compilation (no LLM
call at all). License is Ed25519 offline verification — zero
network calls for auth.

Zero dependencies. npm install and go.

Would love feedback on the approach. Is deterministic file write
the right bet vs. suggestion-only?
```
