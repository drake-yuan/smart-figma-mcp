# Privacy Policy

> Last updated: June 21, 2026

## What We Collect

smart-figma-mcp is a locally-run CLI tool. We **do not collect** any of the following:

- ❌ **We do not collect** your Figma design file contents
- ❌ **We do not collect** your source code or project files
- ❌ **We do not collect** your API keys in BYOK mode (keys are only read from local environment variables)
- ❌ **We do not collect** your browsing history, identity information, or any personal data

## What We Log

- ✅ **License verification**: 100% offline, no network calls. Public key is bundled with the client.
- ✅ **Quota server** (optional self-hosted): Records only `sub` (user identifier) + monthly usage count. Design content is never logged.
- ✅ **Mapping asset library** (`.smart-figma/mappings.json`): Stored locally only. Never uploaded.

## Third-Party Dependencies

- If you use **BYOK mode** (Bring Your Own Key), compilation requests are sent directly to your chosen LLM provider (OpenAI / Anthropic / DeepSeek / Zhipu) and never pass through our servers.
- If you use **Credits mode**, compilation requests are processed by the local MCP server. Quota is managed by the quota server you self-host (`quota-server.js`).

## Data Security

- License tokens contain no personal user data (only `sub` / `plan` / `exp` / device fingerprint hashes)
- Private keys (`keys/private.pem`) are never included in the public npm package
- No telemetry, no tracking, no data exfiltration

## Contact

For privacy-related inquiries, please open a GitHub Issue.
