// Auto Layoutify — Smart Figma MCP Plugin
// 一键将选中 Frame 从自由布局转换为 Auto Layout，源头治理非标稿。
//
// 用法：
//   1. 在 Figma 中选中要转换的 Frame
//   2. Plugins → Development → Import from manifest.json → 选中本项目 figma-plugin/
//   3. 点击「Auto Layoutify」按钮
//   4. 等待转换完成 → 重新导出节点 → compile_figma_component 零 Token 编译

"use strict";

// ─── 主命令 ───
figma.showUI(__html__, { width: 320, height: 380 });

figma.ui.onmessage = async function (msg) {
  if (msg.type === "auto-layoutify") {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.notify("⚠️ 请先选中要转换的 Frame", { error: true });
      figma.ui.postMessage({ type: "done", converted: 0, errors: 0 });
      return;
    }

    let converted = 0;
    let errors = 0;
    const total = selection.length;

    for (let i = 0; i < selection.length; i++) {
      const node = selection[i];
      try {
        const result = await autoLayoutify(node);
        if (result) converted++;
        else errors++;
      } catch (e) {
        console.error("Auto Layoutify failed:", e);
        errors++;
      }
      figma.ui.postMessage({
        type: "progress",
        current: i + 1,
        total,
        converted,
        errors,
        lastNode: node.name,
      });
    }

    figma.notify(`✅ 已转换 ${converted} 个 Frame 为 Auto Layout${errors > 0 ? `（${errors} 个跳过）` : ""}`);
    figma.ui.postMessage({ type: "done", converted, errors });
  } else if (msg.type === "cancel") {
    figma.closePlugin();
  } else if (msg.type === "resize") {
    figma.ui.resize(320, msg.height);
  }
};

// ─── Auto Layoutify 核心 ───

