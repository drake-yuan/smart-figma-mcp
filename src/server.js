#!/usr/bin/env node
// server.js — Smart Figma-to-Code MCP Server (v0.2.0 Figma API + 协议完善)
//
// 协议：MCP = JSON-RPC 2.0 over stdio，消息按换行分隔(newline-delimited)。
// 零外部依赖：纯 Node 实现 initialize / tools/list / tools/call / ping / health。
//
// 调用门禁顺序（每次 tools/call 都跑一遍，全程本地、毫秒级）：
//   1) 离线 license 验签(license.js)  → 失败直接拒
//   2) BYOK 解析(byok.js)            → 自带 key 则 token 走用户账单
//   3) 复杂度分析(compiler.js)        → 决定 PURE_DIGITAL / SEMANTIC / VISUAL
//   4) 配额扣减(quota.js)            → 非 BYOK 时按 credits 扣，服务端权威
//   5) 编译 + variant 映射            → 产出装配上下文

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { verifyLicenseOffline, deviceFingerprint, DEMO_PUBLIC_KEY_PEM } from "./license.js";
import { resolveLLMConfig } from "./byok.js";
import {
  compileFigmaLayout,
  compileCoordinateFlow,
  compileRecursive,
  formatOutput,
  FORMAT_LIST,
  analyzeComplexity,
  visualizeComplexity,
  detectResponsiveBreakpoints,
} from "./compiler.js";
import { debit, CREDIT_COST } from "./quota.js";
import { mapToVariant, rememberMapping, lookupMapping } from "./mapping.js";
import { getNode as figmaGetNode, getFile as figmaGetFile } from "./figma-client.js";
import { normalizeNode, normalizeFileMeta } from "./figma-normalizer.js";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { getDaemonClient } from "./daemon-client.js";
import { CacheManager } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── 日志分级 ───
const LOG_LEVEL_MAP = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVEL_MAP[process.env.LOG_LEVEL] ?? LOG_LEVEL_MAP.info;
function xlog(level, ...a) {
  if ((LOG_LEVEL_MAP[level] ?? 99) <= CURRENT_LOG_LEVEL) {
    process.stderr.write(`[smart-figma][${level}] ${a.join(" ")}\n`);
  }
}
const log = (...a) => xlog("info", ...a);

// ─── 版本号：从 package.json 读取 ───
let SERVER_VERSION = "0.0.0";
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  SERVER_VERSION = pkg.version;
} catch { xlog("warn", "无法读取 package.json，使用默认版本号"); }

// ─── 公钥加载 ───
function resolvePublicKey() {
  if (process.env.SMART_FIGMA_PUBLIC_KEY) return process.env.SMART_FIGMA_PUBLIC_KEY;
  try { return fs.readFileSync(path.join(__dirname, "..", "keys", "public.pem"), "utf8"); }
  catch { return DEMO_PUBLIC_KEY_PEM; }
}
const PUBLIC_KEY = resolvePublicKey();

// ─── 标准 JSON-RPC 错误码 ───
const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NOT_INITIALIZED: -32002,
};

// ─── 初始化状态机 ───
let _initialized = false;

// ─── Daemon 连接 ───
let daemon = null;
let daemonProcess = null;

async function initDaemon() {
  daemon = getDaemonClient();
  const connected = await daemon.connect();
  if (connected) {
    xlog("info", `daemon connected (${daemon.mode} mode)`);
  } else {
    // 尝试 spawn daemon 子进程
    xlog("info", "daemon not running, spawning...");
    try {
      const daemonPath = path.join(__dirname, "daemon.js");
      daemonProcess = spawn("node", [daemonPath], {
        stdio: ["ignore", "ignore", "inherit"],
        detached: false,
      });
      daemonProcess.on("error", () => { daemonProcess = null; });
      // 等 300ms 后重试连接
      await new Promise(r => setTimeout(r, 300));
      await daemon.connect();
      if (daemon.connected()) {
        xlog("info", `daemon spawned + connected (${daemon.mode} mode)`);
      } else {
        xlog("warn", "daemon still unavailable, running in DIRECT mode");
      }
    } catch (e) {
      xlog("warn", `daemon spawn failed: ${e.message}, running in DIRECT mode`);
    }
  }
}

// ─── 门禁：license + BYOK ───
function gate() {
  const token = process.env.SMART_FIGMA_LICENSE || "";
  const fp = deviceFingerprint();
  const lic = verifyLicenseOffline(token, PUBLIC_KEY, fp);
  const llm = resolveLLMConfig();
  return { lic, llm, fp };
}

