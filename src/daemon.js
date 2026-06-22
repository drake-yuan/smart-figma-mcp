#!/usr/bin/env node
// daemon.js — Smart Figma resident daemon (v0.4.0)
//
// Communicates with the MCP server over a Unix domain socket, providing:
//   1. multi-level cache (L1 memory + L2 disk) — eliminates duplicate Figma API calls
//   2. silent prefetch/warm-up — pulls the whole layer tree in the background when a URL is pasted
//   3. compile cache — a repeated node compiles and returns in < 10ms
//
// Lifecycle:
//   - the main process spawns the daemon at startup
//   - the daemon auto-exits after 30 minutes idle
//   - the main process sends a shutdown notification on exit

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CacheManager } from "./cache.js";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOCKET_PATH = path.join(os.homedir(), ".smart-figma", "daemon.sock");
const IDLE_TIMEOUT = 30 * 60000; // 30 minutes

const cache = new CacheManager();

// ─── Logging ───
function log(...a) { process.stderr.write(`[smart-figma][daemon] ${a.join(" ")}\n`); }

// ─── Prefetch manager ───
const prefetchState = new Map(); // fileKey -> { status, progress }

async function handlePrefetch(params) {
  const { figmaUrl, token } = params;
  try {
    const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
    if (prefetchState.has(fileKey)) {
      return { status: "already_in_progress", fileKey };
    }

    prefetchState.set(fileKey, { status: "fetching", progress: 0 });

    log(`prefetch: ${fileKey} (${nodeId})`);

    // Dynamically import the Figma client (runs inside the daemon process).
    const { getNode, getFile } = await import("./figma-client.js");
    const { normalizeNode } = await import("./figma-normalizer.js");

    // Fetch file metadata first.
    const fileMeta = await getFile(fileKey, token);
    prefetchState.set(fileKey, { status: "fetching", progress: 30 });

    // Then fetch the specific node.
    const raw = await getNode(fileKey, nodeId, token);
    prefetchState.set(fileKey, { status: "fetching", progress: 80 });

    const normalized = normalizeNode(raw);

    // Cache the raw Figma response.
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
  if (!fileMatch) throw new Error("Could not extract fileKey from URL");
  const fileKey = fileMatch[1];
  const nodeMatch = url.match(/node-id=([^&]+)/);
  const nodeId = nodeMatch ? nodeMatch[1].replace(/-/g, ":") : null;
  return { fileKey, nodeId };
}

// ─── IPC message handling ───

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
      log("Received shutdown command, exiting...");
      return { ok: true };

    default:
      return { error: `Unknown method: ${method}` };
  }
}

// ─── Socket server ───

let server;
let idleTimer;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log("Idle timeout reached, exiting automatically");
    shutdown();
  }, IDLE_TIMEOUT);
}

function shutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  try { server.close(); } catch {}
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  log("daemon stopped");
  process.exit(0);
}

export function startDaemon(portPath = SOCKET_PATH) {
  // Remove a stale socket file.
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

// Standalone launch (`node src/daemon.js`).
if (process.argv[1] && process.argv[1].includes("daemon.js")) {
  startDaemon();
}
