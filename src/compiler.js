// compiler.js — 确定性几何编译器 v0.3.0
//
// 三层策略：
//   PURE_DIGITAL  — 规范 Auto Layout → 纯数学编译，零 LLM、零 token
//   SEMANTIC      — 坐标流自由布局 → 栅格推断 → 输出结构化骨架 + LLM 装配
//   VISUAL        — 极度复杂 → 建议源头治理（figma_auto_layoutify），实在不行才截图降级
//
// 新增 v0.3.0：
//   - compileCoordinateFlow() 坐标流栅格推断
//   - compileRecursive() 递归子树编译（深度限制 6）
//   - formatOutput() 多输出格式（tailwind/css-modules/scss/styled-components）
//   - detectResponsiveBreakpoints() 响应式断点感知
//   - visualizeComplexity() 人可读复杂度报告

const STEP = 4; // Tailwind 4px 步长
const MAX_DEPTH = 6; // 递归最大深度

// ─── 工具函数 ───

function px2step(v) {
  if (!v && v !== 0) return null;
  return Math.round(v / STEP);
}

function camelCase(str) {
  return str.replace(/[-: ]+(.)/g, (_, c) => c.toUpperCase());
}

// 众数计算
function mode(arr) {
  if (!arr.length) return 0;
  const freq = new Map();
  for (const v of arr) {
    const r = Math.round(v);
    freq.set(r, (freq.get(r) || 0) + 1);
  }
  let best = 0, bestCount = 0;
  for (const [k, c] of freq) {
    if (c > bestCount) { best = k; bestCount = c; }
  }
  return best;
}

// ─── A 级策略：规范 Auto Layout → Tailwind ───

export function compileAutoLayout(node) {
  const cls = [];
  if (node.layoutMode === "HORIZONTAL") cls.push("flex", "flex-row");
  else if (node.layoutMode === "VERTICAL") cls.push("flex", "flex-col");

  if (node.itemSpacing) {
    const g = px2step(node.itemSpacing);
    if (g != null) cls.push(`gap-${g}`);
  }
  const pt = px2step(node.paddingTop);
  const pb = px2step(node.paddingBottom);
  const pl = px2step(node.paddingLeft);
  const pr = px2step(node.paddingRight);
  if (pt != null) cls.push(`pt-${pt}`);
  if (pb != null) cls.push(`pb-${pb}`);
  if (pl != null) cls.push(`pl-${pl}`);
  if (pr != null) cls.push(`pr-${pr}`);

  if (node.primaryAxisAlignItems === "CENTER") cls.push("justify-center");
  if (node.primaryAxisAlignItems === "SPACE_BETWEEN") cls.push("justify-between");
  if (node.primaryAxisAlignItems === "END") cls.push("justify-end");
  if (node.counterAxisAlignItems === "CENTER") cls.push("items-center");
  if (node.counterAxisAlignItems === "END") cls.push("items-end");
  if (node.layoutWrap === "WRAP") cls.push("flex-wrap");

  // 尺寸约束
  if (node.width && !node.layoutMode) {
    const w = px2step(node.width);
    if (w != null && w > 0) cls.push(`w-${Math.min(w, 96)}`);
  }
  if (node.height && !node.layoutMode) {
    const h = px2step(node.height);
    if (h != null && h > 0) cls.push(`h-${Math.min(h, 96)}`);
  }

  return cls.join(" ");
}

// 兼容旧 API
export const compileFigmaLayout = compileAutoLayout;

// ─── B 级策略：坐标流自由布局 → 空间栅格推断 ───

/**
 * 当节点无 Auto Layout 时，对直接子节点做坐标聚类，推断隐式行列布局
 *
 * @param {Object} node - Figma 节点（含 children 及坐标）
 * @param {Object} parentBox - 父节点边界 { x, y, width, height }（可选，默认用 node 自身）
 * @returns {Object} { strategy: "COORDINATE_FLOW", grid: {...}, tailwind: "..." }
 */