// ─── 工具实现 ───
async function toolCompile(args) {
  const { lic, llm } = gate();
  if (!lic.ok) {
    return errContent(`License 校验失败：${lic.reason}。请检查 SMART_FIGMA_LICENSE。`);
  }

  // 支持两种输入：离线 figmaNode JSON，或 figmaUrl + figmaToken（真联 Figma API）
  let node = args.figmaNode;
  if (!node && args.figmaUrl) {
    xlog("debug", "figmaUrl detected, fetching from Figma API ...");
    const token = args.figmaToken || process.env.FIGMA_ACCESS_TOKEN;
    if (!token) return errContent("figmaUrl 模式需要 FIGMA_ACCESS_TOKEN 或传入 figmaToken。");
    try {
      const { fileKey, nodeId } = parseFigmaUrl(args.figmaUrl);
      const fetched = await figmaGetNode(fileKey, nodeId, token);
      if (!fetched) return errContent("Figma API 返回空数据。");
      node = normalizeNode(fetched);
    } catch (e) {
      return errContent(`Figma API 获取失败：${e.message}`);
    }
  }
  if (!node) return errContent("缺少 figmaNode（请传入节点 JSON 或 figmaUrl）。");

  const complexity = analyzeComplexity(node);
  const styleFormat = args.styleFormat || "tailwind";

  if (complexity.level === "COMPLEX") {
    return okContent(JSON.stringify({
      action: "SUGGEST_AUTOLAYOUT",
      reason: "未使用 Auto Layout / 绝对定位过多，硬转会产出灾难代码",
      message: "检测到此设计稿未使用 Auto Layout。建议在 Figma 端一键转换为 Auto Layout 后重试，" +
        "可大幅提升还原精度（详见 figma_auto_layoutify 引导）。",
      complexity,
      complexityReport: visualizeComplexity(complexity),
    }, null, 2));
  }

  const charge = debit({
    sub: lic.payload.sub,
    quota: lic.payload.quota,
    strategy: complexity.strategy,
    byok: llm.byok,
  });
  if (!charge.ok) {
    return errContent(`配额不足：${charge.reason}（本次需 ${charge.cost} credits）。`);
  }

  // 编译：根据策略选不同路径
  let tailwind, coordinateFlow, recursiveTree;
  const mode = args.mode || "flat";

  // ── 缓存检查（跳过配额扣减的开销）──
  const nodeId = node.id || node.name || "anon";
  const contentHash = daemon?.fallbackCache
    ? daemon.fallbackCache.contentHash(node)
    : new CacheManager().contentHash(node);
  const cached = (daemon && !args.siblings) ? await daemon.getCached(nodeId, contentHash, mode, styleFormat) : null;
  if (cached) {
    return okContent(JSON.stringify(cached.result, null, 2));
  }

  if (mode === "recursive") {
    // 递归编译整棵子树
    recursiveTree = compileRecursive(node);
    tailwind = recursiveTree.tailwind || "";
  } else if (complexity.level === "MODERATE") {
    // 中等复杂度：坐标流推断 + 纯数字编译
    coordinateFlow = compileCoordinateFlow(node);
    tailwind = coordinateFlow.tailwind;
  } else {
    // SIMPLE：纯 Auto Layout 编译
    tailwind = compileFigmaLayout(node);
  }

  // 响应式检测
  let responsive = null;
  if (args.siblings && Array.isArray(args.siblings)) {
    responsive = detectResponsiveBreakpoints(args.siblings);
  }

  let mapping = null;
  if (node.componentKey && args.projectRoot) {
    const remembered = lookupMapping(args.projectRoot, node.componentKey);
    if (remembered) mapping = { ...remembered.target, confidence: 1, source: "asset_library" };
    else if (args.localComponent && node.componentProperties) {
      mapping = mapToVariant(node.componentProperties, args.localComponent);
    }
  }

  // 按指定格式输出
  const formattedOutput = formatOutput(tailwind, styleFormat);

  const assembly = buildAssemblyPrompt({ node, tailwind: formattedOutput, mapping, complexity, styleFormat });

  // 续期提醒
  let renewNotice = null;
  if (lic.payload.exp && lic.payload.exp - Date.now() < 7 * 86400000) {
    renewNotice = {
      action: "RENEW_NEEDED",
      daysLeft: Math.ceil((lic.payload.exp - Date.now()) / 86400000),
      message: `您的订阅将在 ${Math.ceil((lic.payload.exp - Date.now()) / 86400000)} 天后到期。`,
    };
  }

  const result = {
    billing: llm.byok
      ? { mode: "BYOK", provider: llm.provider, note: "token 走用户账单，我方零变动成本" }
      : { mode: "CREDITS", charged: charge.cost, remaining: charge.remaining },
    strategy: complexity.strategy,
    complexityReport: visualizeComplexity(complexity),
    tailwind,
    formattedOutput,
    styleFormat,
    mapping,
    assemblyPrompt: assembly,
    ...(coordinateFlow && { coordinateFlow }),
    ...(recursiveTree && { recursiveTree }),
    ...(responsive && { responsive }),
    ...(renewNotice && { renewNotice }),
  };

  // ── 缓存写入 ──
  if (daemon) {
    daemon.setCache(nodeId, contentHash, mode, styleFormat, { result }).catch(() => {});
  }

  return okContent(JSON.stringify(result, null, 2));
}

