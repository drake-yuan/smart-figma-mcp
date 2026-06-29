# Terms of Service

> Last updated: June 21, 2026

## 1. Service Description

smart-figma-mcp (the "Tool") is an MCP (Model Context Protocol) Server that helps developers convert Figma designs into code. The Tool is distributed via npm and integrates with AI coding assistants including Cursor, Claude Code, and Windsurf.

## 2. Subscription & Payment

- **Free Tier (Hacker)**: Pure digital compilation (PURE_DIGITAL path). No LLM calls, zero token consumption.
- **BYOK Mode**: You provide your own LLM provider API key. Tokens are billed directly by your provider. We are not responsible for your API usage costs.
- **Credits Mode**: Monthly subscription with a fixed quota. Additional credits may be purchased once the quota is exhausted.

## 3. Cancellation & Refunds

- Monthly subscriptions can be cancelled at any time, effective at the next billing cycle.
- Consumed credits are non-refundable.
- If the Tool becomes unusable due to technical issues, contact support to request a refund.

## 4. Output Quality

- The Tool **does not guarantee pixel-perfect output**. Compilation accuracy depends on the quality of the Figma design file and LLM model capability.
- We guarantee **deterministic geometric computation** (coordinate values and layout math are exact). Semantic mapping (component matching) relies on AI models and may produce incorrect matches.
- No SLA is provided for the Free tier.

## 5. Usage Restrictions

You agree not to:

- Reverse-engineer the license verification algorithm
- Distribute license tokens without authorization
- Use the Tool to generate malicious code
- Share BYOK API keys with third parties

## 6. Limitation of Liability

THE TOOL IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. IN NO EVENT SHALL THE DEVELOPERS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES ARISING FROM THE USE OF THE TOOL.

## 7. Governing Law

These terms are governed by the laws of the People's Republic of China.

## Contact

- GitHub Issues: https://github.com/smart-figma/mcp/issues