export function compileCoordinateFlow(node, parentBox) {
  const children = Array.isArray(node.children) ? node.children.filter(
    c => c.x != null && c.y != null
  ) : [];

  if (children.length === 0) {
    return { strategy: "COORDINATE_FLOW", grid: null, tailwind: "", reason: "无有效子节点" };
  }

  const box = parentBox || { x: node.x || 0, y: node.y || 0 };

  // 1. 相对化坐标
  const rel = children.map(c => ({
    ...c,
    relX: Math.round((c.x || 0) - box.x),
    relY: Math.round((c.y || 0) - box.y),
    w: Math.round(c.width || 0),
    h: Math.round(c.height || 0),
  }));

  // 2. 判断主轴方向：通过 X/Y 方差判断是水平排列还是垂直排列
  const xVals = rel.map(c => c.relX);
  const yVals = rel.map(c => c.relY);
  const xVariance = variance(xVals);
  const yVariance = variance(yVals);

  // 如果 X 方差远大于 Y 方差 → 水平排列；否则垂直排列
  const isHorizontal = xVariance > yVariance * 2;

  // 3. 聚类
  const TOLERANCE = 4;
  const rows = clusterAxis(rel, isHorizontal ? "relY" : "relX", TOLERANCE);

  // 4. 行内排序
  for (const row of rows) {
    row.children.sort((a, b) => isHorizontal ? a.relX - b.relX : a.relY - b.relY);
    // 用最大高度/宽度作为行高/列宽
    row.size = Math.max(...row.children.map(c => isHorizontal ? c.h : c.w));
    row.start = row.children[0][isHorizontal ? "relY" : "relX"];
  }

  // 5. 间距推断
  let inferredGapAxis1 = null; // gap-x (horizontal) / gap-y (vertical)
  let inferredGapAxis2 = null; // gap-y (horizontal) / gap-x (vertical)

  const gaps1 = [];
  for (const row of rows) {
    for (let i = 1; i < row.children.length; i++) {
      const prev = row.children[i - 1];
      const curr = row.children[i];
      if (isHorizontal) {
        gaps1.push(curr.relX - (prev.relX + prev.w));
      } else {
        gaps1.push(curr.relY - (prev.relY + prev.h));
      }
    }
  }
  if (gaps1.length) inferredGapAxis1 = mode(gaps1);

  const gaps2 = [];
  for (let i = 1; i < rows.length; i++) {
    gaps2.push(rows[i].start - (rows[i - 1].start + rows[i - 1].size));
  }
  if (gaps2.length) inferredGapAxis2 = mode(gaps2);

  // 6. 推断 padding
  const firstChild = rel[0];
  const padTop = isHorizontal ? rows[0].start : firstChild.relY;
  const padLeft = isHorizontal ? rows[0].children[0].relX : rows[0].start;
  const lastRow = rows[rows.length - 1];
  const lastChild = lastRow.children[lastRow.children.length - 1];
  const padBottom = isHorizontal
    ? Math.round((box.height || (lastRow.start + lastRow.size)) - (lastRow.start + lastRow.size))
    : Math.round((box.height || (lastChild.relY + lastChild.h)) - (lastChild.relY + lastChild.h));
  const padRight = isHorizontal
    ? Math.round((box.width || (lastChild.relX + lastChild.w)) - (lastChild.relX + lastChild.w))
    : Math.round((box.width || (lastRow.start + lastRow.size)) - (lastRow.start + lastRow.size));

  // 7. 生成 Tailwind
  const tw = [];
  tw.push("flex", isHorizontal ? "flex-col" : "flex-row"); // 注意：主聚类轴 → 反方向是 flex 方向
  if (isHorizontal) {
    // 每行是水平排列子元素 → flex-row（行内），行间 flex-col
    // 实际：clustered by Y → 每行内元素水平排列
    tw.push("flex-col"); // 行间垂直排列
    if (inferredGapAxis2 != null) {
      const g = px2step(inferredGapAxis2);
      if (g != null) tw.push(`gap-y-${g}`);
    }
  } else {
    // clustered by X → 每列元素垂直排列
    tw.push("flex-row"); // 列间水平排列
    if (inferredGapAxis2 != null) {
      const g = px2step(inferredGapAxis2);
      if (g != null) tw.push(`gap-x-${g}`);
    }
  }
  const pt = px2step(padTop);
  const pb = px2step(padBottom);
  const pl = px2step(padLeft);
  const pr = px2step(padRight);
  if (pt != null && pt > 0) tw.push(`pt-${pt}`);
  if (pb != null && pb > 0) tw.push(`pb-${pb}`);
  if (pl != null && pl > 0) tw.push(`pl-${pl}`);
  if (pr != null && pr > 0) tw.push(`pr-${pr}`);

  return {
    strategy: "COORDINATE_FLOW",
    grid: {
      axis: isHorizontal ? "y-clustered" : "x-clustered",
      rows: rows.map(r => ({
        y: r.start,
        size: r.size,
        children: r.children.map(c => ({ x: c.relX, y: c.relY, w: c.w, h: c.h, name: c.name })),
      })),
      inferred: {
        gapX: isHorizontal ? inferredGapAxis1 : inferredGapAxis2,
        gapY: isHorizontal ? inferredGapAxis2 : inferredGapAxis1,
        padTop, padBottom, padLeft, padRight,
      },
    },
    tailwind: tw.join(" "),
  };
}

