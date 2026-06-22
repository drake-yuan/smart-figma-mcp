// figma-normalizer.js — Figma REST API response -> compiler.js input format
//
// Normalizes the nested JSON returned by the Figma REST API (v1) into the flat
// structure expected by compiler.js / mapping.js.
// Handles: coordinate normalization, Auto Layout property mapping, component
// property extraction, and recursive subtree traversal.

/**
 * Normalize a Figma API node response into compiler input format.
 *
 * Input:  the return value of figmaGetNode() (typically shaped like
 *         { nodes: { "1:2": { document: {...} } }, ... }), or a raw node JSON.
 * Output: an object with
 *   name, type, componentKey?, componentProperties?
 *   x, y, width, height                     <- from absoluteBoundingBox
 *   layoutMode: "HORIZONTAL" | "VERTICAL" | null
 *   paddingLeft, paddingRight, paddingTop, paddingBottom
 *   itemSpacing
 *   primaryAxisAlignItems, counterAxisAlignItems
 *   children: [normalized child, ...]       <- recursive
 */
export function normalizeNode(raw) {
  // Handle the wrapper returned by the Figma API nodes endpoint: { nodes: { ... } }.
  let node = raw;
  if (raw.nodes && !raw.type) {
    const keys = Object.keys(raw.nodes);
    if (keys.length === 1) node = raw.nodes[keys[0]].document || raw.nodes[keys[0]];
    else {
      // Multiple nodes -> return a list.
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

  // Coordinates: from absoluteBoundingBox.
  if (node.absoluteBoundingBox) {
    out.x = Math.round(node.absoluteBoundingBox.x);
    out.y = Math.round(node.absoluteBoundingBox.y);
    out.width = Math.round(node.absoluteBoundingBox.width);
    out.height = Math.round(node.absoluteBoundingBox.height);
  }

  // Auto Layout properties.
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

  // Component properties (the key entry point for Figma variant -> local CVA mapping).
  if (node.componentPropertyDefinitions) {
    out.componentProperties = {};
    for (const [key, def] of Object.entries(node.componentPropertyDefinitions)) {
      if (def.type === "VARIANT" && def.defaultValue !== undefined) {
        out.componentProperties[key] = def.defaultValue;
      }
    }
  }

  // Component identity.
  if (node.componentId) out.componentKey = node.componentId;

  // Style information.
  if (node.style) out.style = { ...node.style };
  if (node.fills && node.fills.length) out.fills = node.fills.slice(0, 3); // keep first 3 only
  if (node.strokes && node.strokes.length) out.strokes = node.strokes.slice(0, 1);
  if (node.effects && node.effects.length) out.effects = node.effects;
  if (node.cornerRadius != null) out.cornerRadius = node.cornerRadius;

  // Text content.
  if (node.characters) out.text = node.characters;
  if (node.style?.fontSize) out.fontSize = node.style.fontSize;
  if (node.style?.fontFamily) out.fontFamily = node.style.fontFamily;

  // Recurse into children.
  if (node.children && node.children.length) {
    out.children = node.children.map(c => normalizeOne(c)).filter(Boolean);
  }

  return out;
}

/**
 * Normalize file metadata (file name, pages, frame list).
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
