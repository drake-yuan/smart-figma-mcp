# 营销文案模板

## 海外英文（Twitter / Reddit / IndieHackers）

### 主帖
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

### 对比图文字（截图旁注）
| Figma 官方 MCP | smart-figma-mcp |
|---|---|
| Suggests mapping | Maps + writes files |
| No code write | Deterministic write |
| Needs Code Connect config | Zero config (shadcn/ui + cva) |
| — | BYOK = 0 token cost |

### Reddit r/SideProject 贴
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

## 国内中文（V2EX / 知乎 / 即刻）

### 主帖
```
独立开发做了一个 Figma 转代码的 MCP 插件，直接落盘

痛点：把 Figma 链接丢给 AI，AI 不认识你项目里的 shadcn/ui Button，
重手搓一个 div 堆砌按钮，还要手动删 data-node-id 垃圾属性。

我做的：
✅ Figma 组件名 → 本地 shadcn/ui variant 自动映射
✅ 自动写入 src/components/ui/ + 更新 index.ts
✅ 物理清洗 data-node-id / data-name
✅ BYOK 模式（token 走你账单，不经过我服务器）
✅ 免费档纯本地编译，0 Token 消耗

早期买断 $19（合人民币 ~140），限前 50 名。
后面恢复 $9/月。

GitHub + 视频见评论 👇
```

### 知乎回答模板
```
Q: Figma 设计稿怎么高效转前端代码？

A: 目前有三种方式：
1. Figma Dev Mode → 手动复制 CSS（最原始）
2. AI 对话（Cursor/Claude Code）+ Figma 链接 → 凑合用，但不认你的项目组件
3. smart-figma-mcp → 直接映射到本地 shadcn/ui，自动落盘（新思路）

第三种我自己在用的，原因是...
```