// ─── 聚类辅助 ───

function variance(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
}

function clusterAxis(items, key, tolerance) {
  const sorted = [...items].sort((a, b) => a[key] - b[key]);
  const groups = [];
  let current = { start: sorted[0][key], children: [sorted[0]] };
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i][key] - current.start) <= tolerance) {
      current.children.push(sorted[i]);
    } else {
      groups.push(current);
      current = { start: sorted[i][key], children: [sorted[i]] };
    }
  }
  groups.push(current);
  return groups;
}

// ─── 递归编译 ───

/**
 * 递归编译整棵子树。对每个节点根据其是否有 Auto Layout 选择编译策略。
 *
 * @returns {Object} { container: "...", children: [...], depthWarning: bool|null }
 */
export function compileRecursive(node, depth = 1) {
  if (depth > MAX_DEPTH) {
    return {
      name: node.name,
      depth,
      tailwind: null,
      strategy: "SKIPPED",
      reason: `深度超限（>${MAX_DEPTH}），跳过深层嵌套`,
    };
  }

  const hasAutoLayout = !!node.layoutMode;
  const children = Array.isArray(node.children) ? node.children : [];

  let result = {
    name: node.name,
    type: node.type,
    depth,
  };

  if (hasAutoLayout) {
    result.tailwind = compileAutoLayout(node);
    result.strategy = "PURE_DIGITAL";
  } else if (children.length > 0) {
    const coordFlow = compileCoordinateFlow(node);
    result.tailwind = coordFlow.tailwind;
    result.strategy = "COORDINATE_FLOW";
    result.grid = coordFlow.grid;
  } else {
    // 叶子节点
    result.tailwind = leafClasses(node);
    result.strategy = "LEAF";
  }

  // 递归子节点
  if (children.length > 0) {
    result.children = children.map(c => compileRecursive(c, depth + 1));
  }

  // 深度警告
  const maxChildDepth = result.children
    ? Math.max(...result.children.map(c => c.depth || 0))
    : depth;
  if (maxChildDepth >= MAX_DEPTH) {
    result.depthWarning = `子树最深 ${maxChildDepth} 层，部分节点已跳过`;
  }

  return result;
}

// 叶子节点样式
function leafClasses(node) {
  const cls = [];
  if (node.width) {
    const w = px2step(node.width);
    if (w != null) cls.push(`w-${Math.min(w, 96)}`);
  }
  if (node.height) {
    const h = px2step(node.height);
    if (h != null) cls.push(`h-${Math.min(h, 96)}`);
  }
  if (node.text) cls.push("text-ellipsis", "overflow-hidden");
  return cls.join(" ") || "(no layout)";
}

// ─── 多格式输出 ───

