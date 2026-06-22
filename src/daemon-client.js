// daemon-client.js — IPC client that connects the MCP main process to the daemon (v0.4.0)
//
// Communicates with the daemon process over a Unix domain socket.
// If the daemon is unreachable, it automatically degrades to DIRECT mode
// (functionality is unaffected; only the experience degrades).
//
// API:
//   connectDaemon()  -> attempt connection, returns a client
//   client.prefetch(figmaUrl, token) -> prefetch + cache
//   client.compileWithCache(params)  -> compile (cache-first)
//   client.cacheStats() -> cache hit statistics
//   client.shutdown()   -> tell the daemon to exit

import net from "node:net";
import path from "node:path";
import os from "node:os";
import { CacheManager } from "./cache.js";

const SOCKET_PATH = path.join(os.homedir(), ".smart-figma", "daemon.sock");
const CONNECT_TIMEOUT = 500; // ms; degrade on timeout

export class DaemonClient {
  constructor() {
    this.socket = null;
    this.mode = "DIRECT"; // DIRECT | DAEMON
    this.pending = new Map();
    this.idCounter = 0;
    this.buf = "";
    /** @type {CacheManager|null} */
    this.fallbackCache = null; // small L1 cache used in DIRECT mode
  }

  // ── Connection ──

  async connect(socketPath = SOCKET_PATH) {
    return new Promise((resolve) => {
      this.socket = net.createConnection(socketPath);

      const fail = () => {
        this.socket.removeAllListeners();
        this.socket.destroy();
        this.socket = null;
        this.mode = "DIRECT";
        // Initialize a small in-memory cache in degraded mode.
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

  // ── Requests ──

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
   * Prefetch a Figma URL -> daemon loads + caches it in the background.
   */
  async prefetch(figmaUrl, token) {
    return this._tryRequest("prefetch", { figmaUrl, token });
  }

  /**
   * Try to read a compiled result from the cache.
   * @returns {Object|null} the result on a cache hit, otherwise null
   */
  async getCached(nodeId, contentHash, mode, styleFormat) {
    const result = await this._tryRequest("cache_get", { nodeId, contentHash, mode, styleFormat });
    if (result) return result;
    // Degraded-mode fallback.
    if (this.fallbackCache) {
      return this.fallbackCache.get(nodeId, contentHash, mode, styleFormat);
    }
    return null;
  }

  /**
   * Cache a compiled result.
   */
  async setCache(nodeId, contentHash, mode, styleFormat, value) {
    await this._tryRequest("cache_set", { nodeId, contentHash, mode, styleFormat, value });
    // Degraded-mode fallback.
    if (this.fallbackCache) {
      this.fallbackCache.set(nodeId, contentHash, mode, styleFormat, value);
    }
  }

  /**
   * Cache statistics.
   */
  async cacheStats() {
    const stats = await this._tryRequest("cache_stats");
    if (stats) return stats;
    if (this.fallbackCache) return this.fallbackCache.stats();
    return null;
  }

  /**
   * Clear all caches.
   */
  async cacheClear() {
    await this._tryRequest("cache_clear");
    if (this.fallbackCache) this.fallbackCache.clear();
  }

  /**
   * Tell the daemon to exit.
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

// Global singleton.
let _client = null;
export function getDaemonClient() {
  if (!_client) _client = new DaemonClient();
  return _client;
}
