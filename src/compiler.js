// compiler.js — deterministic geometry compiler (v0.3.0)
//
// Three-tier strategy:
//   PURE_DIGITAL  — clean Auto Layout -> pure math compile, no LLM, no tokens
//   SEMANTIC      — free-form coordinate flow -> grid inference -> structured skeleton + LLM assembly
//   VISUAL        — extremely complex -> suggest source-side fix (figma_auto_layoutify), screenshot fallback as last resort
//
// v0.3.0 additions:
//   - compileCoordinateFlow() coordinate-flow grid inference
//   - compileRecursive() recursive subtree compile (max depth 6)
//   - formatOutput() multiple output formats (tailwind/css-modules/scss/styled-components)
//   - detectResponsiveBreakpoints() responsive breakpoint awareness
//   - visualizeComplexity() human-readable complexity report

const STEP = 4; // Tailwind 4px step
const MAX_DEPTH = 6; // maximum recursion depth

// ─── Utilities ───

function px2step(v) {
  if (!v && v !== 0) return null;
  return Math.round(v / STEP);
}

function camelCase(str) {
  return str.replace(/[-: ]+(.)/g, (_, c) => c.toUpperCase());
}

// Statistical mode.
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

// ─── Tier A: clean Auto Layout -> Tailwind ───

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

  // Size constraints.
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

// Backward-compatible alias.
export const compileFigmaLayout = compileAutoLayout;

// ─── Tier B: free-form coordinate flow -> spatial grid inference ───

/**
 * When a node has no Auto Layout, cluster its direct children's coordinates to
 * infer an implicit row/column layout.
 *
 * @param {Object} node - Figma node (with children and coordinates)
 * @param {Object} parentBox - parent bounds { x, y, width, height } (optional, defaults to the node itself)
 * @returns {Object} { strategy: "COORDINATE_FLOW", grid: {...}, tailwind: "..." }
 */
