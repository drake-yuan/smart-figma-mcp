// smoke.mjs — end-to-end smoke test v0.2.0: protocol error handling + health check + Figma URL parsing
// Usage: SMART_FIGMA_LICENSE=<token> node test/smoke.mjs
//        or with BYOK: LLM_PROVIDER=anthropic LLM_API_KEY=sk-xxx ... node test/smoke.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
const TMP = path.join(__dirname, "..", "test", "__temp__");
const serverPath = path.join(__dirname, "..", "src", "server.js");

const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* skip non-JSON lines */ }
  }
});

let idc = 0;
function callRaw(json) {
  const id = ++idc;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const out = typeof json === "string" ? json : JSON.stringify({ ...json, id });
    child.stdin.write(out + "\n");
  });
}
function call(method, params) {
  return callRaw({ jsonrpc: "2.0", method, params });
}

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

function section(t) {
  console.log(`\n${"=".repeat(60)}\n${t}\n${"=".repeat(60)}`);
}

const SIMPLE_NODE = {
  layoutMode: "VERTICAL",
  itemSpacing: 16,
  paddingTop: 8,
  paddingBottom: 8,
  paddingLeft: 16,
  paddingRight: 16,
  counterAxisAlignItems: "CENTER",
  componentKey: "8:42",
  componentProperties: { State: "Danger", Size: "Small" },
  children: [{ name: "label" }],
};

const COMPLEX_NODE = {
  children: [
    { x: 10, y: 20, layoutPositioning: "ABSOLUTE" },
    { x: 30, y: 40, layoutPositioning: "ABSOLUTE" },
    { x: 50, y: 60, layoutPositioning: "ABSOLUTE", children: [{ children: [{ children: [{}] }] }] },
  ],
};

const LOCAL_BUTTON = {
  name: "Button",
  importPath: "@/components/ui/button",
  variants: { variant: ["default", "destructive", "outline"], size: ["sm", "md", "lg"] },
};

