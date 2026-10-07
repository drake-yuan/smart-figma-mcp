// byok.js — Bring Your Own Key (BYOK) v2
// This server never calls the LLM itself — it only maps Figma → components and
// returns a prompt. The client (Cursor / Claude Code / Codex) performs the actual
// LLM call on the user's own key, so we never bill or pay for any tokens here.
// Our subscription fee sells only the engineering orchestration layer.
//
// v2 additions: deepseek / zhipu providers, API key validity probe, security warning.

const SUPPORTED = ["anthropic", "openai", "gemini", "deepseek", "zhipu"];

// Base URL + probe model for each provider.
const PROVIDER_META = {
  anthropic: { baseURL: "https://api.anthropic.com", model: "claude-3-haiku-20240307" },
  openai: { baseURL: "https://api.openai.com/v1", model: "gpt-3.5-turbo" },
  gemini: { baseURL: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-1.5-flash" },
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  zhipu: { baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
};

/**
 * Resolve the BYOK configuration from environment variables.
 * Returns { byok: true } when the user supplies their own key; otherwise
 * falls back to the Credits model (cost covered by us, quota-limited).
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
  // No key configured -> fall back to the Credits model (we pay, quota-limited).
  return { byok: false };
}

/**
 * Lightweight API key validity probe (<= 1 request, does not slow startup).
 * Sends a minimal request to the provider (models list, or a 1-token chat completion).
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
      // gemini: skip probing to avoid a billable 1-token call.
      return { valid: true, note: "skipped" };
    }

    // 401/403 -> invalid; 2xx -> valid; anything else -> inconclusive.
    if (res.status === 401 || res.status === 403) return { valid: false, reason: "unauthorized" };
    if (res.ok) return { valid: true };
    return { valid: false, reason: `HTTP ${res.status}`, unsure: true };
  } catch (e) {
    return { valid: false, reason: e.message, unsure: true };
  }
}

/** Security reminder: detect API keys passed in plaintext. */
export function securityWarning(config) {
  if (!config.byok) return null;
  // Detect a key sourced from a plaintext env var (risk of a non-gitignored .env file).
  if (process.env.LLM_API_KEY && !process.env.LLM_API_KEY_SECRET) {
    return "⚠️  Your API key is being passed in plaintext via an environment variable. Make sure your .env file is in .gitignore. Using a system keychain is recommended.";
  }
  return null;
}

function maskKey(k) {
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}...${k.slice(-4)}`;
}
