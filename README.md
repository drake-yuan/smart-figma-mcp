# smart-figma-mcp (v5.0 最小可跑骨架)

验证 v5.0 三条命门的最小 MCP Server：**BYOK + 离线 Ed25519 license + 服务端权威配额**。
零外部依赖，纯 Node 实现 MCP 的 JSON-RPC over stdio。

## 它证明了什么

| 命门 | 代码位置 | 验证点 |
|---|---|---|
| BYOK 干掉 token 黑洞 | `src/byok.js` + `src/quota.js` | 填了自己的 key → 不扣 credits，我方零变动成本 |
| 离线 license（治 stdio 调用超时） | `src/license.js` | Ed25519 本地验签，全程零网络；过期/篡改/换设备即拒 |
| 服务端权威配额（防薅羊毛） | `src/quota.js` | 纯数字 0.1 / 语义 1 / 视觉 5 credits，成本对齐 |
| Variant 级映射护城河 | `src/mapping.js` | Figma 属性→本地组件 props；用户确认的映射沉淀为私有资产 |
| 确定性写操作 | `src/server.js: toolSave` | 清洗 data-node-id + 精确落盘 + 自动更新 index.ts |
| 非标稿源头治理 | `src/compiler.js` | 复杂稿不硬吞，返回 Auto Layout 化建议 |

## 这份代码对应白皮书的哪一部分

本仓库是 `百万美元周末Plan_v6.0.md`「附录：可直接运行的最小骨架代码」的实体落地。每个模块都对应白皮书里的一个论点，反向可追溯：

| 代码模块 | 对应白皮书章节 | 论点 |
|---|---|---|
| `src/byok.js` + `src/quota.js` | 第二部分（重构经济模型） | BYOK 焊死亏钱黑洞 + 防薅羊毛三道闸 |
| `src/mapping.js` | 第三部分（硬核护城河） | Variant 级语义映射 + 私有映射资产库 |
| `src/server.js: toolSave` | 第三部分 · 4 | 确定性写操作（落盘 + barrel + 清洗） |
| `src/compiler.js` | 第四部分（技术架构演进） | 几何骨架编译 + 智能渐进式降级 |
| `src/license.js` | 第五部分（根治 stdio 调用超时）+ 第六部分（合规鉴权） | Ed25519 全离线验签 |
| `src/server.js` 主循环 | 第一部分（撕碎 MCP 外衣） | JSON-RPC over stdio 两轮握手 |

> 改了白皮书的论点，记得回来同步对应模块；改了代码的行为，记得回去更新白皮书附录的「实测验证因果链」表。两份文件互为镜像。

## 和 Figma 官方 Dev Mode MCP 的区别（必答题）

Figma 官方在 2025 年已发布 **Dev Mode MCP Server** + **Code Connect**，官方、免费、直连，干的也是"把 Figma 组件映射到代码库组件"。任何人评估这个项目，第一个问题就是"那你和 Figma 官方有啥区别"。本仓库的代码定位就是回答这道题：

| 维度 | Figma 官方 Dev Mode MCP | 本项目 (smart-figma-mcp) |
|---|---|---|
| 读 Figma / 建议映射 | ✅ 强（亲儿子） | 不硬拼这块 |
| **写进你的代码库** | ❌ 不碰落盘 | ✅ `toolSave`：清洗 + 精确落盘 + 更新 `index.ts` + `eslint --fix` |
| 变体映射前置成本 | 要手写大量 Code Connect 配置 | ✅ 深绑 `shadcn/ui + cva`，零配置自动对齐 (`mapping.js`) |
| Token 成本归属 | 走 IDE / 用户 | ✅ BYOK，明确走用户账单 (`byok.js`) |

> 一句话：**不和官方拼"读和建议"，拼它不碰的"写和落盘"。** 这条差异化对应白皮书第三部分 · 1，是所有营销文案的标准答案。

## 快速跑通

```bash
# 1. 生成密钥对（发证服务器侧，一次性）
npm run keygen

# 2. 签发一个 license（发证服务器侧）
node tools/issue-license.js --sub you@x.com --plan maker --days 30
#    复制输出的 token

# 3. 端到端烟囱测试（模拟 Cursor 通过 stdio 驱动）
SMART_FIGMA_LICENSE="<上一步的 token>" node test/smoke.mjs

# 3b. BYOK 模式（token 走你自己账单，不扣 credits）
SMART_FIGMA_LICENSE="<token>" LLM_PROVIDER=anthropic LLM_API_KEY=sk-... node test/smoke.mjs
```

## 接入 Cursor / Claude Code

```jsonc
{
  "mcpServers": {
    "smart-figma": {
      "command": "node",
      "args": ["/绝对路径/smart-figma-mcp/src/server.js"],
      "env": {
        "SMART_FIGMA_LICENSE": "用户的离线 license",
        "LLM_PROVIDER": "anthropic",
        "LLM_API_KEY": "用户自己的 key"
      }
    }
  }
}
```

也可用官方测试台：`npx @modelcontextprotocol/inspector node src/server.js`

## 工具

- `compile_figma_component` — 离线编译 Figma 节点 → Tailwind + variant 映射 + 装配上下文
- `save_component` — 清洗 + 精确落盘 + barrel 导出
- `remember_mapping` — 沉淀私有映射资产（切换成本护城河）

## 边界（这是骨架，不是成品）

- `quota.js` 用本地 JSON 模拟"服务端权威账本"；真实部署把 `debit()` 换成对你云端 `/quota/debit` 的一次网络请求。
- 真实 LLM 装配调用未实现（避免烟囱测试产生 token 成本）；`assemblyPrompt` 即喂给用户自己 LLM 的上下文。
- `keys/private.pem` 只放发证服务器，已在 `.gitignore`，**绝不进客户端 / 绝不进 git**。
- `figma_auto_layoutify`（Figma 端预处理插件）是独立交付物，此处仅作引导占位。