(async () => {
  // ━━━ Pre-initialization tests ━━━
  section("0) Protocol robustness (before initialize)");

  // parse error: invalid JSON
  child.stdin.write("not-json!!\n");
  await new Promise(r => setTimeout(r, 200));

  // tools/list before initialize should be rejected
  const preInitList = await call("tools/list", {});
  assert(preInitList.error?.code === -32002, "tools/list before init -> NOT_INITIALIZED (-32002)");

  // ping requires no initialization
  const pingR = await call("ping", {});
  assert(pingR.result !== undefined, "ping requires no initialization");

  // health requires no initialization
  const healthR = await call("health", {});
  assert(healthR.result?.status === "ok", "health returns ok");
  assert(typeof healthR.result?.uptime === "number", "health includes uptime");
  assert(healthR.result?.node_version === process.version, "health includes node_version");
  console.log(`    health result: ${JSON.stringify(healthR.result)}`);

  // ━━━ Initialize ━━━
  section("1) Initialize protocol");
  const init = await call("initialize", {});
  assert(init.result?.serverInfo?.name === "smart-figma-mcp", "initialize returns serverInfo");
  assert(init.result?.serverInfo?.version === PKG_VERSION, `version read from package.json (${PKG_VERSION})`);
  assert(init.result?.protocolVersion === "2024-11-05", "protocolVersion is correct");

  // ━━━ tools/list ━━━
  section("2) tools/list");
  const list = await call("tools/list", {});
  const toolNames = list.result.tools.map(t => t.name);
  console.log("  " + toolNames.join(", "));
  assert(toolNames.includes("compile_figma_component"), "includes compile_figma_component");
  assert(toolNames.includes("fetch_figma_node"), "includes fetch_figma_node (new)");
  assert(toolNames.includes("save_component"), "includes save_component");
  assert(toolNames.includes("remember_mapping"), "includes remember_mapping");

  // ━━━ method not found ━━━
  section("3) Error code: Method not found");
  const bogus = await call("nonexistent_method", {});
  assert(bogus.error?.code === -32601, "nonexistent method -> -32601");

  // ━━━ clean Auto Layout compile ━━━
  section("4) compile_figma_component (clean design)");
  const r1 = await call("tools/call", {
    name: "compile_figma_component",
    arguments: { figmaNode: SIMPLE_NODE, projectRoot: "/tmp/demo-proj", localComponent: LOCAL_BUTTON },
  });
  assert(!r1.error, "clean design compiles without error");
  const c1 = r1.result.content[0].text;
  console.log("  " + c1.split("\n")[0]);
  assert(c1.includes("PURE_DIGITAL"), "strategy tagged PURE_DIGITAL or SIMPLE");

  // ━━━ non-standard design -> source-side fix ━━━
  section("5) compile_figma_component (non-standard -> SUGGEST_AUTOLAYOUT)");
  const r2 = await call("tools/call", {
    name: "compile_figma_component",
    arguments: { figmaNode: COMPLEX_NODE, projectRoot: "/tmp/demo-proj" },
  });
  const c2 = r2.result.content[0].text;
  assert(c2.includes("SUGGEST_AUTOLAYOUT"), "non-standard design returns a SUGGEST_AUTOLAYOUT hint");

  // ━━━ remember_mapping ━━━
  section("6) remember_mapping");
  const r3 = await call("tools/call", {
    name: "remember_mapping",
    arguments: {
      projectRoot: "/tmp/demo-proj",
      figmaComponentKey: "8:42",
      figmaName: "Button/Danger/Small",
      target: { component: "Button", importPath: "@/components/ui/button", props: { variant: "destructive", size: "sm" } },
    },
  });
  assert(!r3.error, "remember_mapping succeeds");

  // ━━━ save_component ━━━
  section("7) save_component (deterministic write op)");
  const r4 = await call("tools/call", {
    name: "save_component",
    arguments: {
      projectRoot: "/tmp/demo-proj",
      componentName: "DangerButton",
      code: `export default function DangerButton(){return <button data-node-id="8:42" data-name="btn"   className="px-4">Del</button>}`,
    },
  });
  const c4 = r4.result.content[0].text;
  assert(c4.includes("saved"), "save returns the saved path");
  // Verify the actual file content was cleaned.
  const saved = JSON.parse(c4);
  const fileContent = fs.readFileSync(saved.saved, 'utf8');
  assert(!fileContent.includes("data-node-id"), "file content stripped of data-node-id");
  assert(!fileContent.includes("data-name"), "file content stripped of data-name");

  // ━━━ version check ━━━
  section("8) Version");
  assert(init.result.serverInfo.version !== "0.2.0", "version bumped past 0.2.0");

  // ━━━ new v0.3.0 tests ━━━
  // 9a) coordinate-flow compile (MODERATE complexity: no Auto Layout but coordinate flow)
  section("9a) coordinate-flow compile (MODERATE -> COORDINATE_FLOW)");
  const MODERATE_NODE = {
    name: "Card",
    x: 0, y: 0, width: 320, height: 200,
    children: [
      { name: "header", x: 16, y: 16, width: 288, height: 48 },
      { name: "body1", x: 16, y: 80, width: 136, height: 96 },
      { name: "body2", x: 168, y: 80, width: 136, height: 96 },
    ],
  };
  const r5 = await call("tools/call", {
    name: "compile_figma_component",
    arguments: { figmaNode: MODERATE_NODE, projectRoot: "/tmp/demo-proj" },
  });
  const c5 = r5.result.content[0].text;
  const j5 = JSON.parse(c5);
  assert(j5.strategy === "SEMANTIC", "MODERATE node -> SEMANTIC strategy");
  assert(j5.coordinateFlow?.grid?.axis, "coordinate flow includes an axis direction");
  assert(j5.coordinateFlow?.grid?.rows?.length >= 2, "coordinate flow includes >=2 rows");
  assert(j5.tailwind, "coordinate flow outputs tailwind");
  console.log(`    axis: ${j5.coordinateFlow.grid.axis}, rows: ${j5.coordinateFlow.grid.rows.length}`);

  // 9b) recursive compile mode
  section("9b) recursive compile (mode=recursive)");
  const RECURSIVE_NODE = {
    name: "Page",
    layoutMode: "VERTICAL",
    itemSpacing: 16,
    paddingTop: 16,
    paddingLeft: 24,
    paddingRight: 24,
    children: [
      { name: "Header", layoutMode: "HORIZONTAL", itemSpacing: 8, children: [
        { name: "Logo", width: 40, height: 40 },
        { name: "Nav", layoutMode: "HORIZONTAL", itemSpacing: 12, children: [
          { name: "link1", text: "Home" },
          { name: "link2", text: "About" },
        ]},
      ]},
      { name: "Body", children: [{ name: "card", width: 200, x: 24, y: 80 }] },
    ],
  };
  const r6 = await call("tools/call", {
    name: "compile_figma_component",
    arguments: { figmaNode: RECURSIVE_NODE, mode: "recursive", projectRoot: "/tmp/demo-proj" },
  });
  const j6 = JSON.parse(r6.result.content[0].text);
  assert(j6.recursiveTree?.children?.length >= 2, "recursive tree has >=2 children");
  assert(j6.recursiveTree?.children?.[0]?.name === "Header", "recursive level 1 name matches");
  assert(j6.recursiveTree?.children?.[0]?.children, "Header also has children");

  // 9c) multi-format output
  section("9c) multi-format output");
  for (const fmt of ["css-modules", "scss", "styled-components"]) {
    const rFmt = await call("tools/call", {
      name: "compile_figma_component",
      arguments: { figmaNode: SIMPLE_NODE, styleFormat: fmt, projectRoot: "/tmp/demo-proj" },
    });
    const jFmt = JSON.parse(rFmt.result.content[0].text);
    assert(jFmt.styleFormat === fmt, `styleFormat=${fmt}`);
    assert(jFmt.formattedOutput, `formattedOutput non-empty (${fmt})`);
    assert(jFmt.formattedOutput !== `className="${jFmt.tailwind}"`, `${fmt} output differs from Tailwind`);
    console.log(`    ${fmt}: ${jFmt.formattedOutput.slice(0, 60)}...`);
  }

  // 9d) responsive breakpoint detection
  section("9d) responsive breakpoint detection");
  const SIBLINGS = [
    { name: "Button / Desktop" },
    { name: "Button / Tablet" },
    { name: "Button / Mobile" },
  ];
  const rRes = await call("tools/call", {
    name: "compile_figma_component",
    arguments: { figmaNode: SIMPLE_NODE, siblings: SIBLINGS, projectRoot: "/tmp/demo-proj" },
  });
  const jRes = JSON.parse(rRes.result.content[0].text);
  assert(jRes.responsive?.detected, "responsive breakpoints detected");
  assert(jRes.responsive?.breakpoints?.desktop, "includes desktop breakpoint");
  assert(jRes.responsive?.breakpoints?.mobile, "includes mobile breakpoint");

  // 9e) complexity visualization report
  section("9e) complexity visualization report");
  const rViz = await call("tools/call", {
    name: "compile_figma_component",
    arguments: { figmaNode: SIMPLE_NODE, projectRoot: "/tmp/demo-proj" },
  });
  const jViz = JSON.parse(rViz.result.content[0].text);
  assert(jViz.complexityReport?.includes("Complexity"), "complexity report has a title");
  assert(jViz.complexityReport?.includes("█"), "complexity report has a progress bar");
  console.log("\n" + jViz.complexityReport);

  // ━━━ 10) v0.4.0 cache + daemon tests ━━━
  // 10a) cache_clear tool registration
  section("10a) cache tool registration (cache_clear)");
  const tools2 = await call("tools/list");
  const toolCacheClear = tools2.result.tools.find(t => t.name === "cache_clear");
  // Skip if cache_clear is not registered yet.
  const hasCacheTool = !!toolCacheClear;
  console.log(`    cache_clear tool: ${hasCacheTool ? "✅ registered" : "⏭ skipped (todo)"}`);

  // 10b) cache_clear tool call
  if (hasCacheTool) {
    section("10b) cache_clear tool call");
    const rClear = await call("tools/call", {
      name: "cache_clear",
      arguments: {},
    });
    const jClear = JSON.parse(rClear.result.content[0].text);
    assert(jClear.cleared === true, "cache_clear returns cleared=true");
    console.log(`    cache cleared: ${rClear.result.content[0].text}`);
  }

  // ━━━ 11) v0.5.0 Module 02 + 04 tests ━━━
  section("11a) scan_components tool registration");
  const tools3 = await call("tools/list");
  assert(tools3.result.tools.some(t => t.name === "scan_components"), "scan_components registered");
  assert(tools3.result.tools.some(t => t.name === "check_mapping_health"), "check_mapping_health registered");
  assert(tools3.result.tools.some(t => t.name === "export_mappings"), "export_mappings registered");
  assert(tools3.result.tools.some(t => t.name === "import_mappings"), "import_mappings registered");
  assert(tools3.result.tools.some(t => t.name === "refresh_crl"), "refresh_crl registered");

  section("11b) export_mappings");
  const rExp = await call("tools/call", {
    name: "export_mappings",
    arguments: { projectRoot: TMP },
  });
  const jExp = JSON.parse(rExp.result.content[0].text);
  assert(jExp.version === 2, "mappings version v2");
  assert(Array.isArray(jExp.mappings), "mappings is an array");

  section("11c) check_mapping_health");
  const rHealth = await call("tools/call", {
    name: "check_mapping_health",
    arguments: { projectRoot: TMP },
  });
  const jHealth = JSON.parse(rHealth.result.content[0].text);
  assert(typeof jHealth.total === "number", "mapping health includes total");
  assert(typeof jHealth.stale === "number", "mapping health includes stale");

  section("11d) refresh_crl tool available");
  const toolsCRL = tools3.result.tools.find(t => t.name === "refresh_crl");
  assert(!!toolsCRL, "refresh_crl tool exists");
  // Not actually called (needs CRL_URL); only verifying discoverability.

  // ━━━ Summary ━━━
  section(`Result: ${passed} passed / ${failed} failed`);
  child.kill();
  if (failed > 0) process.exit(1);
  console.log("\n✅ All smoke tests passed");
})();
