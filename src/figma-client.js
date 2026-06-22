// figma-client.js — Figma REST API v1 wrapper (zero external dependencies)
//
// Supported endpoints (note: Figma REST is v1, and images is a separate top-level endpoint):
//   GET /v1/files/:key            -> file metadata
//   GET /v1/files/:key/nodes      -> node details (core)
//   GET /v1/images/:key           -> node screenshots (multimodal fallback; top-level, not under /files)
//
// Features: exponential backoff retry, 15s timeout, cross-border-friendly errors,
//           HTTP(S)_PROXY support via a CONNECT tunnel.

import http from "node:http";
import https from "node:https";

// Exponential-backoff sleep.
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const BASE = "https://api.figma.com";
const DEFAULT_TIMEOUT = 15000; // 15s, friendly to cross-border networks
const MAX_RETRIES = 3;

/**
 * Low-level fetch wrapper: timeout + 429 retry + HTTP_PROXY.
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

  // HTTP_PROXY support. Node 18+ fetch does not natively support proxies, and using
  // undici's ProxyAgent would break the zero-dependency rule, so when a proxy is set
  // we fall back to the built-in http/https modules.
  const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (proxy) {
    clearTimeout(timer);
    return fetchViaProxy(url, token, timeout, proxy);
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, fetchOpts);
      clearTimeout(timer);

      if (res.status === 429) {
        // Rate limited -> exponential backoff.
        const retryAfter = parseInt(res.headers.get("Retry-After")) || Math.pow(2, attempt + 1);
        if (attempt < MAX_RETRIES) {
          await sleep(retryAfter * 1000);
          continue;
        }
        throw new Error(`Figma API rate limited; please retry shortly (waited ${retryAfter}s).`);
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
        throw new Error(`Figma API timed out (${timeout / 1000}s); check your network or configure HTTP_PROXY.`);
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
 * HTTP(S)_PROXY mode: the Figma API is HTTPS, so we must open a CONNECT tunnel and
 * run TLS over it. Uses the canonical Node pattern of http (CONNECT) + https (over the
 * tunneled socket), keeping zero external dependencies.
 */
function fetchViaProxy(url, token, timeout, proxyUrl) {
  return new Promise((resolve, reject) => {
    let proxy;
    try {
      proxy = new URL(proxyUrl);
    } catch {
      reject(new Error(`Invalid HTTP_PROXY format: ${proxyUrl}`));
      return;
    }
    const target = new URL(url);

    const headers = {};
    if (proxy.username) {
      const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
      headers["Proxy-Authorization"] = `Basic ${auth}`;
    }

    const connectReq = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:443`,
      headers,
      timeout,
    });

    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${res.statusCode} (check whether HTTP_PROXY is reachable).`));
        return;
      }
      // Issue the HTTPS request over the tunneled socket; agent:false + socket lets
      // https complete the TLS handshake on that socket itself.
      const proxied = https.request(
        {
          host: target.hostname,
          path: target.pathname + target.search,
          method: "GET",
          headers: { "X-Figma-Token": token, "Content-Type": "application/json" },
          socket,
          agent: false,
          timeout,
        },
        (r) => {
          let body = "";
          r.on("data", (c) => (body += c));
          r.on("end", () => {
            if (r.statusCode === 429) {
              const retryAfter = parseInt(r.headers["retry-after"]) || 5;
              reject(new Error(`Figma API 429 rate limited; please retry in ${retryAfter}s.`));
              return;
            }
            if (!r.statusCode || r.statusCode >= 400) {
              reject(new Error(`Figma API ${r.statusCode}: ${body.slice(0, 200)}`));
              return;
            }
            try { resolve(JSON.parse(body)); }
            catch { reject(new Error(`Figma API returned non-JSON: ${body.slice(0, 200)}`)); }
          });
        }
      );
      proxied.on("timeout", () => { proxied.destroy(); reject(new Error(`Figma API timed out (${timeout / 1000}s).`)); });
      proxied.on("error", (e) => reject(new Error(`Figma API (proxy) network error: ${e.message}`)));
      proxied.end();
    });

    connectReq.on("timeout", () => { connectReq.destroy(); reject(new Error(`Proxy connection timed out (${timeout / 1000}s).`)); });
    connectReq.on("error", (e) => reject(new Error(`Proxy connection error: ${e.message} (in mainland China, verify HTTP_PROXY is reachable).`)));
    connectReq.end();
  });
}

/**
 * GET /v1/files/:key -> fetch file metadata.
 */
export async function getFile(fileKey, token) {
  return figmaFetch(`/v1/files/${fileKey}`, token);
}

/**
 * GET /v1/files/:key/nodes?ids=:nodeId -> fetch node details (core).
 */
export async function getNode(fileKey, nodeId, token) {
  const encodedId = encodeURIComponent(nodeId);
  return figmaFetch(`/v1/files/${fileKey}/nodes?ids=${encodedId}`, token);
}

/**
 * GET /v1/images/:key?ids=:nodeId&format=png -> fetch node screenshot.
 * Note: images is a separate top-level endpoint, NOT under /files/.
 */
export function getImages(fileKey, nodeId, token, format = "png") {
  const encodedId = encodeURIComponent(nodeId);
  return figmaFetch(`/v1/images/${fileKey}?ids=${encodedId}&format=${format}`, token);
}
