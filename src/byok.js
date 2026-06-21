// byok.js — Bring Your Own Key v2
// token 成本直接走用户自己的账单，与我方零关。我方月费只卖工程编排能力。
//
// v2 新增：deepseek / zhipu provider、Key 有效性检测、安全提醒

const SUPPORTED = ["anthropic", "openai", "gemini", "deepseek", "zhipu"];

// 各 provider 的 base URL + models 探测端点
const PROVIDER_META = {
  anthropic: { baseURL: "https://api.anthropic.com", model: "claude-3-haiku-20240307" },
  openai: { baseURL: "https://api.openai.com/v1", model: "gpt-3.5-turbo" },
  gemini: { baseURL: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-1.5-flash" },
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  zhipu: { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
};

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
    const meta = PROVIDER_META[provider];
    return { byok: true, provider, apiKey, baseURL: meta.baseURL, model: meta.model, masked: maskKey(apiKey) };
  }
  // 未配置 key → 退回 Credits 制（我方代付，受配额限制）
  return { byok: false };
}

/**
 * Key 有效性快速检测（≤1 请求，不影响启动速度）。
 * 向 provider 发一个极轻量请求（如 models list 或 chat completion with 1 token）。
 */
export async function probeKey(config) {
  if (!config.byok) return { valid: false, reason: "no_key" };

  const { provider, apiKey, baseURL } = config;
  try {
    let res;
    if (provider === "deepseek" || provider === "openai") {
      res = await fetch(`${baseURL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
    } else if (provider === "anthropic") {
      res = await fetch(`${baseURL}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: config.model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(5000),
      });
    } else if (provider === "zhipu") {
      res = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(5000),
      });
    } else {
      // gemini: 不做探测，避免 1 token 调用
      return { valid: true, note: "skipped" };
    }

    // 401/403 → 无效；2xx → 有效；其他 → 不确定
    if (res.status === 401 || res.status === 403) return { valid: false, reason: "unauthorized" };
    if (res.ok) return { valid: true };
    return { valid: false, reason: `HTTP ${res.status}`, unsure: true };
  } catch (e) {
    return { valid: false, reason: e.message, unsure: true };
  }
}

/** Key 安全提醒（检测明文传递） */
export function securityWarning(config) {
  if (!config.byok) return null;
  // 检测 key 是否来自环境变量明文（.env 文件未 gitignored 的风险）
  if (process.env.LLM_API_KEY && !process.env.LLM_API_KEY_SECRET) {
    return "⚠️  你的 API Key 以明文方式通过环境变量传递。请确认 .env 文件已在 .gitignore 中。推荐使用系统密钥链存储。";
  }
  return null;
}

function maskKey(k) {
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}...${k.slice(-4)}`;
}
