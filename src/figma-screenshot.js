// figma-screenshot.js — Figma 节点截图获取 + 本地缓存
//
// 多模态降级：当复杂度为 VISUAL 时，自动拉取节点 PNG 截图，
// 传给用户的 LLM 做视觉理解（以视代算），而非硬算布局。
//
// 特性：
//   - 调用 Figma REST API GET /v2/images
//   - 本地文件缓存（30 天有效期，与 Figma CDN 过期一致）
//   - 缓存命中直接返回本地路径，跳过 API 调用

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { figmaFetch } from "./figma-client.js";

const CACHE_DIR = path.join(os.homedir(), ".smart-figma", "cache", "screenshots");
const CACHE_TTL = 30 * 86400000; // 30 天

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
 * 获取节点截图，优先从缓存读取
 *
 * @param {string} fileKey - Figma 文件 Key
 * @param {string} nodeId  - 节点 ID（如 "1:2"）
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

  // 检查缓存
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
  } catch { /* 缓存未命中 */ }

  // 调用 Figma API
  const encodedId = encodeURIComponent(nodeId);
  const data = await figmaFetch(
    `/v2/files/${fileKey}/images?ids=${encodedId}&format=${format}&scale=${scale}`,
    token
  );

  const imageUrl = data?.images?.[nodeId];
  if (!imageUrl) {
    throw new Error(`Figma API 未返回节点 ${nodeId} 的截图 URL`);
  }

  // 下载并缓存图片
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
 * 批量获取多个节点的截图
 */
export async function getScreenshots(fileKey, nodeIds, token, opts = {}) {
  ensureCacheDir();
  const format = opts.format || "png";
  const scale = opts.scale || 1;

  const idsQuery = nodeIds.map(id => encodeURIComponent(id)).join(",");
  const data = await figmaFetch(
    `/v2/files/${fileKey}/images?ids=${idsQuery}&format=${format}&scale=${scale}`,
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
 * 清除过期缓存
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
  if (!res.ok) throw new Error(`下载截图失败：${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}
