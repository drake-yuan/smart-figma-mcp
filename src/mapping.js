// mapping.js — Variant 级映射 + 私有映射资产库 v2（GPT-6 吞不掉的护城河）
//
// @codebase 知道你有 <Button>，但不会精确判断 Figma 节点 = <Button variant="destructive" size="sm">。
// 这里做两件原生工具做不精的细活：
//   1) 把 Figma 组件属性对齐到本地组件的 variant/props
//   2) 把用户确认过的映射沉淀为私有资产(.smart-figma/mappings.json)，换工具就清零 → 切换成本
//
// v2 新增：CVA 解析器、自动扫描组件库、冲突裁决、别名扩展、映射健康检查、导出/导入

import fs from "node:fs";
import path from "node:path";

// ━━━ 语义别名表（Figma 命名习惯 → 代码 variant 习惯）━
const DEFAULT_ALIAS = {
  // 状态
  danger: "destructive", error: "destructive", warning: "secondary", success: "default",
  info: "ghost", disabled: "disabled", active: "default",
  // 尺寸
  small: "sm", medium: "md", large: "lg", xlarge: "xl", tiny: "xs", compact: "sm",
  // 类型
  primary: "default", secondary: "secondary", tertiary: "outline", ghost: "ghost",
  link: "link", text: "ghost", icon: "icon", pill: "default",
  // 变体
  outlined: "outline", filled: "default", tonal: "secondary", plain: "ghost",
  // 对齐
  left: "start", right: "end", center: "center",
};

let ALIAS = { ...DEFAULT_ALIAS };

/** 加载用户自定义别名覆盖 */
export function loadAliases(projectRoot) {
  try {
    const customPath = path.join(projectRoot, ".smart-figma", "aliases.json");
    if (fs.existsSync(customPath)) {
      const custom = JSON.parse(fs.readFileSync(customPath, "utf8"));
      ALIAS = { ...DEFAULT_ALIAS, ...custom };
    }
  } catch {}
}

function normalize(v) {
  const key = String(v).trim().toLowerCase();
  return ALIAS[key] || key;
}