const FORMATTERS = {
  tailwind: (cls) => `className="${cls}"`,
  "css-modules": (cls) => {
    const parts = cls.split(/\s+/).filter(Boolean);
    return parts.map(p => `styles.${camelCase(p)}`).join(" ");
  },
  scss: (cls) => {
    const parts = cls.split(/\s+/).filter(Boolean);
    // 将 Tailwind 类名映射为 SCSS 嵌套属性
    const props = [];
    for (const p of parts) {
      const mapped = tailwindToCss(p);
      if (mapped) props.push(`  ${mapped}`);
    }
    if (!props.length) return "// (no layout)";
    return "& {\n" + props.join(";\n") + ";\n}";
  },
  "styled-components": (cls) => {
    const parts = cls.split(/\s+/).filter(Boolean);
    const cssLines = [];
    for (const p of parts) {
      const mapped = tailwindToCss(p);
      if (mapped) cssLines.push(`  ${mapped};`);
    }
    if (!cssLines.length) return "css\`\`";
    return "css\`\n" + cssLines.join("\n") + "\n\`";
  },
};

function tailwindToCss(cls) {
  const map = {
    flex: "display: flex",
    "flex-row": "flex-direction: row",
    "flex-col": "flex-direction: column",
    "flex-wrap": "flex-wrap: wrap",
    "justify-center": "justify-content: center",
    "justify-between": "justify-content: space-between",
    "justify-end": "justify-content: flex-end",
    "items-center": "align-items: center",
    "items-end": "align-items: flex-end",
    "text-ellipsis": "text-overflow: ellipsis",
    "overflow-hidden": "overflow: hidden",
  };
  if (map[cls]) return map[cls];

  // gap-4, pt-4, pb-4, etc.
  const gapMatch = cls.match(/^gap-(\d+)$/);
  if (gapMatch) return `gap: ${gapMatch[1] * STEP}px`;
  const gapX = cls.match(/^gap-x-(\d+)$/);
  if (gapX) return `column-gap: ${gapX[1] * STEP}px`;
  const gapY = cls.match(/^gap-y-(\d+)$/);
  if (gapY) return `row-gap: ${gapY[1] * STEP}px`;
  const pt = cls.match(/^pt-(\d+)$/);
  if (pt) return `padding-top: ${pt[1] * STEP}px`;
  const pb = cls.match(/^pb-(\d+)$/);
  if (pb) return `padding-bottom: ${pb[1] * STEP}px`;
  const pl = cls.match(/^pl-(\d+)$/);
  if (pl) return `padding-left: ${pl[1] * STEP}px`;
  const pr = cls.match(/^pr-(\d+)$/);
  if (pr) return `padding-right: ${pr[1] * STEP}px`;
  const w = cls.match(/^w-(\d+)$/);
  if (w) return `width: ${w[1] * STEP}px`;
  const h = cls.match(/^h-(\d+)$/);
  if (h) return `height: ${h[1] * STEP}px`;

  return null;
}

/**
 * 将编译结果按指定格式输出
 *
 * @param {string} tailwind - 编译输出的 Tailwind 类名
 * @param {'tailwind'|'css-modules'|'scss'|'styled-components'} format
 * @returns {string}
 */
export function formatOutput(tailwind, format = "tailwind") {
  const fn = FORMATTERS[format] || FORMATTERS.tailwind;
  return fn(tailwind || "");
}

export const FORMAT_LIST = Object.keys(FORMATTERS);

// ─── 响应式断点感知 ───

/**
 * 检测兄弟 frame 中的响应式断点
 * 约定：同层级的 frame 如果 name 含 Desktop/Tablet/Mobile 关键字 → 视为同一组件的响应式变体
 *
 * @param {Object[]} siblings - 兄弟节点列表
 * @returns {Object|null} { breakpoints: { desktop: node, tablet: node, mobile: node }, matched: true }
 */
