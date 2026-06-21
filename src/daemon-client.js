// daemon-client.js — MCP 主进程连接到 Daemon 的 IPC 客户端 v0.4.0
//
// 通过 Unix Domain Socket 与 daemon 进程通信。
// 如果 daemon 不可达 → 自动降级为 DIRECT 模式（功能不受影响，体验降级）。
//
// API:
//   connectDaemon()  → 尝试连接，返回 client
//   client.prefetch(figmaUrl, token) → 预拉取 + 缓存
//   client.compileWithCache(params)  → 编译（优先走缓存）
//   client.cacheStats() → 缓存命中统计
//   client.shutdown()   → 通知 daemon 退出

import net from "node:net";
import path from "node:path";
import os from "node:os";
import { CacheManager } from "./cache.js";

const SOCKET_PATH = path.join(os.homedir(), ".smart-figma", "daemon.sock");
const CONNECT_TIMEOUT = 500; // ms，超时则降级

export class DaemonClient {
  constructor() {
    this.socket = null;
    this.mode = "DIRECT"; // DIRECT | DAEMON
    this.pending = new Map();
    this.idCounter = 0;
    this.buf = "";
    /** @type {CacheManager|null} */
    this.fallbackCache = null; // DIRECT 模式下的小型 L1 缓存
  }

  // ── 连接 ──

  async connect(socketPath = SOCKET_PATH) {
    return new Promise((resolve) => {
      this.socket = net.createConnection(socketPath);

      const fail = () => {
        this.socket.removeAllListeners();
        this.socket.destroy();
        this.socket = null;
        this.mode = "DIRECT";
        // 降级模式下初始化小型内存缓存
        if (!this.fallbackCache) this.fallbackCache = new CacheManager();
        resolve(false);
      };

      const timer = setTimeout(fail, CONNECT_TIMEOUT);

      this.socket.on("connect", () => {
        clearTimeout(timer);
        this.mode = "DAEMON";
        this.socket.on("data", (chunk) => this._onData(chunk));
        this.socket.on("close", () => {
          this.mode = "DIRECT";
          this.socket = null;
        });
        this.socket.on("error", () => {
          this.mode = "DIRECT";
          this.socket = null;
        });
        resolve(true);
      });

      this.socket.on("error", () => {
        clearTimeout(timer);
        fail();
      });
    });
  }

  _onData(chunk) {
    this.buf += chunk.toString();
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      } catch {}
    }
  }

  // ── 请求 ──

  _request(method, params, timeout = 10000) {
    const id = ++this.idCounter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      });

      this.socket.write(JSON.stringify({ type: "req", id, method, params }) + "\n");

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Daemon request timeout: ${method}`));
        }
      }, timeout);
    });
  }

  async _tryRequest(method, params) {
    if (this.mode !== "DAEMON" || !this.socket) return null;
    try {
      return await this._request(method, params);
    } catch {
      return null;
    }
  }

  // ── API ──

  /**
   * 预拉取 Figma URL → daemon 后台加载 + 缓存
   */
  async prefetch(figmaUrl, token) {
    return this._tryRequest("prefetch", { figmaUrl, token });
  }

  /**
   * 尝试从缓存获取编译结果
   * @returns {Object|null} 缓存命中时返回结果，否则 null
   */
  async getCached(nodeId, contentHash, mode, styleFormat) {
    const result = await this._tryRequest("cache_get", { nodeId, contentHash, mode, styleFormat });
    if (result) return result;
    // 降级模式备选
    if (this.fallbackCache) {
      return this.fallbackCache.get(nodeId, contentHash, mode, styleFormat);
    }
    return null;
  }

  /**
   * 缓存编译结果
   */
  async setCache(nodeId, contentHash, mode, styleFormat, value) {
    await this._tryRequest("cache_set", { nodeId, contentHash, mode, styleFormat, value });
    // 降级模式备选
    if (this.fallbackCache) {
      this.fallbackCache.set(nodeId, contentHash, mode, styleFormat, value);
    }
  }

  /**
   * 缓存统计
   */
  async cacheStats() {
    const stats = await this._tryRequest("cache_stats");
    if (stats) return stats;
    if (this.fallbackCache) return this.fallbackCache.stats();
    return null;
  }

  /**
   * 清除所有缓存
   */
  async cacheClear() {
    await this._tryRequest("cache_clear");
    if (this.fallbackCache) this.fallbackCache.clear();
  }

  /**
   * 通知 daemon 退出
   */
  async shutdown() {
    await this._tryRequest("shutdown");
    if (this.socket) {
      try { this.socket.end(); } catch {}
    }
    this.mode = "DIRECT";
    this.socket = null;
  }

  connected() {
    return this.mode === "DAEMON" && this.socket !== null;
  }
}

// 全局单例
let _client = null;
export function getDaemonClient() {
  if (!_client) _client = new DaemonClient();
  return _client;
}
