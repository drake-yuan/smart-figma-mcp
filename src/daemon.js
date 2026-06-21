#!/usr/bin/env node
// daemon.js — Smart Figma 常驻守护进程 v0.4.0
//
// 通过 Unix Domain Socket 与 MCP server 通信，提供：
//   1. 多级缓存（L1 内存 + L2 磁盘） — 消除重复 Figma API 调用
//   2. 静默预解析预热 — 用户粘贴 URL 时后台拉取整棵图层树
//   3. 编译缓存 — 相同节点二次编译 < 10ms 返回
//
// 生命周期：
//   - 主进程启动时 spawn daemon
//   - daemon 空闲 30 分钟后自动退出
//   - 主进程退出时发送 shutdown 通知

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CacheManager } from "./cache.js";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOCKET_PATH = path.join(os.homedir(), ".smart-figma", "daemon.sock");
const IDLE_TIMEOUT = 30 * 60000; // 30 分钟

const cache = new CacheManager();

// ─── 日志 ───
function log(...a) { process.stderr.write(`[smart-figma][daemon] ${a.join(" ")}\n`); }

// ─── 预拉取管理器 ───
const prefetchState = new Map(); // fileKey → { status, progress }

async function handlePrefetch(params) {
  const { figmaUrl, token } = params;
  try {
    const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
    if (prefetchState.has(fileKey)) {
      return { status: "already_in_progress", fileKey };
    }

    prefetchState.set(fileKey, { status: "fetching", progress: 0 });

    log(`prefetch: ${fileKey} (${nodeId})`);

    // 动态导入 Figma client（daemon 进程中运行）
    const { getNode, getFile } = await import("./figma-client.js");
    const { normalizeNode } = await import("./figma-normalizer.js");

    // 先拉文件元数据
    const fileMeta = await getFile(fileKey, token);
    prefetchState.set(fileKey, { status: "fetching", progress: 30 });

    // 再拉具体节点
    const raw = await getNode(fileKey, nodeId, token);
    prefetchState.set(fileKey, { status: "fetching", progress: 80 });

    const normalized = normalizeNode(raw);

    // 缓存原始 Figma 响应
    cache.set("figma_raw", `${fileKey}:${nodeId}`, "prefetch", "raw", {
      normalized,
      fileMeta: { name: fileMeta?.name, lastModified: fileMeta?.lastModified },
      prefetchedAt: Date.now(),
    });

    prefetchState.set(fileKey, { status: "done", progress: 100 });
    log(`prefetch done: ${fileKey}/${nodeId}`);
    return { status: "done", fileKey, nodeId };
  } catch (e) {
    prefetchState.set(figmaUrl, { status: "error", error: e.message });
    return { status: "error", error: e.message };
  }
}

function parseFigmaUrl(url) {
  const fileMatch = url.match(/\/(?:design|file)\/([a-zA-Z0-9]+)/);
  if (!fileMatch) throw new Error("无法从 URL 提取 fileKey");
  const fileKey = fileMatch[1];
  const nodeMatch = url.match(/node-id=([^&]+)/);
  const nodeId = nodeMatch ? nodeMatch[1].replace(/-/g, ":") : null;
  return { fileKey, nodeId };
}

// ─── IPC 消息处理 ───

async function dispatch(method, params) {
  switch (method) {
    case "ping":
      return { pong: true, uptime: process.uptime() };

    case "prefetch":
      return await handlePrefetch(params);

    case "cache_get":
      return cache.get(
        params.nodeId, params.contentHash, params.mode, params.styleFormat
      );

    case "cache_set":
      cache.set(
        params.nodeId, params.contentHash, params.mode, params.styleFormat, params.value
      );
      return { ok: true };

    case "cache_stats":
      return cache.stats();

    case "cache_clear":
      return cache.clear();

    case "prefetch_progress":
      return { progress: prefetchState.get(params.fileKey) || null };

    case "shutdown":
      log("收到 shutdown 指令，正在退出...");
      return { ok: true };

    default:
      return { error: `Unknown method: ${method}` };
  }
}

// ─── Socket 服务器 ───

let server;
let idleTimer;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log("空闲超时，自动退出");
    shutdown();
  }, IDLE_TIMEOUT);
}

function shutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  try { server.close(); } catch {}
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  log("daemon 已关闭");
  process.exit(0);
}

export function startDaemon(portPath = SOCKET_PATH) {
  // 清理旧 socket 文件
  try { fs.unlinkSync(portPath); } catch {}

  server = net.createServer((socket) => {
    log("client connected");
    let buf = "";

    socket.on("data", async (chunk) => {
      buf += chunk.toString();
      // newline-delimited JSON
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;

        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.type === "req") {
          resetIdleTimer();
          try {
            const result = await dispatch(msg.method, msg.params || {});
            socket.write(JSON.stringify({ type: "res", id: msg.id, result }) + "\n");
          } catch (e) {
            socket.write(JSON.stringify({ type: "res", id: msg.id, error: e.message }) + "\n");
          }
        }
      }
    });

    socket.on("close", () => log("client disconnected"));
  });

  server.listen(portPath, () => {
    log(`listening on ${portPath}`);
    resetIdleTimer();
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { server, cache };
}

// 独立启动（`node src/daemon.js`）
if (process.argv[1] && process.argv[1].includes("daemon.js")) {
  startDaemon();
}
