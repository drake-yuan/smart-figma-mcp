// figma-screenshot.js — fetch Figma node screenshots + local cache.
//
// Multimodal fallback: when complexity is VISUAL, automatically pull the node's PNG
// screenshot and pass it to the user's LLM for visual understanding (vision over
// computation), instead of brute-forcing the layout.
//
// Features:
//   - calls the Figma REST API GET /v1/images/:key (separate top-level endpoint)
//   - local file cache (30-day TTL, matching the Figma CDN expiry)
//   - on cache hit, returns the local path and skips the API call

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { figmaFetch } from "./figma-client.js";

const CACHE_DIR = path.join(os.homedir(), ".smart-figma", "cache", "screenshots");
const CACHE_TTL = 30 * 86400000; // 30 days

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKey(fileKey, nodeId) {
  return createHash("sha256").update(`${fileKey}:${nodeId}`).digest("hex").slice(0, 12);
}

function cachePath(fileKey, nodeId) {
  return path.join(CACHE_DIR, `${cacheKey(fileKey, nodeId)}.png`);
}

function cacheMetaPath(fileKey, nodeId) {
  return path.join(CACHE_DIR, `${cacheKey(fileKey, nodeId)}.json`);
}

/**
 * Fetch a node screenshot, preferring the cache.
 *
 * @param {string} fileKey - Figma file key
 * @param {string} nodeId  - node id (e.g. "1:2")
 * @param {string} token   - Figma Personal Access Token
 * @param {Object} opts    - { format?, scale? }
 * @returns {Promise<{ localPath: string, url: string, fromCache: boolean }>}
 */
export async function getScreenshot(fileKey, nodeId, token, opts = {}) {
  ensureCacheDir();

  const pngPath = cachePath(fileKey, nodeId);
  const metaPath = cacheMetaPath(fileKey, nodeId);
  const format = opts.format || "png";
  const scale = opts.scale || 1;

  // Check the cache.
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const age = Date.now() - meta.cachedAt;
    if (age < CACHE_TTL && fs.existsSync(pngPath)) {
      const stat = fs.statSync(pngPath);
      if (stat.size > 0) {
        return {
          localPath: pngPath,
          url: meta.imageUrl,
          fromCache: true,
          cachedAt: meta.cachedAt,
        };
      }
    }
  } catch { /* cache miss */ }

  // Call the Figma API.
  const encodedId = encodeURIComponent(nodeId);
  const data = await figmaFetch(
    `/v1/images/${fileKey}?ids=${encodedId}&format=${format}&scale=${scale}`,
    token
  );

  const imageUrl = data?.images?.[nodeId];
  if (!imageUrl) {
    throw new Error(`Figma API did not return a screenshot URL for node ${nodeId}`);
  }

  // Download and cache the image.
  const imageData = await downloadImage(imageUrl);
  fs.writeFileSync(pngPath, imageData);
  fs.writeFileSync(metaPath, JSON.stringify({
    imageUrl,
    cachedAt: Date.now(),
    fileKey,
    nodeId,
    format,
    scale,
  }));

  return {
    localPath: pngPath,
    url: imageUrl,
    fromCache: false,
    cachedAt: Date.now(),
  };
}

/**
 * Fetch screenshots for multiple nodes in a batch.
 */
export async function getScreenshots(fileKey, nodeIds, token, opts = {}) {
  ensureCacheDir();
  const format = opts.format || "png";
  const scale = opts.scale || 1;

  const idsQuery = nodeIds.map(id => encodeURIComponent(id)).join(",");
  const data = await figmaFetch(
    `/v1/images/${fileKey}?ids=${idsQuery}&format=${format}&scale=${scale}`,
    token
  );

  const results = {};
  for (const [id, url] of Object.entries(data?.images || {})) {
    const pngPath = cachePath(fileKey, id);
    const metaPath = cacheMetaPath(fileKey, id);

    try {
      const imageData = await downloadImage(url);
      fs.writeFileSync(pngPath, imageData);
      fs.writeFileSync(metaPath, JSON.stringify({
        imageUrl: url,
        cachedAt: Date.now(),
        fileKey,
        nodeId: id,
        format,
        scale,
      }));
      results[id] = { localPath: pngPath, url, fromCache: false };
    } catch (e) {
      results[id] = { error: e.message };
    }
  }

  return results;
}

/**
 * Clear expired cache entries.
 */
export function clearExpiredCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR, { withFileTypes: true });
    const now = Date.now();
    for (const f of files) {
      if (f.isFile() && f.name.endsWith(".json")) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f.name), "utf8"));
          if (now - meta.cachedAt > CACHE_TTL) {
            const pngName = f.name.replace(".json", ".png");
            fs.unlinkSync(path.join(CACHE_DIR, f.name));
            try { fs.unlinkSync(path.join(CACHE_DIR, pngName)); } catch {}
          }
        } catch { /* skip malformed meta */ }
      }
    }
  } catch {}
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download screenshot: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}
