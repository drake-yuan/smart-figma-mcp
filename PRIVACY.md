# 隐私政策 / Privacy Policy

> 最后更新：2026-06-21

## 我们收集什么

smart-figma-mcp 是一个本地运行的 CLI 工具。我们**不收集**以下任何数据：

- ❌ **不收集**你的 Figma 设计稿内容
- ❌ **不收集**你的源代码或项目文件
- ❌ **不收集**BYOK 模式下你的 API Key（仅通过本地环境变量传递）
- ❌ **不收集**你的浏览器历史、身份信息或任何个人隐私数据

## 我们记录什么

- ✅ **License 验签**：100% 离线，不联网。公钥随客户端打包。
- ✅ **配额服务端**（可选启用）：仅记录 `sub`（用户标识）+ 月度用量计数，不记录设计内容。
- ✅ **映射资产库**（`.smart-figma/mappings.json`）：仅存本地，不上传。

## 第三方依赖

- 如果你使用 **BYOK 模式**（自带 API Key），代码编译请求直接发往你选择的 LLM Provider（OpenAI / Anthropic / DeepSeek / Zhipu），不经过我们服务器。
- 如果你使用 **Credits 模式**，编译请求通过本地 MCP Server 处理，配额由服务端（你自行部署的 `quota-server.js`）管理。

## 数据安全

- License token 不含用户隐私（仅 `sub` / `plan` / `exp` / `devices` 指纹哈希）
- 私钥（`keys/private.pem`）不进入客户端 npm 包
- 无数据外传、无遥测、无埋点

## 联系

如有隐私相关问题，请通过 GitHub Issues 联系。
