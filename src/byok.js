// byok.js — Bring Your Own Key（一招干掉 token 财务黑洞）
// token 成本直接走用户自己的账单，与我方零关。我方月费只卖工程编排能力。

const SUPPORTED = ["anthropic", "openai", "gemini"];

/**
 * 从环境变量读取 BYOK 配置。
 * 返回 { byok:true } 表示用户自带 key；否则走 Credits 制（我方代付）。
 */
export function resolveLLMConfig(env = process.env) {
  const provider = (env.LLM_PROVIDER || "").toLowerCase();
  const apiKey = env.LLM_API_KEY || "";

  if (provider && apiKey) {
    if (!SUPPORTED.includes(provider)) {
      return { byok: false, error: `unsupported_provider:${provider}` };
    }
    return { byok: true, provider, apiKey, masked: maskKey(apiKey) };
  }
  // 未配置 key → 退回 Credits 制（我方代付，受配额限制）
  return { byok: false };
}

function maskKey(k) {
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}...${k.slice(-4)}`;
}
