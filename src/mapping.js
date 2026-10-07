// mapping.js — variant-level mapping + private mapping asset library v2 (the moat GPT-6 can't eat)
//
// @codebase knows you have a <Button>, but it won't precisely decide that a Figma node
// equals <Button variant="destructive" size="sm">. This module does the two fiddly things
// native tools don't do well:
//   1) align Figma component properties to the local component's variant/props
//   2) persist user-confirmed mappings as a private asset (.smart-figma/mappings.json);
//      switching tools wipes it -> switching cost
//
// v2 additions: CVA parser, component-library auto-scan, conflict resolution,
//               alias expansion, mapping health check, export/import.
// v3 addition: Astryx support — its component API ships as machine-readable
//               CLI JSON rather than an in-source cva() call, so it is resolved
//               through astryx-contract.js instead of the CVA regex path.

import fs from "node:fs";
import path from "node:path";
import { listComponents as listAstryxComponents, getComponentProps as getAstryxProps, probeAstryx } from "./astryx-contract.js";
import { scanTypedLibComponents, isTypedLib } from "./mui-antd-contract.js";

// ━━━ Semantic alias table (Figma naming conventions -> code variant conventions) ━━━
const DEFAULT_ALIAS = {
  // state
  danger: "destructive", error: "destructive", warning: "secondary", success: "default",
  info: "ghost", disabled: "disabled", active: "default",
  // size
  small: "sm", medium: "md", large: "lg", xlarge: "xl", tiny: "xs", compact: "sm",
  // type
  primary: "default", secondary: "secondary", tertiary: "outline", ghost: "ghost",
  link: "link", text: "ghost", icon: "icon", pill: "default",
  // variant
  outlined: "outline", filled: "default", tonal: "secondary", plain: "ghost",
  // alignment
  left: "start", right: "end", center: "center",
};

let ALIAS = { ...DEFAULT_ALIAS };

/** Load user-defined alias overrides. */
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