async function toolFetchFigma(args) {
  const { lic, llm } = gate();
  if (!lic.ok) return errContent(`License 校验失败：${lic.reason}`);

  const { figmaUrl, action = "node" } = args;
  if (!figmaUrl) return errContent("缺少 figmaUrl。");

  const token = args.figmaToken || process.env.FIGMA_ACCESS_TOKEN;
  if (!token) return errContent("需要 FIGMA_ACCESS_TOKEN 环境变量。");

  try {
    const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);

    if (action === "file_meta") {
      const meta = await figmaGetFile(fileKey, token);
      const normalized = normalizeFileMeta(meta);
      return okContent(JSON.stringify(normalized, null, 2));
    }

    // action === "node" (default)
    const fetched = await figmaGetNode(fileKey, nodeId, token);
    if (!fetched) return errContent(`节点 ${nodeId} 未找到。`);
    const normalized = normalizeNode(fetched);
    return okContent(JSON.stringify(normalized, null, 2));
  } catch (e) {
    return errContent(`Figma API 失败：${e.message}`);
  }
}

function parseFigmaUrl(url) {
  // 格式: https://www.figma.com/design/:fileKey/...?node-id=:nodeId
  // 或: https://www.figma.com/file/:fileKey/...?node-id=:nodeId
  const fileMatch = url.match(/\/(?:design|file)\/([a-zA-Z0-9]+)/);
  if (!fileMatch) throw new Error("无法从 URL 提取 fileKey，格式应为 https://www.figma.com/design/FILEKEY/...?node-id=NODEID");
  const fileKey = fileMatch[1];

  const nodeMatch = url.match(/node-id=([^&]+)/);
  const nodeId = nodeMatch ? nodeMatch[1].replace(/-/g, ":") : null;

  if (!nodeId) throw new Error("无法从 URL 提取 node-id，链接中需要包含 ?node-id=xxx 参数");

  return { fileKey, nodeId };
}

function buildAssemblyPrompt({ node, tailwind, mapping, complexity, styleFormat }) {
  const styleLabel = styleFormat === "tailwind" ? "Tailwind" :
    styleFormat === "css-modules" ? "CSS Modules" :
    styleFormat === "scss" ? "SCSS" : "Styled Components";
  const lines = [
    `【几何骨架 — 禁止猜测物理数值，策略：${complexity.strategy}，输出格式：${styleLabel}】`,
    `容器布局（${styleFormat}）：${tailwind || "(无 Auto Layout)"}`,
  ];
  if (mapping) {
    lines.push(
      `强制复用本地组件：${mapping.component}（import from '${mapping.importPath}'）`,
      `精确 props：${JSON.stringify(mapping.props)}（映射置信度 ${mapping.confidence}）`,
      `⛔ 禁止重新造该组件，必须 import 复用。`
    );
  }
  return lines.join("\n");
}