export function compileCoordinateFlow(node, parentBox) {
  const children = Array.isArray(node.children) ? node.children.filter(
    c => c.x != null && c.y != null
  ) : [];

  if (children.length === 0) {
    return { strategy: "COORDINATE_FLOW", grid: null, tailwind: "", reason: "no valid children" };
  }

  const box = parentBox || { x: node.x || 0, y: node.y || 0 };

  // 1. Relativize coordinates.
  const rel = children.map(c => ({
    ...c,
    relX: Math.round((c.x || 0) - box.x),
    relY: Math.round((c.y || 0) - box.y),
    w: Math.round(c.width || 0),
    h: Math.round(c.height || 0),
  }));

  // 2. Determine the main axis from X/Y variance (horizontal vs vertical arrangement).
  const xVals = rel.map(c => c.relX);
  const yVals = rel.map(c => c.relY);
  const xVariance = variance(xVals);
  const yVariance = variance(yVals);

  // X variance much larger than Y variance -> horizontal; otherwise vertical.
  const isHorizontal = xVariance > yVariance * 2;

  // 3. Cluster.
  const TOLERANCE = 4;
  const rows = clusterAxis(rel, isHorizontal ? "relY" : "relX", TOLERANCE);

  // 4. Sort within each row.
  for (const row of rows) {
    row.children.sort((a, b) => isHorizontal ? a.relX - b.relX : a.relY - b.relY);
    // Use the max height/width as the row height / column width.
    row.size = Math.max(...row.children.map(c => isHorizontal ? c.h : c.w));
    row.start = row.children[0][isHorizontal ? "relY" : "relX"];
  }

  // 5. Infer spacing.
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

  // 6. Infer padding.
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

  // 7. Generate Tailwind.
  const tw = [];
  tw.push("flex", isHorizontal ? "flex-col" : "flex-row"); // note: clustering axis -> flex direction is the opposite
  if (isHorizontal) {
    // Each row arranges children horizontally -> flex-row inside; rows stack with flex-col.
    // clustered by Y -> children within a row are arranged horizontally.
    tw.push("flex-col"); // rows stack vertically
    if (inferredGapAxis2 != null) {
      const g = px2step(inferredGapAxis2);
      if (g != null) tw.push(`gap-y-${g}`);
    }
  } else {
    // clustered by X -> children within a column are arranged vertically.
    tw.push("flex-row"); // columns stack horizontally
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

// ─── Clustering helpers ───

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

// ─── Recursive compile ───

/**
 * Recursively compile the whole subtree. For each node, pick a compile strategy
 * based on whether it uses Auto Layout.
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
      reason: `depth limit exceeded (>${MAX_DEPTH}); skipping deep nesting`,
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
    // Leaf node.
    result.tailwind = leafClasses(node);
    result.strategy = "LEAF";
  }

  // Recurse into children.
  if (children.length > 0) {
    result.children = children.map(c => compileRecursive(c, depth + 1));
  }

  // Depth warning.
  const maxChildDepth = result.children
    ? Math.max(...result.children.map(c => c.depth || 0))
    : depth;
  if (maxChildDepth >= MAX_DEPTH) {
    result.depthWarning = `subtree reaches ${maxChildDepth} levels; some nodes were skipped`;
  }

  return result;
}

// Leaf-node classes.
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

// ─── Multi-format output ───

const FORMATTERS = {
  tailwind: (cls) => `className="${cls}"`,
  "css-modules": (cls) => {
    const parts = cls.split(/\s+/).filter(Boolean);
    return parts.map(p => `styles.${camelCase(p)}`).join(" ");
  },
  scss: (cls) => {
    const parts = cls.split(/\s+/).filter(Boolean);
    // Map Tailwind class names to SCSS nested properties.
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
 * Output the compiled result in the requested format.
 *
 * @param {string} tailwind - the compiled Tailwind class names
 * @param {'tailwind'|'css-modules'|'scss'|'styled-components'} format
 * @returns {string}
 */
export function formatOutput(tailwind, format = "tailwind") {
  const fn = FORMATTERS[format] || FORMATTERS.tailwind;
  return fn(tailwind || "");
}

export const FORMAT_LIST = Object.keys(FORMATTERS);

// ─── Responsive breakpoint awareness ───

/**
 * Detect responsive breakpoints among sibling frames.
 * Convention: sibling frames whose names contain Desktop/Tablet/Mobile keywords are
 * treated as responsive variants of the same component.
 *
 * @param {Object[]} siblings - list of sibling nodes
 * @returns {Object|null} { breakpoints: { desktop, tablet, mobile }, matched: true }
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

  // Suggest Tailwind responsive prefixes.
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

// ─── Complexity score visualization ───

/**
 * Produce a human-readable complexity report.
 */
export function visualizeComplexity(analysis) {
  const { level, strategy, score, hasAutoLayout, depth, absChildren, coordFlowChildren } = analysis;

  // Score bar: 0-30 green, 30-70 yellow, 70-100 red.
  const barLength = 20;
  const filled = Math.min(Math.round(score * barLength / 100), barLength);
  const bar = "█".repeat(Math.max(filled, 1)) + "░".repeat(Math.max(barLength - filled, 0));

  const levelIcon = { SIMPLE: "🟢", MODERATE: "🟡", COMPLEX: "🔴" }[level] || "⚪";
  const strategyDesc = {
    PURE_DIGITAL: "pure-digital compile (zero tokens)",
    SEMANTIC: "coordinate-flow inference + LLM semantic assembly",
    VISUAL: "very complex — suggest source-side fix (figma_auto_layoutify)",
  }[strategy] || strategy;

  const viewAbs = absChildren > 0 ? ` | absolute-positioned=${absChildren}` : "";
  const viewCoord = coordFlowChildren > 0 ? ` | coordinate-flow children=${coordFlowChildren}` : "";
  return [
    `${levelIcon} Complexity: ${level} (${score}/100)`,
    `  [${bar}]`,
    `  Strategy: ${strategy} -> ${strategyDesc}`,
    `  Details: Auto Layout=${hasAutoLayout ? "✅" : "❌"} | depth=${depth} levels${viewAbs}${viewCoord}`,
  ].join("\n");
}

// ─── analyzeComplexity (backward compatible) ───

export function analyzeComplexity(node) {
  const hasAutoLayout = !!node.layoutMode;
  const children = Array.isArray(node.children) ? node.children : [];
  // Absolute-positioned children: counted only when explicitly tagged layoutPositioning="ABSOLUTE".
  // Children with x/y but no Auto Layout are handled by the coordinate-flow compiler, not counted as "absolute".
  const absChildren = children.filter(
    (c) => c.layoutPositioning === "ABSOLUTE"
  ).length;
  // Number of children with coordinates but no Auto Layout (handled by coordinate-flow compile).
  const coordFlowChildren = !hasAutoLayout
    ? children.filter((c) => c.x != null && c.y != null).length
    : 0;
  const depth = countDepth(node);

  let score = 0;
  if (!hasAutoLayout) score += 30; // base penalty (no Auto Layout)
  if (absChildren > 0) score += absChildren * 15; // true absolute positioning is expensive
  // Coordinate-flow children: 5 points each, +20 extra beyond 10.
  if (coordFlowChildren > 0) {
    score += Math.min(coordFlowChildren * 5, 50); // capped at 50
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
