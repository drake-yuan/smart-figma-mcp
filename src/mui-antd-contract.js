// mui-antd-contract.js — typed design-system contract adapter (.d.ts extraction)
//
// Purpose: give antd / @mui/material the same authoritative-variant treatment
// that shadcn/ui (cva() regex) and Astryx (CLI JSON) already get, so
// mapping.js can feed real variant allow-lists into mapToVariant().
//
// ── Why a third source, not the cva path ──────────────────────────────────
// shadcn/ui is copied into the user's repo as .tsx and declares its variants
// through a cva() call, so parseCVA() can regex them out. antd / mui are NOT
// copied in (you `import { Button } from 'antd'`) and they do NOT use cva,
// so the source-scan path never sees them and currently yields an empty
// variant set. Their real contract, however, ships as TypeScript declaration
// files: `ButtonProps` carries literal-union types such as
//   type?: 'primary' | 'dashed' | 'link' | 'text' | 'default'
// That .d.ts IS the authority — same idea as Astryx's CLI contract, just read
// from the installed package instead of a CLI.
//
// ── Honest scope note ─────────────────────────────────────────────────────
// This is a focused, heuristic .d.ts reader (regex + brace matching), not a
// full type checker. It resolves the two real-world shapes these libs use:
//   - named type aliases:        type ButtonType = 'a' | 'b';  type?: ButtonType
//   - mui's OverridableStringUnion wrapper (which otherwise decays to `string`
//     at the type level and would lose the literals)
// Anything it cannot resolve (callback props, object props, opaque type refs)
// is simply skipped — the dimension is omitted rather than guessed. That keeps
// the determinism guarantee: a value in `variants` is always a literal the
// library actually accepts.

import fs from "node:fs";
import path from "node:path";

// Libraries resolved through this adapter. `components` is the set we enumerate
// (kept small: only components that carry variant-like props matter for mapping).
const TYPED_LIBS = {
  "antd": { pkg: "antd", components: ["Button", "Tag", "Alert"] },
  "@mui/material": { pkg: "@mui/material", components: ["Button", "Chip"] },
};

