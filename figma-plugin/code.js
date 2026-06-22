// Auto Layoutify — Smart Figma MCP Plugin
// One-click conversion of a selected Frame from free-form layout to Auto Layout
// (source-side fix for non-standard designs).
//
// Usage:
//   1. Select the Frame(s) to convert in Figma
//   2. Plugins -> Development -> Import from manifest.json -> pick this project's figma-plugin/
//   3. Click the "Auto Layoutify" button
//   4. Wait for completion -> re-export the node -> compile_figma_component runs zero-token compile

"use strict";

// ─── Main command ───
figma.showUI(__html__, { width: 320, height: 380 });

figma.ui.onmessage = async function (msg) {
  if (msg.type === "auto-layoutify") {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.notify("⚠️ Please select a Frame to convert first", { error: true });
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

    figma.notify(`✅ Converted ${converted} Frame(s) to Auto Layout${errors > 0 ? ` (${errors} skipped)` : ""}`);
    figma.ui.postMessage({ type: "done", converted, errors });
  } else if (msg.type === "cancel") {
    figma.closePlugin();
  } else if (msg.type === "resize") {
    figma.ui.resize(320, msg.height);
  }
};

// ─── Auto Layoutify core ───

async function autoLayoutify(node) {
  // Only handle Frame / Component / Instance / Group.
  const SUPPORTED = new Set(["FRAME", "COMPONENT", "INSTANCE", "GROUP"]);
  if (!SUPPORTED.has(node.type)) return false;

  const children = (node.children || []).filter(
    (c) => c.visible !== false && !c.isAsset
  );
  if (children.length < 2) return false; // a single child does not need Auto Layout

  // 1. Collect child coordinates.
  const positions = children.map((c) => ({
    node: c,
    x: c.x,
    y: c.y,
    w: c.width,
    h: c.height,
    cx: c.x + c.width / 2, // centroid X
    cy: c.y + c.height / 2, // centroid Y
  }));

  // 2. Determine the main axis (horizontal vs vertical).
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
    // Variances are close -> decide from the actual x/y range.
    const xRange = Math.max(...xVals) - Math.min(...xVals);
    const yRange = Math.max(...yVals) - Math.min(...yVals);
    direction = xRange > yRange ? "HORIZONTAL" : "VERTICAL";
  }

  // 3. Infer spacing (cluster on one axis, then take the mode).
  const clusterKey = direction === "HORIZONTAL" ? "cy" : "cx";
  const sortKeyRow = direction === "HORIZONTAL" ? "cy" : "cx";
  const sortKeyCol = direction === "HORIZONTAL" ? "x" : "y";
  const sizeKey = direction === "HORIZONTAL" ? "w" : "h";

  // Cluster on Y (row clustering for horizontal layout).
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

  // 4. Collect spacing.
  const gapsPrimary = []; // primary-axis spacing (between items in a row)
  const gapsCross = []; // cross-axis spacing (between rows)

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

  // 5. Infer padding.
  const firstChild = rows[0].children[0];
  const lastRow = rows[rows.length - 1];
  const lastChild = lastRow.children[lastRow.children.length - 1];

  const padLeft = Math.round(firstChild[sortKeyCol] - (direction === "HORIZONTAL" ? 0 : node.x));
  const padTop = Math.round(
    (direction === "HORIZONTAL" ? rows[0].key : firstChild[sortKeyRow]) - node.y
  );

  // 6. Compute content size (to infer paddingRight / paddingBottom).
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

  // 7. Apply Auto Layout (undoable).
  // Remove all children first, apply the layout, then append them back to preserve hierarchy.
  const childNodes = [...node.children];
  for (const child of childNodes) {
    node.removeChild(child);
  }

  node.layoutMode = direction;
  // primaryAxisAlignItems / counterAxisAlignItems default to MIN (left/top aligned).
  node.primaryAxisAlignItems = "MIN";
  node.counterAxisAlignItems = "MIN";

  if (gapPrimary > 0) node.itemSpacing = gapPrimary;
  if (gapCross > 0) node.counterAxisSpacing = gapCross;
  if (padLeft > 0) node.paddingLeft = padLeft;
  if (padRight > 0) node.paddingRight = padRight;
  if (padTop > 0) node.paddingTop = padTop;
  if (padBottom > 0) node.paddingBottom = padBottom;

  // Multiple rows -> wrap layout.
  if (rows.length > 1) {
    node.layoutWrap = "WRAP";
  }

  // Append children back.
  for (const child of childNodes) {
    node.appendChild(child);
  }

  // Mark that Auto Layout has been applied.
  node.name = node.name.replace(/\s*\[Auto Layout\]$/, "") + " [Auto Layout]";

  return true;
}

// ─── Utilities ───

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