function toolSave(args) {
  const { lic } = gate();
  if (!lic.ok) return errContent(`License 校验失败：${lic.reason}`);

  const { code, componentName, projectRoot, featureDir = "components/generated" } = args;
  if (!code || !componentName || !projectRoot) {
    return errContent("缺少 code / componentName / projectRoot。");
  }
  const cleaned = sanitizeCode(code);
  const dir = path.join(projectRoot, "src", featureDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${componentName}.tsx`);
  fs.writeFileSync(file, cleaned);
  updateBarrel(dir, componentName);

  return okContent(JSON.stringify({ saved: file, exportUpdated: true, note: "已物理清洗 data-node-id 并更新 index.ts" }, null, 2));
}

function toolRemember(args) {
  const { lic } = gate();
  if (!lic.ok) return errContent(`License 校验失败：${lic.reason}`);
  const { projectRoot, figmaComponentKey, figmaName, target } = args;
  if (!projectRoot || !figmaComponentKey || !target) {
    return errContent("缺少 projectRoot / figmaComponentKey / target。");
  }
  const count = rememberMapping(projectRoot, { figmaComponentKey, figmaName, target });
  return okContent(`已沉淀映射资产（共 ${count} 条）。该资产绑定本工具，构成切换成本护城河。`);
}

function toolCacheClear() {
  const { lic } = gate();
  if (!lic.ok) return errContent(`License 校验失败：${lic.reason}`);
  try {
    if (daemon) {
      return daemon.cacheClear().then((result) =>
        okContent(JSON.stringify(result || { cleared: true }, null, 2))
      );
    }
    return okContent(JSON.stringify({ cleared: true, note: "无 daemon，无可清除缓存" }, null, 2));
  } catch (e) {
    return errContent(`缓存清除失败：${e.message}`);
  }
}

function sanitizeCode(raw) {
  return raw
    .replace(/\sdata-node-id="[^"]*"/g, "")
    .replace(/\sdata-name="[^"]*"/g, "")
    .replace(/[ \t]{2,}/g, " ");
}

function updateBarrel(dir, componentName) {
  const indexPath = path.join(dir, "index.ts");
  const line = `export { default as ${componentName} } from "./${componentName}";\n`;
  let content = "";
  try { content = fs.readFileSync(indexPath, "utf8"); } catch {}
  if (!content.includes(line)) fs.appendFileSync(indexPath, line);
}

// ─── MCP 工具清单 ───
const TOOLS = [
  {
    name: "compile_figma_component",
    description: "编译 Figma 节点为 Tailwind + variant 映射上下文。支持离线 figmaNode JSON 或 figmaUrl（真联 Figma API）。BYOK 模式 token 走用户账单。",
    inputSchema: {
      type: "object",
      properties: {
        figmaNode: { type: "object", description: "Figma 导出的节点 JSON（离线传入，与 figmaUrl 二选一）" },
        figmaUrl: { type: "string", description: "Figma 设计稿链接（https://www.figma.com/design/FILEKEY/...?node-id=NODEID，与 figmaNode 二选一）" },
        figmaToken: { type: "string", description: "Figma Personal Access Token（优先级高于环境变量 FIGMA_ACCESS_TOKEN）" },
        projectRoot: { type: "string", description: "用户项目根目录" },
        localComponent: { type: "object", description: "本地组件元信息(name/importPath/variants)" },
        styleFormat: { type: "string", enum: FORMAT_LIST, description: "输出样式格式：tailwind/css-modules/scss/styled-components（默认 tailwind）" },
        mode: { type: "string", enum: ["flat", "recursive"], description: "编译模式：flat 仅编译外层容器，recursive 递归编译整棵子树（默认 flat）" },
        siblings: { type: "array", description: "兄弟节点列表，用于检测响应式断点" },
      },
    },
  },
  {
    name: "fetch_figma_node",
    description: "从 Figma API 拉取设计节点并规范化为编译器输入格式。返回结构化的节点数据（含 Auto Layout 信息）。",
    inputSchema: {
      type: "object",
      properties: {
        figmaUrl: { type: "string", description: "Figma 设计稿链接" },
        figmaToken: { type: "string", description: "Figma Access Token（可选，默认用环境变量 FIGMA_ACCESS_TOKEN）" },
        action: { type: "string", enum: ["node", "file_meta"], description: "拉取节点详情(node)或文件元数据(file_meta)" },
      },
      required: ["figmaUrl"],
    },
  },
  {
    name: "save_component",
    description: "确定性写操作：清洗 data-node-id、精确落盘、自动更新 index.ts barrel 导出。",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        componentName: { type: "string" },
        projectRoot: { type: "string" },
        featureDir: { type: "string" },
      },
      required: ["code", "componentName", "projectRoot"],
    },
  },
  {
    name: "remember_mapping",
    description: "把用户确认过的 Figma→本地组件映射沉淀为私有资产，形成切换成本护城河。",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        figmaComponentKey: { type: "string" },
        figmaName: { type: "string" },
        target: { type: "object" },
      },
      required: ["projectRoot", "figmaComponentKey", "target"],
    },
  },
  {
    name: "cache_clear",
    description: "清除所有编译缓存（L1 内存 + L2 磁盘），用于数据源变更后强制刷新。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

async function dispatchTool(name, args) {
  switch (name) {
    case "compile_figma_component":
      return await toolCompile(args || {});
    case "fetch_figma_node":
      return await toolFetchFigma(args || {});
    case "save_component":
      return toolSave(args || {});
    case "remember_mapping":
      return toolRemember(args || {});
    case "cache_clear":
      return toolCacheClear();
    default:
      throw Object.assign(new Error(`Tool not found: ${name}`), { code: ERROR_CODES.METHOD_NOT_FOUND });
  }
}

// ─── JSON-RPC over stdio ───
function okContent(text) {
  return { content: [{ type: "text", text }] };
}
function errContent(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(req) {
  const { id, method, params } = req;

  // 通知(无 id)处理
  if (id === undefined || id === null) {
    if (method === "notifications/initialized") {
      xlog("debug", "client sent notifications/initialized");
    }
    return;
  }

  try {
    // ── initialize（不需要 pre-init 检查） ──
    if (method === "initialize") {
      _initialized = true;
      // 后台异步初始化 daemon（不阻塞 initialize 响应）
      initDaemon().catch(e => xlog("warn", `daemon init error: ${e.message}`));
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "smart-figma-mcp", version: SERVER_VERSION },
      }});
    }

    // ── ping（无需初始化） ──
    if (method === "ping") {
      return send({ jsonrpc: "2.0", id, result: {} });
    }

    // ── health（无需初始化，用于诊断） ──
    if (method === "health") {
      const g = gate();
      let cacheStats = null;
      if (daemon) {
        try { cacheStats = await daemon.cacheStats(); } catch {}
      }
      return send({ jsonrpc: "2.0", id, result: {
        status: "ok",
        uptime: process.uptime(),
        license_valid: g.lic.ok,
        byok_enabled: g.llm.byok,
        daemon_mode: daemon?.mode || "DIRECT",
        cache: cacheStats?.hits || null,
        node_version: process.version,
        version: SERVER_VERSION,
      }});
    }

    // ── 初始化后门禁 ──
    if (!_initialized) {
      return send(rpcError(id, ERROR_CODES.NOT_INITIALIZED, "Server not initialized. Send initialize first."));
    }

    if (method === "tools/list") {
      return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }

    if (method === "tools/call") {
      if (!params?.name) {
        return send(rpcError(id, ERROR_CODES.INVALID_PARAMS, "Missing tool name in params.name"));
      }
      const result = await dispatchTool(params.name, params.arguments);
      return send({ jsonrpc: "2.0", id, result });
    }

    return send(rpcError(id, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`));
  } catch (e) {
    const code = (e.code && typeof e.code === "number") ? e.code : ERROR_CODES.INTERNAL_ERROR;
    return send(rpcError(id, code, e.message));
  }
}

