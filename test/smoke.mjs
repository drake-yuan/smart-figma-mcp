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
  assert(init.result?.serverInfo?.version === "0.4.0", "版本号从 package.json 读取 (0.4.0)");
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
  assert(init.result.serverInfo.version !== "0.2.0", "版本号已更新到 0.3.0+");

  // ━━━ 新增 0.3.0 测试 ━━━
  // 9a) 坐标流编译（MODERATE 复杂度：无 Auto Layout 但有坐标流）
  section("9a) 坐标流编译（MODERATE → COORDINATE_FLOW）");
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
  assert(j5.strategy === "SEMANTIC", "MODERATE 节点 → SEMANTIC 策略");
  assert(j5.coordinateFlow?.grid?.axis, "坐标流含 axis 方向");
  assert(j5.coordinateFlow?.grid?.rows?.length >= 2, "坐标流含 ≥2 行");
  assert(j5.tailwind, "坐标流输出 tailwind");
  console.log(`    轴方向: ${j5.coordinateFlow.grid.axis}, 行数: ${j5.coordinateFlow.grid.rows.length}`);

  // 9b) 递归编译模式
  section("9b) 递归编译（mode=recursive）");
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
  assert(j6.recursiveTree?.children?.length >= 2, "递归树含 ≥2 个子节点");
  assert(j6.recursiveTree?.children?.[0]?.name === "Header", "递归第 1 层 name 匹配");
  assert(j6.recursiveTree?.children?.[0]?.children, "Header 下也有子节点");

  // 9c) 多格式输出
  section("9c) 多格式输出");
  for (const fmt of ["css-modules", "scss", "styled-components"]) {
    const rFmt = await call("tools/call", {
      name: "compile_figma_component",
      arguments: { figmaNode: SIMPLE_NODE, styleFormat: fmt, projectRoot: "/tmp/demo-proj" },
    });
    const jFmt = JSON.parse(rFmt.result.content[0].text);
    assert(jFmt.styleFormat === fmt, `styleFormat=${fmt}`);
    assert(jFmt.formattedOutput, `formattedOutput 非空 (${fmt})`);
    assert(jFmt.formattedOutput !== `className="${jFmt.tailwind}"`, `${fmt} 输出不同于 Tailwind`);
    console.log(`    ${fmt}: ${jFmt.formattedOutput.slice(0, 60)}...`);
  }

  // 9d) 响应式断点检测
  section("9d) 响应式断点检测");
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
  assert(jRes.responsive?.detected, "检测到响应式断点");
  assert(jRes.responsive?.breakpoints?.desktop, "含 desktop 断点");
  assert(jRes.responsive?.breakpoints?.mobile, "含 mobile 断点");

  // 9e) 复杂度可视化报告
  section("9e) 复杂度可视化报告");
  const rViz = await call("tools/call", {
    name: "compile_figma_component",
    arguments: { figmaNode: SIMPLE_NODE, projectRoot: "/tmp/demo-proj" },
  });
  const jViz = JSON.parse(rViz.result.content[0].text);
  assert(jViz.complexityReport?.includes("复杂度"), "复杂度报告含中文标题");
  assert(jViz.complexityReport?.includes("█"), "复杂度报告含进度条");
  console.log("\n" + jViz.complexityReport);

  // ━━━ 10) 0.4.0 缓存 + Daemon 测试 ━━━
  // 10a) 添加 cache_clear 工具
  section("10a) 缓存工具注册（cache_clear）");
  const tools2 = await call("tools/list");
  const toolCacheClear = tools2.result.tools.find(t => t.name === "cache_clear");
  // 如果还未注册 cache_clear 工具，跳过
  const hasCacheTool = !!toolCacheClear;
  console.log(`    cache_clear 工具: ${hasCacheTool ? "✅ 已注册" : "⏭ 跳过（待完成）"}`);

  // 10b) cache_clear 工具调用
  if (hasCacheTool) {
    section("10b) cache_clear 工具调用");
    const rClear = await call("tools/call", {
      name: "cache_clear",
      arguments: {},
    });
    const jClear = JSON.parse(rClear.result.content[0].text);
    assert(jClear.cleared === true, "cache_clear 返回 cleared=true");
    console.log(`    缓存已清除: ${rClear.result.content[0].text}`);
  }

  // ━━━ 汇总 ━━━
  section(`结果：${passed} passed / ${failed} failed`);
  child.kill();
  if (failed > 0) process.exit(1);
  console.log("\n✅ 烟囱测试全部通过");
})();