async function autoLayoutify(node) {
  // 只处理 Frame / Component / Instance / Group
  const SUPPORTED = new Set(["FRAME", "COMPONENT", "INSTANCE", "GROUP"]);
  if (!SUPPORTED.has(node.type)) return false;

  const children = (node.children || []).filter(
    (c) => c.visible !== false && !c.isAsset
  );
  if (children.length < 2) return false; // 单个子节点不需要 Auto Layout

  // 1. 收集子节点坐标
  const positions = children.map((c) => ({
    node: c,
    x: c.x,
    y: c.y,
    w: c.width,
    h: c.height,
    cx: c.x + c.width / 2, // 重心 X
    cy: c.y + c.height / 2, // 重心 Y
  }));

  // 2. 判断主轴方向（水平 vs 垂直）
  const xVals = positions.map((p) => p.cx);
  const yVals = positions.map((p) => p.cy);
  const xVariance = variance(xVals);
  const yVariance = variance(yVals);

  let direction;
  if (xVariance > yVariance * 2) {
    direction = "HORIZONTAL";
  } else if (yVariance > xVariance * 2) {
    direction = "VERTICAL";
  } else {
    // 方差相近 → 根据实际 x/y 范围判断
    const xRange = Math.max(...xVals) - Math.min(...xVals);
    const yRange = Math.max(...yVals) - Math.min(...yVals);
    direction = xRange > yRange ? "HORIZONTAL" : "VERTICAL";
  }

  // 3. 推断间距（同一轴聚类后用众数）
  const clusterKey = direction === "HORIZONTAL" ? "cy" : "cx";
  const sortKeyRow = direction === "HORIZONTAL" ? "cy" : "cx";
  const sortKeyCol = direction === "HORIZONTAL" ? "x" : "y";
  const sizeKey = direction === "HORIZONTAL" ? "w" : "h";

  // Y 聚类（水平布局时行聚类）
  const TOLERANCE = 4;
  const sorted = [...positions].sort((a, b) => a[sortKeyRow] - b[sortKeyRow]);
  const rows = [];
  let currentRow = { key: sorted[0][sortKeyRow], children: [sorted[0]] };
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i][sortKeyRow] - currentRow.key) <= TOLERANCE) {
      currentRow.children.push(sorted[i]);
    } else {
      rows.push(currentRow);
      currentRow = { key: sorted[i][sortKeyRow], children: [sorted[i]] };
    }
  }
  rows.push(currentRow);

  // 4. 收集间距
  const gapsPrimary = []; // 主轴间距（行内元素间距）
  const gapsCross = []; // 交叉轴间距（行间距）

  for (const row of rows) {
    row.children.sort((a, b) => a[sortKeyCol] - b[sortKeyCol]);
    for (let i = 1; i < row.children.length; i++) {
      const prev = row.children[i - 1];
      const curr = row.children[i];
      gapsPrimary.push(curr[sortKeyCol] - (prev[sortKeyCol] + prev[sizeKey]));
    }
  }

  for (let i = 1; i < rows.length; i++) {
    const prevRow = rows[i - 1];
    const currRow = rows[i];
    const prevMax =
      direction === "HORIZONTAL"
        ? Math.max(...prevRow.children.map((c) => c.y + c.h))
        : Math.max(...prevRow.children.map((c) => c.x + c.w));
    gapsCross.push(currRow.key - prevMax);
  }

  const gapPrimary = Math.round(mode(gapsPrimary) || 0);
  const gapCross = Math.round(mode(gapsCross) || 0);

  // 5. 推断 padding
  const firstChild = rows[0].children[0];
  const lastRow = rows[rows.length - 1];
  const lastChild = lastRow.children[lastRow.children.length - 1];

  const padLeft = Math.round(firstChild[sortKeyCol] - (direction === "HORIZONTAL" ? 0 : node.x));
  const padTop = Math.round(
    (direction === "HORIZONTAL" ? rows[0].key : firstChild[sortKeyRow]) - node.y
  );

  // 6. 计算内容宽高（用于推断 paddingRight / paddingBottom）
  let maxRight = 0;
  let maxBottom = 0;
  for (const p of positions) {
    const r = p.x + p.w - (direction === "HORIZONTAL" ? padLeft : 0);
    const b = p.y + p.h - (direction === "HORIZONTAL" ? 0 : padTop);
    if (r > maxRight) maxRight = r;
    if (b > maxBottom) maxBottom = b;
  }

  const padRight = Math.max(0, Math.round(node.width - maxRight));
  const padBottom = Math.max(0, Math.round(node.height - maxBottom));

  // 7. 应用 Auto Layout（带 undo）
  // 先 remove 所有子节点，应用 layout，再 append 回来——保持层级
  const childNodes = [...node.children];
  for (const child of childNodes) {
    node.removeChild(child);
  }

  node.layoutMode = direction;
  // primaryAxisAlignItems / counterAxisAlignItems 默认为 MIN（左/上对齐）
  node.primaryAxisAlignItems = "MIN";
  node.counterAxisAlignItems = "MIN";

  if (gapPrimary > 0) node.itemSpacing = gapPrimary;
  if (gapCross > 0) node.counterAxisSpacing = gapCross;
  if (padLeft > 0) node.paddingLeft = padLeft;
  if (padRight > 0) node.paddingRight = padRight;
  if (padTop > 0) node.paddingTop = padTop;
  if (padBottom > 0) node.paddingBottom = padBottom;

  // 如果有多行（wrap layout）
  if (rows.length > 1) {
    node.layoutWrap = "WRAP";
  }

  // 重新 append 子节点
  for (const child of childNodes) {
    node.appendChild(child);
  }

  // 标注 Auto Layout 已应用
  node.name = node.name.replace(/\s*\[Auto Layout\]$/, "") + " [Auto Layout]";

  return true;
}

// ─── 工具函数 ───

function variance(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
}

function mode(arr) {
  if (!arr.length) return 0;
  const freq = {};
  let best = arr[0],
    bestCount = 0;
  for (const v of arr) {
    const r = Math.round(v);
    freq[r] = (freq[r] || 0) + 1;
    if (freq[r] > bestCount) {
      best = r;
      bestCount = freq[r];
    }
  }
  return best;
}
