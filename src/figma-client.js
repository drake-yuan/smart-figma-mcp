// figma-client.js — Figma REST API v2 封装（零外部依赖）
//
// 支持的接口：
//   GET /v2/files/:key            → 文件元数据
//   GET /v2/files/:key/nodes      → 节点详情（核心）
//   GET /v2/files/:key/images     → 节点截图（多模态降级）
//
// 特性：指数退避重试、15s 超时、跨境友好错误提示、HTTP_PROXY 支持

// 指数退避休眠
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const BASE = "https://api.figma.com";
const DEFAULT_TIMEOUT = 15000; // 15s，跨境网络友好
const MAX_RETRIES = 3;

/**
 * 底层 fetch 封装：超时 + 429 重试 + HTTP_PROXY
 */
export async function figmaFetch(path, token, opts = {}) {
  const url = `${BASE}${path}`;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const fetchOpts = {
    method: opts.method || "GET",
    headers: {
      "X-Figma-Token": token,
      "Content-Type": "application/json",
    },
    signal: controller.signal,
  };

  // HTTP_PROXY 支持（Node 18+ fetch 不原生支持 proxy，用 undici 的 ProxyAgent 又破坏零依赖）
  // 所以：如果有 HTTP_PROXY，改用 https 模块（Node 内置）
  const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (proxy) {
    clearTimeout(timer);
    return legacyFetchWithProxy(url, token, timeout, proxy);
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, fetchOpts);
      clearTimeout(timer);

      if (res.status === 429) {
        // 速率限制 → 指数退避
        const retryAfter = parseInt(res.headers.get("Retry-After")) || Math.pow(2, attempt + 1);
        if (attempt < MAX_RETRIES) {
          await sleep(retryAfter * 1000);
          continue;
        }
        throw new Error(`Figma API 速率限制，请稍后重试（等待 ${retryAfter}s）。`);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const msg = body ? JSON.parse(body).message || body.slice(0, 200) : `${res.status} ${res.statusText}`;
        throw new Error(`Figma API ${res.status}: ${msg}`);
      }

      return res.json();
    } catch (e) {
      lastError = e;
      if (e.name === "AbortError") {
        throw new Error(`Figma API 超时（${timeout / 1000}s），请检查网络或配置 HTTP_PROXY。`);
      }
      if (attempt < MAX_RETRIES && e.message.includes("429")) {
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

/**
 * HTTP_PROXY 模式：用 Node 内置 https + http 模块发出请求
 */
function legacyFetchWithProxy(url, token, timeout, proxyUrl) {
  return new Promise((resolve, reject) => {
    const { protocol, hostname, port, pathname } = new URL(url);
    const urlObj = new URL(proxyUrl);
    if (urlObj.protocol !== "http:") {
      reject(new Error("HTTP_PROXY 仅支持 http:// 协议的代理地址"));
      return;
    }

    const http = __non_webpack_require__("http");
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: url,
      method: "GET",
      headers: { "X-Figma-Token": token, "Content-Type": "application/json" },
      timeout,
    }, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        if (res.statusCode === 429) {
          const retryAfter = parseInt(res.headers["retry-after"]) || 5;
          reject(new Error(`Figma API 429 速率限制，请 ${retryAfter}s 后重试。`));
          return;
        }
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`Figma API ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Figma API 返回非 JSON: ${body.slice(0, 200)}`)); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`Figma API 超时（${timeout / 1000}s）。`)); });
    req.on("error", (e) => reject(new Error(`Figma API 网络错误：${e.message}（如在国内请配置 HTTP_PROXY）。`)));
    req.end();
  });
}

// 被 legacyFetchWithProxy 的 eval 覆盖用，实际就是 require
function __non_webpack_require__(mod) {
  return require(mod);
}

/**
 * GET /v2/files/:key → 获取文件元数据
 */
export async function getFile(fileKey, token) {
  return figmaFetch(`/v2/files/${fileKey}`, token);
}

/**
 * GET /v2/files/:key/nodes?ids=:nodeId → 获取节点详情（核心）
 */
export async function getNode(fileKey, nodeId, token) {
  const encodedId = encodeURIComponent(nodeId);
  return figmaFetch(`/v2/files/${fileKey}/nodes?ids=${encodedId}`, token);
}

/**
 * GET /v2/files/:key/images?ids=:nodeId&format=png → 获取节点截图
 */
export function getImages(fileKey, nodeId, token, format = "png") {
  const encodedId = encodeURIComponent(nodeId);
  return figmaFetch(`/v2/files/${fileKey}/images?ids=${encodedId}&format=${format}`, token);
}
