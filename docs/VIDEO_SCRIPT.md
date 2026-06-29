# 60-Second Comparison Video Script

> Recording: QuickTime + OBS | Format: 9:16 Shorts / 1:1 Twitter | Audio: English captions, no voiceover

## Scene 1: The Pain (0:00–0:15)

### Visual
- Cursor editor + Figma side by side
- User selects a Button component in Figma
- Copies link → pastes into Cursor chat
- AI replies: a raw `<div>` Button with inline styles, ignoring the project's shadcn/ui Button

### Caption
```
✕ Old way: paste Figma link → AI
→ AI doesn't know your components
→ Rebuilds Button from scratch as div-soup
→ Wrong styles, missing variants, data-node-id junk
```

### Overlay
❌ `0.5x` slow-motion + red border

---

## Scene 2: The Fix (0:15–0:30)

### Visual
- Terminal: `npx smart-figma-mcp`
- Cursor MCP config panel — adds smart-figma-mcp
- Same Figma link pasted
- AI recognizes Button component → outputs `import { Button } from "@/components/ui/button"`
- Auto-matches `variant="destructive"`

### Caption
```
✓ With smart-figma-mcp:
→ AI reads figma component name
→ Maps to your local shadcn/ui Button
→ variant="destructive" auto-aligned
→ Output is your project's real component
```

### Overlay
✅ Green border + speed ramp

---

## Scene 3: The Result (0:30–0:45)

### Visual
- `src/components/ui/ProductCard.tsx` auto-generated
- `index.ts` barrel export auto-updated
- Terminal: `eslint --fix` passes ✓
- File content shown — no `data-node-id` / `data-name` junk

### Caption
```
Auto-write file → update index.ts → eslint clean
data-node-id physically stripped
Zero noise in code review
```

### Overlay
✅ 3-second completion, progressive reveal

---

## Scene 4: BYOK (0:45–0:55)

### Visual
- Env vars displayed: `OPENAI_API_KEY=sk-***` / `DEEPSEEK_API_KEY=sk-***`
- Label: "TOKENS ON YOUR BILL"
- Free tier demo: pure digital compilation, zero LLM calls, 0 tokens

### Caption
```
BYOK mode: tokens billed to you
Free tier: local compilation, 0 token cost
License verification: 100% offline
```

---

## CTA (0:55–1:00)

### Visual
- Black background, white text
- Product name + price + link

### Caption
```
smart-figma-mcp
First 50: $19 lifetime
Link in bio / pinned comment
```
