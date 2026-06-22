#!/usr/bin/env node
// server.js — Smart Figma-to-Code MCP Server (v0.2.0: Figma API + protocol hardening)
//
// Protocol: MCP = JSON-RPC 2.0 over stdio, messages are newline-delimited.
// Zero external dependencies: pure Node implementation of initialize / tools/list /
// tools/call / ping / health.
//
// Gate order (run on every tools/call, fully local and sub-millisecond):
//   1) offline license verification (license.js)  -> reject outright on failure
//   2) BYOK resolution (byok.js)                   -> with own key, token bills the user
//   3) complexity analysis (compiler.js)           -> choose PURE_DIGITAL / SEMANTIC / VISUAL
//   4) quota deduction (quota.js)                  -> non-BYOK deducts credits, server-authoritative
//   5) compile + variant mapping                   -> produce assembly context

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { verifyLicenseOffline, deviceFingerprint, DEMO_PUBLIC_KEY_PEM } from "./license.js";
import { resolveLLMConfig, probeKey, securityWarning } from "./byok.js";
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
import { debit, CREDIT_COST, quotaStatus, freeTierDebit, FREE_TIER_DAILY_LIMIT } from "./quota.js";
import { mapToVariant, rememberMapping, lookupMapping, scanLocalComponents, checkMappingHealth, exportMappings, importMappings, loadAliases, resolveMapping } from "./mapping.js";
import { getNode as figmaGetNode, getFile as figmaGetFile } from "./figma-client.js";
import { normalizeNode, normalizeFileMeta } from "./figma-normalizer.js";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { getDaemonClient } from "./daemon-client.js";
import { CacheManager } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Leveled logging ───
const LOG_LEVEL_MAP = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVEL_MAP[process.env.LOG_LEVEL] ?? LOG_LEVEL_MAP.info;
function xlog(level, ...a) {
  if ((LOG_LEVEL_MAP[level] ?? 99) <= CURRENT_LOG_LEVEL) {
    process.stderr.write(`[smart-figma][${level}] ${a.join(" ")}\n`);
  }
}
const log = (...a) => xlog("info", ...a);

// ─── Version: read from package.json ───
let SERVER_VERSION = "0.0.0";
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  SERVER_VERSION = pkg.version;
} catch { xlog("warn", "Could not read package.json; using default version."); }

// ─── Public key loading ───
function resolvePublicKey() {
  if (process.env.SMART_FIGMA_PUBLIC_KEY) return process.env.SMART_FIGMA_PUBLIC_KEY;
  try { return fs.readFileSync(path.join(__dirname, "..", "keys", "public.pem"), "utf8"); }
  catch { return DEMO_PUBLIC_KEY_PEM; }
}
const PUBLIC_KEY = resolvePublicKey();

// ─── Standard JSON-RPC error codes ───
const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NOT_INITIALIZED: -32002,
};

// ─── Initialization state machine ───
let _initialized = false;

// ─── Daemon connection ───
let daemon = null;
let daemonProcess = null;

