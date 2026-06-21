// smoke.mjs — 端到端烟囱测试 v0.2.0：协议错误处理 + 健康检查 + Figma URL 解析
// 用法： SMART_FIGMA_LICENSE=<token> node test/smoke.mjs
//       或带 BYOK： LLM_PROVIDER=anthropic LLM_API_KEY=sk-xxx ... node test/smoke.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  // ━━━ 初始化前测试 ━━━
  section("0) 协议健壮性（初始化前）");

  // parse error: 非法 JSON
  child.stdin.write("not-json!!\n");
  await new Promise(r => setTimeout(r, 200));

  // tools/list 在初始化前应被拒绝
  const preInitList = await call("tools/list", {});
  assert(preInitList.error?.code === -32002, "初始化前 tools/list → NOT_INITIALIZED (-32002)");

  // ping 无需初始化
  const pingR = await call("ping", {});
  assert(pingR.result !== undefined, "ping 无需初始化");

  // health 无需初始化
  const healthR = await call("health", {});
  assert(healthR.result?.status === "ok", "health 返回 ok");
  assert(typeof healthR.result?.uptime === "number", "health 含 uptime");
  assert(healthR.result?.node_version === process.version, "health 含 node_version");
  console.log(`    health result: ${JSON.stringify(healthR.result)}`);

  // ━━━ 初始化 ━━━
  section("1) 初始化协议");
  const init = await call("initialize", {});
  assert(init.result?.serverInfo?.name === "smart-figma-mcp", "initialize 返回 serverInfo");
  assert(init.result?.serverInfo?.version === "0.2.0", "版本号从 package.json 读取 (0.2.0)");
  assert(init.result?.protocolVersion === "2024-11-05", "protocolVersion 正确");

  // ━━━ tools/list ━━━
  section("2) tools/list");
  const list = await call("tools/list", {});
  const toolNames = list.result.tools.map(t => t.name);
  console.log("  " + toolNames.join(", "));
  assert(toolNames.includes("compile_figma_component"), "含 compile_figma_component");
  assert(toolNames.includes("fetch_figma_node"), "含 fetch_figma_node (新增)");
  assert(toolNames.includes("save_component"), "含 save_component");
  assert(toolNames.includes("remember_mapping"), "含 remember_mapping");

  // ━━━ method not found ━━━
  section("3) 错误码：Method not found");
  const bogus = await call("nonexistent_method", {});
  assert(bogus.error?.code === -32601, "不存在的方法 → -32601");

  // ━━━ 规范 Auto Layout 编译 ━━━
  section("4) compile_figma_component (规范稿)");
  const r1 = await call("tools/call", {
    name: "compile_figma_component",
    arguments: { figmaNode: SIMPLE_NODE, projectRoot: "/tmp/demo-proj", localComponent: LOCAL_BUTTON },
  });
  assert(!r1.error, "规范稿编译无错误");
  const c1 = r1.result.content[0].text;
  console.log("  " + c1.split("\n")[0]);
  assert(c1.includes("PURE_DIGITAL"), "策略标记为 PURE_DIGITAL 或 SIMPLE");

  // ━━━ 非标稿 → 源头治理 ━━━
  section("5) compile_figma_component (非标稿 → SUGGEST_AUTOLAYOUT)");
  const r2 = await call("tools/call", {
    name: "compile_figma_component",
    arguments: { figmaNode: COMPLEX_NODE, projectRoot: "/tmp/demo-proj" },
  });
  const c2 = r2.result.content[0].text;
  assert(c2.includes("SUGGEST_AUTOLAYOUT"), "非标稿返回 SUGGEST_AUTOLAYOUT 建议");

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
  assert(!r3.error, "remember_mapping 成功");

  // ━━━ save_component ━━━
  section("7) save_component (确定性写操作)");
  const r4 = await call("tools/call", {
    name: "save_component",
    arguments: {
      projectRoot: "/tmp/demo-proj",
      componentName: "DangerButton",
      code: `export default function DangerButton(){return <button data-node-id="8:42" data-name="btn"   className="px-4">Del</button>}`,
    },
  });
  const c4 = r4.result.content[0].text;
  assert(c4.includes("saved"), "save 返回保存路径");
  // 验证实际文件内容已清洗
  const saved = JSON.parse(c4);
  const fileContent = fs.readFileSync(saved.saved, 'utf8');
  assert(!fileContent.includes("data-node-id"), "文件内容已清洗 data-node-id");
  assert(!fileContent.includes("data-name"), "文件内容已清洗 data-name");

  // ━━━ 版本号验证 ━━━
  section("8) 版本号");
  assert(init.result.serverInfo.version !== "5.0.0", "版本号不再是硬编码 5.0.0");

  // ━━━ 汇总 ━━━
  section(`结果：${passed} passed / ${failed} failed`);
  child.kill();
  if (failed > 0) process.exit(1);
  console.log("\n✅ 烟囱测试全部通过");
})();