// ─── stdio transport ───
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    // JSON 解析失败 → 标准错误码（无法获取 id，用 null）
    send({ jsonrpc: "2.0", id: null, error: { code: ERROR_CODES.PARSE_ERROR, message: "Parse error" } });
    return;
  }
  // 空字符串 id 视为 null（通知）
  if (req.id === "") req.id = null;
  handle(req);
});

// ─── 优雅退出 ───
function gracefulShutdown(signal) {
  xlog("warn", `收到 ${signal}，正在关闭...`);
  try { rl.close(); } catch {}
  // 清理临时缓存文件
  const cacheDir = path.join(os.homedir(), ".smart-figma", "cache");
  const tmpPattern = /\.tmp\./;
  try {
    const files = fs.readdirSync(cacheDir, { withFileTypes: true });
    for (const f of files) {
      if (f.isFile() && tmpPattern.test(f.name)) {
        fs.unlinkSync(path.join(cacheDir, f.name));
      }
    }
  } catch {}
  // 通知 daemon 退出
  if (daemon && daemon.connected()) {
    daemon.shutdown().catch(() => {});
  }
  xlog("info", "server 已关闭。");
  process.exit(0);
}
import os from "node:os";
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

log(`server up (stdio) v${SERVER_VERSION}. LOG_LEVEL=${process.env.LOG_LEVEL || "info"}. CREDIT_COST=${JSON.stringify(CREDIT_COST)}`);
