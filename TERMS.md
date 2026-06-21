# 服务条款 / Terms of Service

> 最后更新：2026-06-21

## 1. 服务说明

smart-figma-mcp（以下简称"本工具"）是一个 MCP (Model Context Protocol) Server，帮助开发者将 Figma 设计稿转换为代码。本工具通过 npm 分发，可安装到 Cursor / Claude Code / Windsurf 等 AI 编程助手。

## 2. 订阅与付费

- **免费档（Hacker）**：纯数字编译（PURE_DIGITAL 路径），不调用任何 LLM，0 Token 消耗。
- **BYOK 模式**：你自行提供 LLM Provider 的 API Key，Token 走你自己的账单。我们不对你的 API 调用成本负责。
- **Credits 模式**：按月订阅，获得固定配额。配额用尽后按 Credits 加购包扣费。

## 3. 取消与退款

- 按月订阅可随时取消，下个计费周期生效。
- 已消耗的 credits 不予退款。
- 因技术问题导致无法使用的情况，联系支持申请退款。

## 4. 输出质量

- 本工具**不保证 100% 像素对齐**。编译精度取决于 Figma 设计稿规范程度和 LLM 模型能力。
- 我们仅保证**物理编译精度**（几何数值计算是确定性的），语义映射（组件匹配）依赖 AI 模型，存在误匹配可能。
- 免费档无 SLA 承诺。

## 5. 使用限制

- 禁止反向工程 License 验签算法
- 禁止未授权分发 License token
- 禁止将本工具用于生成恶意代码
- 禁止将 BYOK key 共享给他人

## 6. 责任限制

本工具按"现状"提供，不提供任何明示或暗示的担保。在任何情况下，开发者不对因使用本工具导致的任何直接、间接、附带损失承担责任。

## 7. 管辖法律

本条款适用中华人民共和国法律。

## 联系

- GitHub Issues: https://github.com/smart-figma/mcp/issues