async function initDaemon() {
  daemon = getDaemonClient();
  const connected = await daemon.connect();
  if (connected) {
    xlog("info", `daemon connected (${daemon.mode} mode)`);
  } else {
    // Try to spawn the daemon child process.
    xlog("info", "daemon not running, spawning...");
    try {
      const daemonPath = path.join(__dirname, "daemon.js");
      daemonProcess = spawn("node", [daemonPath], {
        stdio: ["ignore", "ignore", "inherit"],
        detached: false,
      });
      daemonProcess.on("error", () => { daemonProcess = null; });
      // Retry the connection after 300ms.
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

// ─── Gate: license + BYOK ───
function gate() {
  const token = process.env.SMART_FIGMA_LICENSE || "";
  const fp = deviceFingerprint();
  const lic = verifyLicenseOffline(token, PUBLIC_KEY, fp);
  const llm = resolveLLMConfig();
  // Renewal reminder: warn on every call within 7 days of expiry.
  let renewal = null;
  if (lic.ok && lic.renewal) {
    renewal = lic.renewal;
    xlog("warn", `License expires in ${renewal.daysLeft} day(s); please renew.`);
  }
  // Security reminder: BYOK key passed in plaintext.
  const secWarn = securityWarning(llm);
  if (secWarn) xlog("warn", secWarn);
  return { lic, llm, fp, renewal };
}

// ─── Tool implementations ───
async function toolCompile(args) {
  const { lic, llm } = gate();
  // No license -> do not hard-reject; degrade to the free tier (Hacker): pure-digital
  // compile only + daily cap. This makes the tool usable right after `npm install`,
  // which is the lifeblood of organic growth.
  const freeTier = !lic.ok;

  // Two input modes: an offline figmaNode JSON, or figmaUrl + figmaToken (live Figma API).
  let node = args.figmaNode;
  if (!node && args.figmaUrl) {
    xlog("debug", "figmaUrl detected, fetching from Figma API ...");
    const token = args.figmaToken || process.env.FIGMA_ACCESS_TOKEN;
    if (!token) return errContent("figmaUrl mode requires FIGMA_ACCESS_TOKEN or a figmaToken argument.");
    try {
      const { fileKey, nodeId } = parseFigmaUrl(args.figmaUrl);
      const fetched = await figmaGetNode(fileKey, nodeId, token);
      if (!fetched) return errContent("Figma API returned empty data.");
      node = normalizeNode(fetched);
    } catch (e) {
      return errContent(`Figma API fetch failed: ${e.message}`);
    }
  }
  if (!node) return errContent("Missing figmaNode (pass a node JSON or a figmaUrl).");

  const complexity = analyzeComplexity(node);
  const styleFormat = args.styleFormat || "tailwind";

  if (complexity.level === "COMPLEX") {
    return okContent(JSON.stringify({
      action: "SUGGEST_AUTOLAYOUT",
      reason: "No Auto Layout / too much absolute positioning; a forced conversion would produce disastrous code.",
      message: "This design does not use Auto Layout. Convert it to Auto Layout in Figma (one click) and retry " +
        "for much higher fidelity (see the figma_auto_layoutify plugin).",
      complexity,
      complexityReport: visualizeComplexity(complexity),
    }, null, 2));
  }

  const charge = freeTier
    ? freeTierDebit(complexity.strategy)
    : await debit({
        sub: lic.payload.sub,
        quota: lic.payload.quota,
        strategy: complexity.strategy,
        byok: llm.byok,
      });
  if (!charge.ok) {
    if (freeTier && charge.reason === "free_tier_pure_digital_only") {
      return errContent(
        `The free tier supports pure-digital compile of clean Auto Layout designs only. This design needs a higher tier (${complexity.strategy}). ` +
        `Set SMART_FIGMA_LICENSE to unlock the Maker/Pro tiers (BYOK pays your own tokens; we take zero cut).`
      );
    }
    if (freeTier && charge.reason === "free_tier_daily_exceeded") {
      return errContent(
        `Free tier daily limit of ${charge.limit} reached (resets next UTC day). ` +
        `Set SMART_FIGMA_LICENSE to unlock unlimited calls + local component variant mapping.`
      );
    }
    return errContent(`Quota exceeded: ${charge.reason} (this call needs ${charge.cost ?? "?"} credits).`);
  }

  // Compile: pick a path based on the strategy.
  let tailwind, coordinateFlow, recursiveTree;
  const mode = args.mode || "flat";

  // ── Cache check (skips the quota-deduction overhead) ──
  const nodeId = node.id || node.name || "anon";
  const contentHash = daemon?.fallbackCache
    ? daemon.fallbackCache.contentHash(node)
    : new CacheManager().contentHash(node);
  const cached = (daemon && !args.siblings) ? await daemon.getCached(nodeId, contentHash, mode, styleFormat) : null;
  if (cached) {
    return okContent(JSON.stringify(cached.result, null, 2));
  }

  if (mode === "recursive") {
    // Recursively compile the whole subtree.
    recursiveTree = compileRecursive(node);
    tailwind = recursiveTree.tailwind || "";
  } else if (complexity.level === "MODERATE") {
    // Moderate complexity: coordinate-flow inference + pure-digital compile.
    coordinateFlow = compileCoordinateFlow(node);
    tailwind = coordinateFlow.tailwind;
  } else {
    // SIMPLE: pure Auto Layout compile.
    tailwind = compileFigmaLayout(node);
  }

  // Responsive detection.
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

  // Output in the requested format.
  const formattedOutput = formatOutput(tailwind, styleFormat);

  const assembly = buildAssemblyPrompt({ node, tailwind: formattedOutput, mapping, complexity, styleFormat });

  // Renewal reminder.
  let renewNotice = null;
  if (!freeTier && lic.payload.exp && lic.payload.exp - Date.now() < 7 * 86400000) {
    renewNotice = {
      action: "RENEW_NEEDED",
      daysLeft: Math.ceil((lic.payload.exp - Date.now()) / 86400000),
      message: `Your subscription expires in ${Math.ceil((lic.payload.exp - Date.now()) / 86400000)} day(s).`,
    };
  }

  const result = {
    billing: freeTier
      ? { mode: "FREE", remaining: charge.remaining, dailyLimit: charge.limit,
          note: `Free tier: pure-digital compile only, ${charge.remaining}/${charge.limit} left today. Set SMART_FIGMA_LICENSE to unlock more.` }
      : llm.byok
      ? { mode: "BYOK", provider: llm.provider, note: "token bills the user; our variable cost is zero" }
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

  // ── Cache write ──
  if (daemon) {
    daemon.setCache(nodeId, contentHash, mode, styleFormat, { result }).catch(() => {});
  }

  return okContent(JSON.stringify(result, null, 2));
}

async function toolFetchFigma(args) {
  const { lic, llm } = gate();
  if (!lic.ok) return errContent(`License verification failed: ${lic.reason}`);

  const { figmaUrl, action = "node" } = args;
  if (!figmaUrl) return errContent("Missing figmaUrl.");

  const token = args.figmaToken || process.env.FIGMA_ACCESS_TOKEN;
  if (!token) return errContent("FIGMA_ACCESS_TOKEN environment variable is required.");

  try {
    const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);

    if (action === "file_meta") {
      const meta = await figmaGetFile(fileKey, token);
      const normalized = normalizeFileMeta(meta);
      return okContent(JSON.stringify(normalized, null, 2));
    }

    // action === "node" (default)
    const fetched = await figmaGetNode(fileKey, nodeId, token);
    if (!fetched) return errContent(`Node ${nodeId} not found.`);
    const normalized = normalizeNode(fetched);
    return okContent(JSON.stringify(normalized, null, 2));
  } catch (e) {
    return errContent(`Figma API failed: ${e.message}`);
  }
}

function parseFigmaUrl(url) {
  // Format: https://www.figma.com/design/:fileKey/...?node-id=:nodeId
  // or:     https://www.figma.com/file/:fileKey/...?node-id=:nodeId
  const fileMatch = url.match(/\/(?:design|file)\/([a-zA-Z0-9]+)/);
  if (!fileMatch) throw new Error("Could not extract fileKey from URL; expected https://www.figma.com/design/FILEKEY/...?node-id=NODEID");
  const fileKey = fileMatch[1];

  const nodeMatch = url.match(/node-id=([^&]+)/);
  const nodeId = nodeMatch ? nodeMatch[1].replace(/-/g, ":") : null;

  if (!nodeId) throw new Error("Could not extract node-id from URL; the link must include a ?node-id=xxx parameter");

  return { fileKey, nodeId };
}

function buildAssemblyPrompt({ node, tailwind, mapping, complexity, styleFormat }) {
  const styleLabel = styleFormat === "tailwind" ? "Tailwind" :
    styleFormat === "css-modules" ? "CSS Modules" :
    styleFormat === "scss" ? "SCSS" : "Styled Components";
  const lines = [
    `[Geometry skeleton — do NOT guess physical values. Strategy: ${complexity.strategy}, output format: ${styleLabel}]`,
    `Container layout (${styleFormat}): ${tailwind || "(no Auto Layout)"}`,
  ];
  if (mapping) {
    lines.push(
      `Reuse the local component: ${mapping.component} (import from '${mapping.importPath}')`,
      `Exact props: ${JSON.stringify(mapping.props)} (mapping confidence ${mapping.confidence})`,
      `⛔ Do NOT recreate this component; you MUST import and reuse it.`
    );
  }
  return lines.join("\n");
}

function toolSave(args) {
  const { lic } = gate();
  if (!lic.ok) return errContent(`License verification failed: ${lic.reason}`);

  const { code, componentName, projectRoot, featureDir = "components/generated" } = args;
  if (!code || !componentName || !projectRoot) {
    return errContent("Missing code / componentName / projectRoot.");
  }
  const cleaned = sanitizeCode(code);
  const dir = path.join(projectRoot, "src", featureDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${componentName}.tsx`);
  fs.writeFileSync(file, cleaned);
  updateBarrel(dir, componentName);

  return okContent(JSON.stringify({ saved: file, exportUpdated: true, note: "Stripped data-node-id and updated index.ts" }, null, 2));
}

function toolRemember(args) {
  const { lic } = gate();
  if (!lic.ok) return errContent(`License verification failed: ${lic.reason}`);
  const { projectRoot, figmaComponentKey, figmaName, target } = args;
  if (!projectRoot || !figmaComponentKey || !target) {
    return errContent("Missing projectRoot / figmaComponentKey / target.");
  }
  const count = rememberMapping(projectRoot, { figmaComponentKey, figmaName, target });
  return okContent(`Mapping asset saved (${count} total). It is bound to this tool and forms a switching-cost moat.`);
}

function toolCacheClear() {
  const { lic } = gate();
  if (!lic.ok) return errContent(`License verification failed: ${lic.reason}`);
  try {
    if (daemon) {
      return daemon.cacheClear().then((result) =>
        okContent(JSON.stringify(result || { cleared: true }, null, 2))
      );
    }
    return okContent(JSON.stringify({ cleared: true, note: "no daemon; nothing to clear" }, null, 2));
  } catch (e) {
    return errContent(`Cache clear failed: ${e.message}`);
  }
}

function toolScanComponents(args) {
  const { lic } = gate();
  if (!lic.ok) return errContent(`License verification failed: ${lic.reason}`);
  const { projectRoot } = args;
  if (!projectRoot) return errContent("Missing projectRoot argument.");
  try {
    loadAliases(projectRoot);
    const components = scanLocalComponents(projectRoot);
    return okContent(JSON.stringify({ components, count: components.length }, null, 2));
  } catch (e) {
    return errContent(`Component scan failed: ${e.message}`);
  }
}

function toolMappingHealth(args) {
  const { lic } = gate();
  if (!lic.ok) return errContent(`License verification failed: ${lic.reason}`);
  const { projectRoot } = args;
  if (!projectRoot) return errContent("Missing projectRoot argument.");
  try {
    const health = checkMappingHealth(projectRoot);
    return okContent(JSON.stringify(health, null, 2));
  } catch (e) {
    return errContent(`Mapping health check failed: ${e.message}`);
  }
}

function toolExportMappings(args) {
  const { lic } = gate();
  if (!lic.ok) return errContent(`License verification failed: ${lic.reason}`);
  const { projectRoot } = args;
  if (!projectRoot) return errContent("Missing projectRoot argument.");
  try {
    const data = exportMappings(projectRoot);
    return okContent(JSON.stringify(data, null, 2));
  } catch (e) {
    return errContent(`Mapping export failed: ${e.message}`);
  }
}

function toolImportMappings(args) {
  const { lic } = gate();
  if (!lic.ok) return errContent(`License verification failed: ${lic.reason}`);
  const { projectRoot, data } = args;
  if (!projectRoot || !data) return errContent("Missing projectRoot / data argument.");
  try {
    const result = importMappings(projectRoot, data);
    return okContent(JSON.stringify(result, null, 2));
  } catch (e) {
    return errContent(`Mapping import failed: ${e.message}`);
  }
}

function toolRefreshCRL(args) {
  const { lic } = gate();
  if (!lic.ok) return errContent(`License verification failed: ${lic.reason}`);
  const crlUrl = args.url || process.env.CRL_URL;
  if (!crlUrl) return errContent("No CRL URL configured. Provide it via --url or the CRL_URL environment variable.");
  return refreshCRL(crlUrl).then((result) =>
    okContent(JSON.stringify(result, null, 2))
  ).catch((e) =>
    errContent(`CRL refresh failed: ${e.message}`)
  );
}

async function refreshCRL(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // Format: { version: N, revoked: ["hash1", "hash2", ...] }
  const crlPath = path.join(os.homedir(), ".smart-figma", "crl.json");
  fs.mkdirSync(path.dirname(crlPath), { recursive: true });
  fs.writeFileSync(crlPath, JSON.stringify(data, null, 2));
  return { refreshed: true, count: (data.revoked || []).length, ts: Date.now() };
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

// ─── MCP tool catalog ───
const TOOLS = [
  {
    name: "compile_figma_component",
    description: "Compile a Figma node into a Tailwind + variant-mapping context. Accepts an offline figmaNode JSON or a figmaUrl (live Figma API). In BYOK mode the token bills the user.",
    inputSchema: {
      type: "object",
      properties: {
        figmaNode: { type: "object", description: "Figma node JSON exported offline (use either this or figmaUrl)" },
        figmaUrl: { type: "string", description: "Figma design link (https://www.figma.com/design/FILEKEY/...?node-id=NODEID; use either this or figmaNode)" },
        figmaToken: { type: "string", description: "Figma Personal Access Token (takes precedence over the FIGMA_ACCESS_TOKEN env var)" },
        projectRoot: { type: "string", description: "Absolute path to the user's project root" },
        localComponent: { type: "object", description: "Local component metadata (name/importPath/variants)" },
        styleFormat: { type: "string", enum: FORMAT_LIST, description: "Output style format: tailwind/css-modules/scss/styled-components (default tailwind)" },
        mode: { type: "string", enum: ["flat", "recursive"], description: "Compile mode: flat compiles only the outer container; recursive compiles the whole subtree (default flat)" },
        siblings: { type: "array", description: "Sibling node list, used to detect responsive breakpoints" },
      },
    },
  },
  {
    name: "fetch_figma_node",
    description: "Fetch a design node from the Figma API and normalize it into the compiler input format. Returns structured node data (including Auto Layout info).",
    inputSchema: {
      type: "object",
      properties: {
        figmaUrl: { type: "string", description: "Figma design link" },
        figmaToken: { type: "string", description: "Figma Access Token (optional; defaults to the FIGMA_ACCESS_TOKEN env var)" },
        action: { type: "string", enum: ["node", "file_meta"], description: "Fetch node details (node) or file metadata (file_meta)" },
      },
      required: ["figmaUrl"],
    },
  },
  {
    name: "save_component",
    description: "Deterministic write op: strip data-node-id, write to the exact path, and auto-update the index.ts barrel export.",
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
    description: "Persist a user-confirmed Figma->local-component mapping as a private asset, forming a switching-cost moat.",
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
    description: "Clear all compile caches (L1 memory + L2 disk); use to force a refresh after the data source changes.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "scan_components",
    description: "Auto-scan the project's local component library (shadcn/ui / radix / antd / mui) and extract component names, CVA variant definitions, and import paths.",
    inputSchema: {
      type: "object",
      properties: { projectRoot: { type: "string", description: "Absolute path to the project root" } },
      required: ["projectRoot"],
    },
  },
  {
    name: "check_mapping_health",
    description: "Check whether component files referenced by the mapping asset library still exist, and flag stale entries.",
    inputSchema: {
      type: "object",
      properties: { projectRoot: { type: "string", description: "Absolute path to the project root" } },
      required: ["projectRoot"],
    },
  },
  {
    name: "export_mappings",
    description: "Export the .smart-figma/mappings.json mapping assets (for team sharing or migration).",
    inputSchema: {
      type: "object",
      properties: { projectRoot: { type: "string", description: "Absolute path to the project root" } },
      required: ["projectRoot"],
    },
  },
  {
    name: "import_mappings",
    description: "Import mapping assets from external JSON and merge them into the local .smart-figma/mappings.json. Existing keys are not overwritten.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "Absolute path to the project root" },
        data: { type: "object", description: "Exported JSON data (containing a mappings array)" },
      },
      required: ["projectRoot", "data"],
    },
  },
  {
    name: "refresh_crl",
    description: "Refresh the license revocation list (CRL) from a remote URL and cache it locally to .smart-figma/crl.json.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Remote CRL URL (optional; defaults to the CRL_URL env var)" },
      },
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
    case "scan_components":
      return toolScanComponents(args || {});
    case "check_mapping_health":
      return toolMappingHealth(args || {});
    case "export_mappings":
      return toolExportMappings(args || {});
    case "import_mappings":
      return toolImportMappings(args || {});
    case "refresh_crl":
      return toolRefreshCRL(args || {});
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

  // Notifications (no id) handling.
  if (id === undefined || id === null) {
    if (method === "notifications/initialized") {
      xlog("debug", "client sent notifications/initialized");
    }
    return;
  }

  try {
    // ── initialize (no pre-init check needed) ──
    if (method === "initialize") {
      _initialized = true;
      // Initialize the daemon asynchronously in the background (does not block the initialize response).
      initDaemon().catch(e => xlog("warn", `daemon init error: ${e.message}`));
      // Probe BYOK key validity in the background (non-blocking).
      const llmConfig = resolveLLMConfig();
      if (llmConfig.byok) {
        probeKey(llmConfig).then(result => {
          if (!result.valid) xlog("warn", `BYOK key invalid (${result.reason}); will fall back to Credits.`);
          else xlog("info", `BYOK key verified (${llmConfig.provider})`);
        }).catch(() => {});
      }
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "smart-figma-mcp", version: SERVER_VERSION },
      }});
    }

    // ── ping (no init required) ──
    if (method === "ping") {
      return send({ jsonrpc: "2.0", id, result: {} });
    }

    // ── health (no init required; for diagnostics) ──
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
        license_payload: g.lic.ok ? g.lic.payload : null,
        renewal: g.renewal || null,
        byok_enabled: g.llm.byok,
        daemon_mode: daemon?.mode || "DIRECT",
        cache: cacheStats?.hits || null,
        node_version: process.version,
        version: SERVER_VERSION,
      }});
    }

    // ── Post-initialization gate ──
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
    // JSON parse failed -> standard error code (no id available, use null).
    send({ jsonrpc: "2.0", id: null, error: { code: ERROR_CODES.PARSE_ERROR, message: "Parse error" } });
    return;
  }
  // Treat an empty-string id as null (a notification).
  if (req.id === "") req.id = null;
  handle(req);
});

// ─── Graceful shutdown ───
function gracefulShutdown(signal) {
  xlog("warn", `Received ${signal}, shutting down...`);
  try { rl.close(); } catch {}
  // Clean up temporary cache files.
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
  // Tell the daemon to exit.
  if (daemon && daemon.connected()) {
    daemon.shutdown().catch(() => {});
  }
  xlog("info", "server stopped.");
  process.exit(0);
}
import os from "node:os";
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

log(`server up (stdio) v${SERVER_VERSION}. LOG_LEVEL=${process.env.LOG_LEVEL || "info"}. CREDIT_COST=${JSON.stringify(CREDIT_COST)}`);
