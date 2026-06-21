// mapping.js — Variant 级映射 + 私有映射资产库（GPT-6 吞不掉的护城河）
//
// @codebase 知道你有 <Button>，但不会精确判断 Figma 节点 = <Button variant="destructive" size="sm">。
// 这里做两件原生工具做不精的细活：
//   1) 把 Figma 组件属性对齐到本地组件的 variant/props
//   2) 把用户确认过的映射沉淀为私有资产(.smart-figma/mappings.json)，换工具就清零 → 切换成本

import fs from "node:fs";
import path from "node:path";

// 语义别名表：Figma 命名习惯 → 代码 variant 习惯
const ALIAS = {
  danger: "destructive",
  error: "destructive",
  primary: "default",
  small: "sm",
  medium: "md",
  large: "lg",
};

function normalize(v) {
  const key = String(v).trim().toLowerCase();
  return ALIAS[key] || key;
}

/**
 * 把 Figma 组件属性映射到本地组件的 variant props。
 * @param {object} figmaProps      例：{ State:"Danger", Size:"Small" }
 * @param {object} localComponent  例：{ name:"Button", importPath:"@/components/ui/button",
 *                                        variants:{ variant:["default","destructive","outline"], size:["sm","md","lg"] } }
 */
export function mapToVariant(figmaProps, localComponent) {
  const props = {};
  let matched = 0;
  let total = 0;

  const variants = localComponent.variants || {};
  for (const [figKey, figVal] of Object.entries(figmaProps || {})) {
    total++;
    const normVal = normalize(figVal);
    // 找一个本地 variant 维度的取值集合命中
    for (const [vKey, allowed] of Object.entries(variants)) {
      if (allowed.map(normalize).includes(normVal)) {
        props[vKey] = allowed.find((a) => normalize(a) === normVal);
        matched++;
        break;
      }
    }
  }

  const confidence = total === 0 ? 0.5 : matched / total;
  return {
    component: localComponent.name,
    importPath: localComponent.importPath,
    props,
    confidence: Number(confidence.toFixed(2)),
  };
}

// ---- 私有映射资产库（持久化） ----

function ledgerPath(projectRoot) {
  return path.join(projectRoot, ".smart-figma", "mappings.json");
}

export function loadMappings(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(projectRoot), "utf8"));
  } catch {
    return { version: 1, mappings: [] };
  }
}

/** 记住一条用户确认过的映射（高置信，优先复用） */
export function rememberMapping(projectRoot, entry) {
  const db = loadMappings(projectRoot);
  const idx = db.mappings.findIndex((m) => m.figmaComponentKey === entry.figmaComponentKey);
  if (idx >= 0) {
    db.mappings[idx] = { ...db.mappings[idx], ...entry, usageCount: (db.mappings[idx].usageCount || 0) + 1 };
  } else {
    db.mappings.push({ ...entry, verifiedBy: "user", usageCount: 1 });
  }
  fs.mkdirSync(path.dirname(ledgerPath(projectRoot)), { recursive: true });
  fs.writeFileSync(ledgerPath(projectRoot), JSON.stringify(db, null, 2));
  return db.mappings.length;
}

/** 优先查已沉淀的映射资产（命中则零猜测、零 token） */
export function lookupMapping(projectRoot, figmaComponentKey) {
  const db = loadMappings(projectRoot);
  return db.mappings.find((m) => m.figmaComponentKey === figmaComponentKey) || null;
}