export function detectResponsiveBreakpoints(siblings) {
  if (!Array.isArray(siblings) || siblings.length < 2) return null;

  const BREAKPOINT_PATTERNS = {
    desktop: /\b(desktop|web|pc|xl|wide)\b/i,
    tablet: /\b(tablet|pad|md|medium)\b/i,
    mobile: /\b(mobile|phone|sm|small|narrow)\b/i,
  };

  const matched = {};
  for (const node of siblings) {
    const name = (node.name || "").toLowerCase();
    for (const [bp, re] of Object.entries(BREAKPOINT_PATTERNS)) {
      if (re.test(name) && !matched[bp]) {
        matched[bp] = node;
        break;
      }
    }
  }

  const found = Object.keys(matched);
  if (found.length < 2) return null;

  // 生成 Tailwind 响应式前缀建议
  const prefixMap = { desktop: "", tablet: "md:", mobile: "sm:" };

  return {
    detected: true,
    breakpoints: matched,
    suggestion: found.map(bp => ({
      breakpoint: bp,
      tailwindPrefix: prefixMap[bp],
      targetNode: matched[bp].name,
    })),
  };
}

// ─── 复杂度评分可视化 ───

/**
 * 生成人可读的复杂度评分报告
 */
export function visualizeComplexity(analysis) {
  const { level, strategy, score, hasAutoLayout, depth, absChildren, coordFlowChildren } = analysis;

  // 评分条: 0-30 green, 30-70 yellow, 70-100 red
  const barLength = 20;
  const filled = Math.min(Math.round(score * barLength / 100), barLength);
  const bar = "█".repeat(Math.max(filled, 1)) + "░".repeat(Math.max(barLength - filled, 0));

  const levelIcon = { SIMPLE: "🟢", MODERATE: "🟡", COMPLEX: "🔴" }[level] || "⚪";
  const strategyDesc = {
    PURE_DIGITAL: "纯数字编译（零 Token）",
    SEMANTIC: "坐标流推断 + LLM 语义装配",
    VISUAL: "极度复杂 — 建议源头治理（figma_auto_layoutify）",
  }[strategy] || strategy;

  const viewAbs = absChildren > 0 ? ` | 绝对定位=${absChildren}个` : "";
  const viewCoord = coordFlowChildren > 0 ? ` | 坐标流子节点=${coordFlowChildren}个` : "";
  return [
    `${levelIcon} 复杂度：${level}（${score}/100）`,
    `  [${bar}]`,
    `  策略：${strategy} → ${strategyDesc}`,
    `  详情：Auto Layout=${hasAutoLayout ? "✅" : "❌"} | 深度=${depth}层${viewAbs}${viewCoord}`,
  ].join("\n");
}

// ─── 兼容旧版 analyzeComplexity ───

export function analyzeComplexity(node) {
  const hasAutoLayout = !!node.layoutMode;
  const children = Array.isArray(node.children) ? node.children : [];
  // 绝对定位子节点：仅当显式标记 layoutPositioning="ABSOLUTE" 时才算
  // 没有 Auto Layout 但有 x/y 坐标的子节点由坐标流编译处理，不算"绝对定位"
  const absChildren = children.filter(
    (c) => c.layoutPositioning === "ABSOLUTE"
  ).length;
  // 没有 Auto Layout 但有坐标的子节点数（走坐标流编译）
  const coordFlowChildren = !hasAutoLayout
    ? children.filter((c) => c.x != null && c.y != null).length
    : 0;
  const depth = countDepth(node);

  let score = 0;
  if (!hasAutoLayout) score += 30; // 基础罚分（无 Auto Layout）
  if (absChildren > 0) score += absChildren * 15; // 真正的绝对定位很贵
  // 坐标流子节点：每个 5 分，超过 10 个额外 +20
  if (coordFlowChildren > 0) {
    score += Math.min(coordFlowChildren * 5, 50); // 最多 50
    if (coordFlowChildren > 10) score += 20;
  }
  if (depth > 4) score += (depth - 4) * 8;

  let level, strategy;
  if (score < 35) {
    level = "SIMPLE";
    strategy = "PURE_DIGITAL";
  } else if (score < 75) {
    level = "MODERATE";
    strategy = "SEMANTIC";
  } else {
    level = "COMPLEX";
    strategy = "VISUAL";
  }

  return { level, strategy, score, hasAutoLayout, depth, absChildren, coordFlowChildren };
}

function countDepth(node, d = 1) {
  const children = Array.isArray(node.children) ? node.children : [];
  if (children.length === 0) return d;
  return Math.max(...children.map((c) => countDepth(c, d + 1)));
}
