// figma-normalizer.js — Figma REST API 响应 → compiler.js 可识别格式
//
// 将 Figma API v2 返回的嵌套 JSON 规范化为 compiler.js / mapping.js 所期望的扁平结构。
// 处理：坐标标准化、Auto Layout 属性映射、组件属性提取、递归子树遍历。

/**
 * 将 Figma API 节点响应规范化为编译器输入格式
 *
 * 输入：figmaGetNode() 的返回值（通常结构为 { nodes: { "1:2": { document: {...} } }, ... }
 *       或直接的节点 JSON）
 * 输出：{}
 *   name, type, componentKey?, componentProperties?
 *   x, y, width, height                     ← 来自 absoluteBoundingBox
 *   layoutMode: "HORIZONTAL" | "VERTICAL" | null
 *   paddingLeft, paddingRight, paddingTop, paddingBottom
 *   itemSpacing
 *   primaryAxisAlignItems, counterAxisAlignItems
 *   children: [normalized child, ...]       ← 递归
 */
export function normalizeNode(raw) {
  // 处理 Figma API nodes 端点返回的包装结构 { nodes: { ... } }
  let node = raw;
  if (raw.nodes && !raw.type) {
    const keys = Object.keys(raw.nodes);
    if (keys.length === 1) node = raw.nodes[keys[0]].document || raw.nodes[keys[0]];
    else {
      // 多个节点 → 返回列表
      return Object.entries(raw.nodes).map(([id, n]) => normalizeOne(n.document || n, id));
    }
  }
  return normalizeOne(node);
}

function normalizeOne(node, overrideId) {
  if (!node || typeof node !== "object") return null;

  const out = {
    id: overrideId || node.id,
    name: node.name,
    type: node.type,
  };

  // 坐标：来自 absoluteBoundingBox
  if (node.absoluteBoundingBox) {
    out.x = Math.round(node.absoluteBoundingBox.x);
    out.y = Math.round(node.absoluteBoundingBox.y);
    out.width = Math.round(node.absoluteBoundingBox.width);
    out.height = Math.round(node.absoluteBoundingBox.height);
  }

  // Auto Layout 属性
  if (node.layoutMode && node.layoutMode !== "NONE") {
    out.layoutMode = node.layoutMode; // "HORIZONTAL" | "VERTICAL"
    out.paddingLeft = node.paddingLeft ?? 0;
    out.paddingRight = node.paddingRight ?? 0;
    out.paddingTop = node.paddingTop ?? 0;
    out.paddingBottom = node.paddingBottom ?? 0;
    out.itemSpacing = node.itemSpacing ?? 0;
    out.primaryAxisAlignItems = node.primaryAxisAlignItems;
    out.counterAxisAlignItems = node.counterAxisAlignItems;
    out.layoutWrap = node.layoutWrap;
    if (node.counterAxisSpacing != null) out.counterAxisSpacing = node.counterAxisSpacing;
  }

  // 组件属性（Figma 变体 → 本地 CVA 映射的关键入口）
  if (node.componentPropertyDefinitions) {
    out.componentProperties = {};
    for (const [key, def] of Object.entries(node.componentPropertyDefinitions)) {
      if (def.type === "VARIANT" && def.defaultValue !== undefined) {
        out.componentProperties[key] = def.defaultValue;
      }
    }
  }

  // 组件标识
  if (node.componentId) out.componentKey = node.componentId;

  // 样式信息
  if (node.style) out.style = { ...node.style };
  if (node.fills && node.fills.length) out.fills = node.fills.slice(0, 3); // 只取前3个
  if (node.strokes && node.strokes.length) out.strokes = node.strokes.slice(0, 1);
  if (node.effects && node.effects.length) out.effects = node.effects;
  if (node.cornerRadius != null) out.cornerRadius = node.cornerRadius;

  // 文本内容
  if (node.characters) out.text = node.characters;
  if (node.style?.fontSize) out.fontSize = node.style.fontSize;
  if (node.style?.fontFamily) out.fontFamily = node.style.fontFamily;

  // 递归子节点
  if (node.children && node.children.length) {
    out.children = node.children.map(c => normalizeOne(c)).filter(Boolean);
  }

  return out;
}

/**
 * 规范化文件元数据（文件名、pages、frames 列表）
 */
export function normalizeFileMeta(raw) {
  const pages = (raw.document?.children || []).map(page => ({
    id: page.id,
    name: page.name,
    type: page.type,
    frameCount: (page.children || []).length,
    frames: (page.children || []).map(frame => ({
      id: frame.id,
      name: frame.name,
      type: frame.type,
      width: Math.round(frame.absoluteBoundingBox?.width || 0),
      height: Math.round(frame.absoluteBoundingBox?.height || 0),
    })),
  }));

  return {
    name: raw.name,
    lastModified: raw.lastModified,
    version: raw.version,
    pages,
  };
}