// ━━━ CVA parser ━━━
/** Parse a cva() call and extract the variants definition. */
export function parseCVA(source) {
  const result = { variants: {}, base: "" };

  // Extract the base argument.
  const baseMatch = source.match(/cva\(\s*["'`]([^"'`]*)["'`]/);
  if (baseMatch) result.base = baseMatch[1];

  // Extract the variants object (handles nested braces).
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

  // Fallback: extract variant dimension names.
  if (Object.keys(result.variants).length === 0) {
    const dimRe2 = /(\w+):\s*\{([^}]+)\}/g;
    while ((dim = dimRe2.exec(vBlock))) {
      // Extract value names (key: "value", or key as a sub-variant).
      const vals = [...dim[2].matchAll(/(\w+):/g)].map(m => m[1]);
      result.variants[dim[1]] = vals.length > 0 ? vals : [];
    }
  }

  return result;
}

// ━━━ Component-library auto-scan ━━━
const KNOWN_LIBS = {
  "shadcn/ui": { glob: "src/components/ui/**/*.tsx", cva: true },
  "radix-ui": { glob: "src/components/ui/**/*.tsx", cva: false },
  // antd / mui do not use cva and live in node_modules, so their contracts are
  // resolved from their shipped .d.ts via mui-antd-contract.js (not from here).
  "antd": { glob: "src/components/**/*.tsx", cva: false, contract: "typed-dts" },
  "@mui/material": { glob: "src/components/**/*.tsx", cva: false, contract: "typed-dts" },
  // Astryx is resolved from its CLI contract, not from local source files.
  "@astryxdesign/core": { glob: null, cva: false, contract: "astryx" },
};

/** Detect component dependencies declared in the project. */
function detectComponentLib(projectRoot) {
  try {
    const pkgPath = path.join(projectRoot, "package.json");
    if (!fs.existsSync(pkgPath)) return [];
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Object.keys(KNOWN_LIBS).filter((lib) => deps[lib]);
  } catch { return []; }
}

/** Recursively collect .tsx/.jsx files under a directory. */
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

/** Derive a component name from a file name. */
function extractComponentName(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  // kebab-case / PascalCase -> PascalCase
  return base
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/** Auto-scan the component library and return a component manifest. */
export function scanLocalComponents(projectRoot) {
  const libs = detectComponentLib(projectRoot);
  if (libs.length === 0) return [];

  // Astryx components live in node_modules and are described by the CLI
  // contract, so they are enumerated separately from the source-scan path.
  const astryx = libs.includes("@astryxdesign/core")
    ? scanAstryxComponents(projectRoot)
    : [];

  // When only Astryx is installed there are no local .tsx files to scan.
  if (libs.length === 1 && libs[0] === "@astryxdesign/core") {
    return astryx;
  }

  const components = [...astryx];
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

      // Compute the relative import path.
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

  // antd / @mui/material ship their variant contract as .d.ts in node_modules,
  // not as cva() calls in the user's source — so they need a third resolution
  // path (mui-antd-contract.js) to yield real allow-lists instead of {}.
  for (const lib of libs) {
    if (!isTypedLib(lib)) continue;
    try {
      components.push(...scanTypedLibComponents(projectRoot, lib));
    } catch {}
  }

  return components;
}

/**
 * Enumerate Astryx components via the CLI contract.
 *
 * Returns [] on any failure: a missing/broken Astryx install must degrade to
 * "no Astryx components" rather than break scanning for the other libraries.
 * `variants` is left empty here and filled on demand by mapAstryxComponent(),
 * because fetching props for 166 components up front would be wasteful.
 */
function scanAstryxComponents(projectRoot) {
  const probe = probeAstryx(projectRoot);
  if (!probe.usable) return [];

  const listed = listAstryxComponents(projectRoot);
  if (!listed.ok || !Array.isArray(listed.components)) return [];

  return listed.components.map((c) => ({
    name: c.name,
    importPath: c.importPath,
    file: null,
    variants: {},
    hasCVA: false,
    libs: ["@astryxdesign/core"],
    category: c.category,
    source: "astryx",
  }));
}

/**
 * Resolve one scanned Astryx component to its authoritative props.
 *
 * This is the step that makes Astryx mapping deterministic: the allowed
 * variant values come from the shipped contract, not from guessing. Returns
 * the component descriptor with `variants` populated, or null when the
 * component or its props cannot be resolved.
 */
export function mapAstryxComponent(projectRoot, component) {
  if (!component) return null;
  const name = typeof component === "string" ? component : component.name;
  if (!name) return null;

  const probe = probeAstryx(projectRoot);
  if (!probe.usable) return null;

  const listed = listAstryxComponents(projectRoot);
  if (!listed.ok) return null;
  const meta = listed.components.find((c) => c.name === name);
  if (!meta) return null;

  const props = getAstryxProps(projectRoot, [name]);
  if (!props.ok) return null;
  const propEntry = props.props[name];
  if (!propEntry) return null;

  // Project union-typed props into the variant dimensions mapToVariant() uses.
  const variants = {};
  for (const [propName, spec] of Object.entries(propEntry)) {
    if (spec?.values?.length) variants[propName] = spec.values;
  }

  return {
    ...meta,
    variants,
    requiredProps: Object.entries(propEntry)
      .filter(([, s]) => s.required)
      .map(([n]) => n),
  };
}

// ━━━ Conflict resolution ━━━
/** When multiple candidate components match, pick the best mapping. */
export function resolveMapping(figmaName, figmaProps, candidates) {
  const scored = candidates.map((c) => {
    let score = 0;
    // Exact name match.
    if (figmaName.toLowerCase() === c.name.toLowerCase()) score += 100;
    else if (figmaName.toLowerCase().includes(c.name.toLowerCase())) score += 50;
    else if (c.name.toLowerCase().includes(figmaName.toLowerCase())) score += 30;

    // Property-dimension overlap.
    const figKeys = Object.keys(figmaProps || {});
    const candKeys = Object.keys(c.variants || {});
    const overlap = figKeys.filter((k) => candKeys.includes(k)).length;
    score += overlap * 30;

    // Historical hit count.
    score += (c.usageCount || 0) * 10;

    return { ...c, score };
  });

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { conflict: true, candidates: [] };

  const best = scored[0];
  const runnerUp = scored[1];

  // Confidence is close -> return multiple candidates and let the LLM/user choose.
  if (runnerUp && runnerUp.score > best.score * 0.8) {
    return { conflict: true, candidates: scored.slice(0, 3) };
  }

  return { component: best.name, importPath: best.importPath, confidence: best.score / 150, candidates: scored.slice(0, 3) };
}

// ━━━ Core mapping logic ━━━
/**
 * Map Figma component properties to the local component's variant props.
 * @param {object} figmaProps      e.g. { State:"Danger", Size:"Small" }
 * @param {object} localComponent  e.g. { name:"Button", importPath:"@/components/ui/button",
 *                                        variants:{ variant:["default","destructive","outline"], size:["sm","md","lg"] } }
 */
export function mapToVariant(figmaProps, localComponent) {
  const props = {};
  let matched = 0;
  let total = 0;

  const variants = localComponent.variants || {};
  for (const [figKey, figVal] of Object.entries(figmaProps || {})) {
    total++;
    const raw = String(figVal).trim().toLowerCase();
    let chosen = null;

    // 1) Exact, case-insensitive membership wins first. This keeps a library's
    //    own real values intact (e.g. antd/mui's literal `primary`) instead of
    //    letting the shadcn-oriented alias table rewrite them.
    for (const [vKey, allowed] of Object.entries(variants)) {
      const hit = allowed.find((a) => String(a).trim().toLowerCase() === raw);
      if (hit) { chosen = { vKey, value: hit }; break; }
    }

    // 2) Alias fallback only when there is no exact match — translates designer
    //    labels (Danger -> destructive, Small -> sm) without corrupting real
    //    library values that happen to collide with an alias key.
    if (!chosen) {
      const aliased = ALIAS[raw];
      if (aliased && aliased !== raw) {
        for (const [vKey, allowed] of Object.entries(variants)) {
          const hit = allowed.find((a) => String(a).trim().toLowerCase() === aliased);
          if (hit) { chosen = { vKey, value: hit }; break; }
        }
      }
    }

    if (chosen) {
      props[chosen.vKey] = chosen.value;
      matched++;
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

// ━━━ Private mapping asset library (persistence) ━━━

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

/** Remember a user-confirmed mapping (high confidence, preferred for reuse). */
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

/** Look up an existing mapping asset first (a hit means zero guessing, zero tokens). */
export function lookupMapping(projectRoot, figmaComponentKey) {
  const db = loadMappings(projectRoot);
  return db.mappings.find((m) => m.figmaComponentKey === figmaComponentKey) || null;
}

// ━━━ Mapping health check ━━━
/** Check whether mapping-asset references are still valid. */
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

// ━━━ Mapping export / import ━━━
/** Export mapping assets as JSON (for team sharing / migration). */
export function exportMappings(projectRoot) {
  return loadMappings(projectRoot);
}

/** Import mapping assets from JSON (merge, do not overwrite existing keys). */
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