/** True when a dependency name is handled by this typed-dts adapter. */
export function isTypedLib(lib) {
  return Object.prototype.hasOwnProperty.call(TYPED_LIBS, lib);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Type-alias collection ────────────────────────────────────────────────

/**
 * Collect `type Name = <union-or-ref>;` aliases from a .d.ts source.
 * Object-literal aliases (`type X = { ... }`) are excluded — they are not
 * unions we can project into variant dimensions.
 */
function collectTypeAliases(src) {
  const aliases = {};
  const re = /(?:export\s+)?type\s+([A-Za-z_]\w*)\s*=\s*([^;{}]+);/g;
  let m;
  while ((m = re.exec(src))) {
    aliases[m[1]] = m[2].trim();
  }
  return aliases;
}

// ─── Brace / body extraction ──────────────────────────────────────────────

/** Return the text strictly inside the `{}` that starts at openIdx. */
function extractBraceBody(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return src.slice(openIdx + 1);
}

/**
 * Locate the body of `<Component>Props` — either an `interface` or a `type`
 * alias of an object literal — and return its inner text. Returns null when the
 * component's prop type cannot be found in the source.
 */
function findPropsBody(src, name) {
  const re1 = new RegExp(`(?:export\\s+)?interface\\s+${escapeRe(name)}\\b[^\\{]*\\{`, "s");
  let m = src.match(re1);
  if (m) return extractBraceBody(src, m.index + m[0].length - 1);
  const re2 = new RegExp(`(?:export\\s+)?type\\s+${escapeRe(name)}\\s*=\\s*\\{`, "s");
  m = src.match(re2);
  if (m) return extractBraceBody(src, m.index + m[0].length - 1);
  return null;
}

// ─── Union-literal resolution ─────────────────────────────────────────────

/** Split a type expression on top-level `|`, ignoring those inside `<>`. */
function splitTopLevelUnion(t) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const c of t) {
    if (c === "<") depth++;
    else if (c === ">") depth--;
    if (c === "|" && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * Strip mui's `OverridableStringUnion<...>` wrapper and return its FIRST type
 * argument. `OverridableStringUnion<T, Extra>` resolves at the type level to
 * `T | (string & {})`, so without this we would see `string` and lose T. We
 * only need T, so we peel the wrapper and take the first comma-separated arg.
 */
function unwrapOverridable(t) {
  const m = t.match(/OverridableStringUnion\s*</);
  if (!m) return t;
  const start = m.index + m[0].length - 1; // index of '<'
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (c === "<") depth++;
    else if (c === ">") {
      depth--;
      if (depth === 0) {
        const inner = t.slice(start + 1, i);
        return inner.split(",")[0].trim();
      }
    }
  }
  return t;
}

/**
 * Resolve a prop type expression to its list of string-literal values.
 *
 * - Unwraps OverridableStringUnion.
 * - Follows named type aliases (recursively, cycle-guarded).
 * - Drops bare `string`/`number`/`boolean` and unresolvable type refs.
 *
 * Deliberately conservative: anything it cannot prove is a literal enum is
 * omitted, so a value in the result is always something the library accepts.
 */
function resolveLiteralUnion(typeExpr, aliases, depth = 0) {
  if (depth > 8) return [];
  const t = unwrapOverridable(typeExpr.trim());

  // Single identifier that is a known alias -> follow it.
  if (/^[A-Za-z_]\w*$/.test(t) && aliases[t]) {
    return resolveLiteralUnion(aliases[t], aliases, depth + 1);
  }

  const out = [];
  for (let p of splitTopLevelUnion(t)) {
    p = p.trim();
    if (!p) continue;
    // Non-literal primitives carry no variant information.
    if (p === "string" || p === "number" || p === "boolean" || p === "null" || p === "undefined") continue;
    const lit = p.match(/^['"](.*)['"]$/);
    if (lit) {
      if (!out.includes(lit[1])) out.push(lit[1]);
      continue;
    }
    // An identifier we can still resolve to a literal union.
    if (/^[A-Za-z_]\w*$/.test(p) && aliases[p]) {
      out.push(...resolveLiteralUnion(aliases[p], aliases, depth + 1));
    }
    // Otherwise: an opaque type reference (e.g. PresetColors) -> skip.
  }
  return out;
}

// ─── Public extraction API ────────────────────────────────────────────────

/**
 * Extract the literal-union props of a component from a .d.ts source string.
 *
 * @param {string} dtsSource     raw text of one or more .d.ts files
 * @param {string} [componentName="Button"]  e.g. "Button" -> reads <Button>Props
 * @returns {{[prop:string]: string[]}}  e.g. { type:["primary",...], size:[...] }
 */
export function extractVariantProps(dtsSource, componentName = "Button") {
  if (typeof dtsSource !== "string" || !dtsSource.trim()) return {};
  const aliases = collectTypeAliases(dtsSource);
  const body = findPropsBody(dtsSource, `${componentName}Props`);
  if (!body) return {};

  const variants = {};
  const propRe = /(\w+)\s*\??:\s*([^;]+);/g;
  let m;
  while ((m = propRe.exec(body))) {
    const propName = m[1];
    const typeExpr = m[2].trim();
    const values = resolveLiteralUnion(typeExpr, aliases);
    if (values.length > 0) variants[propName] = values;
  }
  return variants;
}

/** Shape a scanned component into the descriptor mapToVariant() consumes. */
export function toLocalComponentFromDts(componentName, libPkg, variants) {
  return {
    name: componentName,
    importPath: libPkg,
    file: null,
    variants,
    hasCVA: false,
    libs: [libPkg],
    source: "typed-dts",
  };
}

// ─── node_modules resolution ──────────────────────────────────────────────

/** Read all .d.ts files under a directory, recursively, into one string. */
function collectDirDts(dir) {
  const chunks = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return chunks;
  }
  for (const e of entries) {
    if (e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) chunks.push(...collectDirDts(full));
    else if (e.isFile() && e.name.endsWith(".d.ts")) {
      try {
        chunks.push(fs.readFileSync(full, "utf8"));
      } catch {}
    }
  }
  return chunks;
}

/**
 * Locate and read every .d.ts that could describe a component in an installed
 * package. Returns an array of source strings (possibly empty).
 */
function readDtsSources(projectRoot, libPkg, componentName) {
  const base = path.join(projectRoot, "node_modules", ...libPkg.split("/"));
  const compLower = componentName.charAt(0).toLowerCase() + componentName.slice(1);
  const dirs = [
    path.join(base, "es", compLower),
    path.join(base, "lib", compLower),
    path.join(base, compLower),
    path.join(base, componentName),
  ];
  const sources = [];
  for (const d of dirs) {
    const chunks = collectDirDts(d);
    if (chunks.length) sources.push(...chunks);
  }
  return sources;
}

/**
 * Enumerate the supported components of a typed design system installed in the
 * project, with their variant allow-lists populated from the real .d.ts.
 * Returns [] (never throws) when the library is absent or has no resolvable
 * contract — a missing install must not break scanning for the other libs.
 */
export function scanTypedLibComponents(projectRoot, lib) {
  if (!isTypedLib(lib)) return [];
  const cfg = TYPED_LIBS[lib];
  const out = [];
  for (const comp of cfg.components) {
    const sources = readDtsSources(projectRoot, lib, comp);
    if (sources.length === 0) continue;
    const variants = extractVariantProps(sources.join("\n"), comp);
    if (Object.keys(variants).length === 0) continue;
    out.push(toLocalComponentFromDts(comp, lib, variants));
  }
  return out;
}

export { TYPED_LIBS };
