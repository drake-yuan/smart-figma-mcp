// compiler.js — 确定性几何编译器 + 复杂度分析（决定走哪条策略）
// 核心：规范 Auto Layout → 纯数学编译，零 LLM、零 token。
// 非标稿 → 不硬吞，返回"源头治理"建议（见 server.js 的 figma_auto_layoutify 引导）。

const STEP = 4; // Tailwind 4px 步长

function px2step(v) {
  if (!v && v !== 0) return null;
  const n = Math.round(v / STEP);
  return n;
}

/**
 * 把单个 Figma 节点的 Auto Layout 几何参数编译成 Tailwind 类名。
 * 纯数学，不猜任何像素。
 */
export function compileFigmaLayout(node) {
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
  if (pt) cls.push(`pt-${pt}`);
  if (pb) cls.push(`pb-${pb}`);
  if (pl) cls.push(`pl-${pl}`);
  if (pr) cls.push(`pr-${pr}`);

  // 主轴对齐
  if (node.primaryAxisAlignItems === "CENTER") cls.push("justify-center");
  if (node.primaryAxisAlignItems === "SPACE_BETWEEN") cls.push("justify-between");
  if (node.counterAxisAlignItems === "CENTER") cls.push("items-center");

  return cls.join(" ");
}

/**
 * 复杂度分析 → 选策略。决定零成本 / 低成本 / 高成本路径。
 */
export function analyzeComplexity(node) {
  const hasAutoLayout = !!node.layoutMode;
  const children = Array.isArray(node.children) ? node.children : [];
  const absChildren = children.filter(
    (c) => c.layoutPositioning === "ABSOLUTE" || (!node.layoutMode && c.x != null)
  ).length;
  const depth = countDepth(node);

  let score = 0;
  if (!hasAutoLayout) score += 50;
  if (absChildren > 0) score += absChildren * 10;
  if (depth > 4) score += (depth - 4) * 8;

  let level, strategy;
  if (score < 30) {
    level = "SIMPLE";
    strategy = "PURE_DIGITAL"; // 零 token
  } else if (score < 70) {
    level = "MODERATE";
    strategy = "SEMANTIC"; // 坐标流 + LLM 装配
  } else {
    level = "COMPLEX";
    strategy = "VISUAL"; // 真正烧钱，且优先建议源头治理
  }

  return { level, strategy, score, hasAutoLayout, depth, absChildren };
}

function countDepth(node, d = 1) {
  const children = Array.isArray(node.children) ? node.children : [];
  if (children.length === 0) return d;
  return Math.max(...children.map((c) => countDepth(c, d + 1)));
}