// ━━━ CVA 解析器 ━━━
/** 解析 cva() 调用，提取 variants 定义 */
export function parseCVA(source) {
  const result = { variants: {}, base: "" };
  
  // 提取 base 参数
  const baseMatch = source.match(/cva\(\s*["'`]([^"'`]*)["'`]/);
  if (baseMatch) result.base = baseMatch[1];

  // 提取 variants 对象（处理嵌套花括号）
  const vMatch = source.match(/variants:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/s);
  if (!vMatch) return result;

  const vBlock = vMatch[1];
  const dimRe = /(\w+):\s*\{([^{}]+)\}/g;
  let dim;
  while ((dim = dimRe.exec(vBlock))) {
    result.variants[dim[1]] = [...dim[1].matchAll(/(\w+):/g)]
      ? [...dim[1].replace(/\n/g, " ").matchAll(/(\w+):\s*["'`][^"'`]*["'`]/g)].map(m => m[1])
      : [...dim[2].matchAll(/(\w+):/g)].map(m => m[1]);
  }
  
  // Fallback: 提取 variant 维度名
  if (Object.keys(result.variants).length === 0) {
    const dimRe2 = /(\w+):\s*\{([^}]+)\}/g;
    while ((dim = dimRe2.exec(vBlock))) {
      // 提取值名（key: "value" 或 key 是子 variant）
      const vals = [...dim[2].matchAll(/(\w+):/g)].map(m => m[1]);
      result.variants[dim[1]] = vals.length > 0 ? vals : [];
    }
  }
  
  return result;
}

// ━━━ 自动扫描组件库 ━━━
const KNOWN_LIBS = {
  "shadcn/ui": { glob: "src/components/ui/**/*.tsx", cva: true },
  "radix-ui": { glob: "src/components/ui/**/*.tsx", cva: false },
  "antd": { glob: "src/components/**/*.tsx", cva: false },
  "@mui/material": { glob: "src/components/**/*.tsx", cva: false },
};

/** 扫描项目中的组件依赖 */
function detectComponentLib(projectRoot) {
  try {
    const pkgPath = path.join(projectRoot, "package.json");
    if (!fs.existsSync(pkgPath)) return [];
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Object.keys(KNOWN_LIBS).filter((lib) => deps[lib]);
  } catch { return []; }
}

/** 扫描目录下的 tsx 文件 */
function globTsx(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
        results.push(...globTsx(full));
      } else if (e.isFile() && (e.name.endsWith(".tsx") || e.name.endsWith(".jsx"))) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

/** 从文件名提取组件名 */
function extractComponentName(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  // kebab-case / PascalCase → PascalCase
  return base
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/** 自动扫描组件库，返回组件清单 */
export function scanLocalComponents(projectRoot) {
  const libs = detectComponentLib(projectRoot);
  if (libs.length === 0) return [];

  const components = [];
  const scanDirs = ["src/components/ui", "src/components", "components/ui", "components"];

  for (const dir of scanDirs) {
    const fullDir = path.join(projectRoot, dir);
    if (!fs.existsSync(fullDir)) continue;

    const files = globTsx(fullDir);
    for (const file of files) {
      const name = extractComponentName(file);
      if (!name) continue;

      let source;
      try { source = fs.readFileSync(file, "utf8"); } catch { continue; }

      const hasCVA = source.includes("cva(");
      const cvaInfo = hasCVA ? parseCVA(source) : { variants: {} };

      // 计算相对导入路径
      let importPath = path.relative(path.join(projectRoot, "src"), file);
      importPath = "@/" + importPath.replace(/\\/g, "/").replace(/\.(tsx|jsx)$/, "");

      components.push({
        name,
        importPath,
        file: file,
        variants: cvaInfo.variants,
        hasCVA,
        libs: libs,
      });
    }
  }

  return components;
}

// ━━━ 冲突裁决 ━━━
/** 当多个候选组件匹配时，裁决最佳映射 */
export function resolveMapping(figmaName, figmaProps, candidates) {
  const scored = candidates.map((c) => {
    let score = 0;
    // 精确名匹配
    if (figmaName.toLowerCase() === c.name.toLowerCase()) score += 100;
    else if (figmaName.toLowerCase().includes(c.name.toLowerCase())) score += 50;
    else if (c.name.toLowerCase().includes(figmaName.toLowerCase())) score += 30;

    // 属性维度匹配
    const figKeys = Object.keys(figmaProps || {});
    const candKeys = Object.keys(c.variants || {});
    const overlap = figKeys.filter((k) => candKeys.includes(k)).length;
    score += overlap * 30;

    // 历史命中次数
    score += (c.usageCount || 0) * 10;

    return { ...c, score };
  });

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { conflict: true, candidates: [] };

  const best = scored[0];
  const runnerUp = scored[1];

  // 置信度接近 → 返回多个候选，让 LLM/用户选择
  if (runnerUp && runnerUp.score > best.score * 0.8) {
    return { conflict: true, candidates: scored.slice(0, 3) };
  }

  return { component: best.name, importPath: best.importPath, confidence: best.score / 150, candidates: scored.slice(0, 3) };
}

// ━━━ 核心映射逻辑 ━━━
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

// ━━━ 私有映射资产库（持久化）━

function ledgerPath(projectRoot) {
  return path.join(projectRoot, ".smart-figma", "mappings.json");
}

export function loadMappings(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(projectRoot), "utf8"));
  } catch {
    return { version: 2, mappings: [] };
  }
}

function saveMappings(projectRoot, db) {
  fs.mkdirSync(path.dirname(ledgerPath(projectRoot)), { recursive: true });
  fs.writeFileSync(ledgerPath(projectRoot), JSON.stringify(db, null, 2));
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
  saveMappings(projectRoot, db);
  return db.mappings.length;
}

/** 优先查已沉淀的映射资产（命中则零猜测、零 token） */
export function lookupMapping(projectRoot, figmaComponentKey) {
  const db = loadMappings(projectRoot);
  return db.mappings.find((m) => m.figmaComponentKey === figmaComponentKey) || null;
}

// ━━━ 映射健康检查 ━━━
/** 检查映射资产的引用是否仍然有效 */
export function checkMappingHealth(projectRoot) {
  const db = loadMappings(projectRoot);
  const stale = [];
  for (const m of db.mappings) {
    if (m.importPath && m.importPath.startsWith("@/")) {
      const relPath = m.importPath.replace("@/", "");
      const absPath = path.join(projectRoot, "src", `${relPath}.tsx`);
      if (!fs.existsSync(absPath)) {
        stale.push({ ...m, status: "stale", missingFile: absPath });
      }
    }
  }
  return { total: db.mappings.length, stale: stale.length, staleEntries: stale };
}

// ━━━ 映射导出/导入 ━━━
/** 导出映射资产为 JSON（可用于团队共享、迁移） */
export function exportMappings(projectRoot) {
  return loadMappings(projectRoot);
}

/** 从 JSON 导入映射资产（合并，不覆盖同名条目） */
export function importMappings(projectRoot, data) {
  const db = loadMappings(projectRoot);
  const existingKeys = new Set(db.mappings.map((m) => m.figmaComponentKey));
  let added = 0;
  for (const entry of (data.mappings || [])) {
    if (!existingKeys.has(entry.figmaComponentKey)) {
      db.mappings.push(entry);
      existingKeys.add(entry.figmaComponentKey);
      added++;
    }
  }
  saveMappings(projectRoot, db);
  return { total: db.mappings.length, added };
}
