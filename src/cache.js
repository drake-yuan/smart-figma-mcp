// cache.js — L1/L2 multi-level cache manager (v0.4.0)
//
// L1 (in-process Map) — microsecond reads, TTL = session
// L2 (on-disk JSON)   — millisecond reads, TTL = 30 days
//
// Cache key: first 16 chars of sha256(figmaNodeId + contentHash + mode)
// Invalidation: lastModified version tag + TTL expiry + manual clear
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".smart-figma", "cache");
const L2_TTL = 30 * 86400000; // 30 days

export class CacheManager {
  constructor(cacheDir = DEFAULT_CACHE_DIR) {
    this.cacheDir = cacheDir;
    /** @type {Map<string, CacheEntry>} */
    this.l1 = new Map(); // L1: memory
    this.hits = { l1: 0, l2: 0, miss: 0 };
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // ── Key generation ──

  key(figmaNodeId, contentHash, mode = "flat", styleFormat = "tailwind") {
    const raw = `${figmaNodeId || "anon"}:${contentHash}:${mode}:${styleFormat}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }

  contentHash(node) {
    // Structural fingerprint: type + layoutMode + absoluteBoundingBox + child count.
    const children = Array.isArray(node.children) ? node.children : [];
    const box = node.absoluteBoundingBox || { x: node.x, y: node.y, width: node.width, height: node.height };
    const fingerprint = JSON.stringify({
      type: node.type,
      layoutMode: node.layoutMode,
      box,
      childCount: children.length,
      childTypes: children.map(c => c.type).join(","),
    });
    return createHash("sha256").update(fingerprint).digest("hex").slice(0, 12);
  }

  // ── Read / write ──

  get(nodeId, contentHash, mode, styleFormat) {
    const k = this.key(nodeId, contentHash, mode, styleFormat);

    // L1 hit
    if (this.l1.has(k)) {
      const entry = this.l1.get(k);
      if (Date.now() - entry.cachedAt < L2_TTL) {
        this.hits.l1++;
        return { ...entry, source: "L1_MEMORY" };
      }
      this.l1.delete(k); // expired
    }

    // L2 hit
    const diskPath = path.join(this.cacheDir, `${k}.json`);
    try {
      const raw = fs.readFileSync(diskPath, "utf8");
      const entry = JSON.parse(raw);
      if (Date.now() - entry.cachedAt < L2_TTL) {
        // Backfill L1
        this.l1.set(k, entry);
        this.hits.l2++;
        return { ...entry, source: "L2_DISK" };
      }
      // Expired -> clean up
      try { fs.unlinkSync(diskPath); } catch {}
    } catch { /* disk miss */ }

    this.hits.miss++;
    return null;
  }

  set(nodeId, contentHash, mode, styleFormat, value) {
    const k = this.key(nodeId, contentHash, mode, styleFormat);
    const entry = { ...value, cachedAt: Date.now(), nodeId, contentHash, mode, styleFormat };

    // L1
    this.l1.set(k, entry);

    // L2
    try {
      fs.writeFileSync(
        path.join(this.cacheDir, `${k}.json`),
        JSON.stringify(entry, null, 2)
      );
    } catch { /* a disk write failure must not break the main flow */ }
  }

  // ── Management ──

  clear() {
    this.l1.clear();
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const f of files) {
        if (f.endsWith(".json")) {
          fs.unlinkSync(path.join(this.cacheDir, f));
        }
      }
    } catch {}
    this.hits = { l1: 0, l2: 0, miss: 0 };
    return { cleared: true, dir: this.cacheDir };
  }

  stats() {
    return {
      l1Size: this.l1.size,
      l2Files: this._countL2Files(),
      hits: { ...this.hits },
      hitRatio: this._hitRatio(),
    };
  }

  // ── Internal ──

  _countL2Files() {
    try {
      return fs.readdirSync(this.cacheDir).filter(f => f.endsWith(".json")).length;
    } catch { return 0; }
  }

  _hitRatio() {
    const total = this.hits.l1 + this.hits.l2 + this.hits.miss;
    if (total === 0) return "0%";
    return `${Math.round((this.hits.l1 + this.hits.l2) / total * 100)}%`;
  }
}

// Optional global singleton.
let _globalCache = null;
export function getGlobalCache(dir) {
  if (!_globalCache) _globalCache = new CacheManager(dir);
  return _globalCache;
}
