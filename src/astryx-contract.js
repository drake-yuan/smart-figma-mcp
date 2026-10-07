// astryx-contract.js — Astryx design-system contract adapter (v1, Beta-aware)
//
// Purpose: turn Astryx's machine-readable CLI contract into the same shape
// scanLocalComponents() already produces, so mapping.js can treat Astryx
// like any other supported component library.
//
// ── Why a CLI adapter and not source parsing ─────────────────────────────
// shadcn/ui exposes variants through a `cva()` call that we regex out of the
// component source. Astryx does not work that way: its component API is
// published as JSON by the CLI, which is strictly better — it is the same
// authority the Astryx team ships for agents, so a mapping we derive from it
// is provably correct rather than heuristically scraped.
//
// ── Verified CLI contract (spiked against @astryxdesign/cli 0.6.5) ───────
//   success envelope : { apiVersion, type, data, meta? }
//   error envelope   : { apiVersion, error, code, suggestions? }
//   manifest --json  -> data.commands[]            (CLI surface, NOT components)
//   component --list -> data.components            -> { <Category>: [{name, package}] }
//   component N... --props --json
//                    -> type "component.batch", data.results[].result.data[]
//                       each prop: { name, type, description, required?, default? }
//
//   `type` on a union prop is a raw TypeScript union of string literals, e.g.
//   "'primary' | 'secondary' | 'ghost' | 'destructive'". Those literals are the
//   authoritative enum values, and they are what we hand to mapToVariant().
//
// ── Beta containment ─────────────────────────────────────────────────────
// Astryx is v0.x and states that breaking changes land per minor release. Two
// consequences drive the design here:
//   1. A malformed or unrecognised payload degrades to an empty contract, never
//      an exception — a stale adapter must not break the existing shadcn path.
//   2. Every contract is stamped with the CLI version it came from, and cached
//      on that version, so a CLI upgrade transparently invalidates the cache.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PKG = "@astryxdesign/core";
const CLI_PKG = "@astryxdesign/cli";

// Cache TTL. The contract is immutable for a given CLI version, so this only
// bounds staleness for local edits; version changes invalidate regardless.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Batch selector cap is a hard server-side limit; stay under it.
const BATCH_LIMIT = 100;

const ASTryxNotInstalled = "astryx_cli_not_installed";
const CoreNotInstalled = "astryx_core_not_installed";
const CliFailed = "astryx_cli_failed";

// ─── Locating the CLI ─────────────────────────────────────────────────────

/**
 * Resolve the Astryx CLI entry inside a consumer project.
 *
 * The published bin path is <pkg>/clients/cli/bin/astryx.mjs. We read the bin
 * field from the installed package rather than hardcoding the string, because
 * that path has already moved once across releases.
 *
 * @returns {string|null} absolute path to astryx.mjs, or null when not found
 */
export function resolveCliEntry(projectRoot) {
  if (!projectRoot) return null;
  const pkgJson = path.join(projectRoot, "node_modules", CLI_PKG, "package.json");
  let rel = "clients/cli/bin/astryx.mjs";
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
    const bin = pkg.bin && (pkg.bin.astryx || pkg.bin.cli);
    if (typeof bin === "string") rel = bin;
  } catch {
    // package.json unreadable: fall back to the documented default path.
  }
  const abs = path.join(projectRoot, "node_modules", CLI_PKG, ...rel.split("/"));
  return fs.existsSync(abs) ? abs : null;
}

/** True when the consumer project depends on @astryxdesign/core. */
export function hasAstryxCore(projectRoot) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
    );
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Boolean(deps[PKG]);
  } catch {
    return false;
  }
}

// ─── CLI invocation ───────────────────────────────────────────────────────

/**
 * Run one Astryx CLI command and return the parsed envelope.
 *
 * Always resolves: a spawn failure or non-JSON output becomes a tagged error
 * rather than a thrown exception, so callers can degrade instead of crashing.
 */
function runCli(projectRoot, args, { timeout = 60000 } = {}) {
  const entry = resolveCliEntry(projectRoot);
  if (!entry) {
    return { ok: false, code: ASTryxNotInstalled, error: `${CLI_PKG} is not installed in this project.` };
  }

  // Re-spawning process.execPath can hit EBUSY on Windows when the host binary
  // is locked (observed with a managed/embedded node runtime). Prefer a plain
  // `node` from PATH, and allow callers to override explicitly.
  const nodeBin = process.env.ASTRYX_NODE_BIN || "node";

  let res;
  try {
    res = spawnSync(nodeBin, [entry, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e) {
    return { ok: false, code: CliFailed, error: `Failed to launch Astryx CLI: ${e.message}` };
  }

  if (res.error) {
    return { ok: false, code: CliFailed, error: res.error.message };
  }

  const stdout = (res.stdout || "").trim();
  if (!stdout) {
    return {
      ok: false,
      code: CliFailed,
      error: (res.stderr || "Astryx CLI produced no output.").trim(),
    };
  }

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { ok: false, code: CliFailed, error: "Astryx CLI output was not valid JSON." };
  }

  // The CLI signals failure with an error envelope, and may still exit 0,
  // so the envelope is the authority — not the exit code.
  if (envelope && envelope.error) {
    return {
      ok: false,
      code: envelope.code || CliFailed,
      error: envelope.error,
      suggestions: envelope.suggestions || [],
    };
  }

  return { ok: true, envelope };
}

// ─── Union-literal parsing ────────────────────────────────────────────────

/**
 * Extract enum values from a TypeScript union-of-string-literals prop type.
 *
 * "'primary' | 'secondary' | 'ghost'" -> ["primary","secondary","ghost"]
 *
 * Deliberately conservative: anything that is not a quoted literal is skipped,
 * so `string | number` yields [] rather than a bogus enum. An empty result
 * means "not an enum prop", which mapToVariant already handles.
 */
export function parseUnionValues(type) {
  if (typeof type !== "string") return [];
  const out = [];
  const re = /'([^']+)'|"([^"]+)"/g;
  let m;
  while ((m = re.exec(type))) {
    const v = m[1] ?? m[2];
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// ─── Cache ────────────────────────────────────────────────────────────────

function cacheDir(projectRoot) {
  return path.join(projectRoot, ".smart-figma");
}

function cacheFile(projectRoot, kind, version) {
  return path.join(cacheDir(projectRoot), `astryx-${kind}-${version || "unknown"}.json`);
}

function readCache(projectRoot, kind, version) {
  if (!version) return null;
  try {
    const file = cacheFile(projectRoot, kind, version);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && parsed.version === version) return parsed.data;
  } catch {
    // A corrupt or absent cache is never fatal; just refetch.
  }
  return null;
}

function writeCache(projectRoot, kind, version, data) {
  if (!version) return;
  try {
    fs.mkdirSync(cacheDir(projectRoot), { recursive: true });
    fs.writeFileSync(cacheFile(projectRoot, kind, version), JSON.stringify({ version, data }, null, 2));
  } catch {
    // Caching is an optimisation; failure must not affect correctness.
  }
}

/** Read the installed Astryx CLI version, or null when unavailable. */
function readCliVersion(projectRoot) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "node_modules", CLI_PKG, "package.json"), "utf8")
    );
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Probe what Astryx support is available in a project.
 * Lets callers distinguish "not using Astryx" from "installed but broken".
 */
export function probeAstryx(projectRoot) {
  const cli = resolveCliEntry(projectRoot);
  const core = hasAstryxCore(projectRoot);
  return {
    cliInstalled: Boolean(cli),
    coreInstalled: core,
    version: readCliVersion(projectRoot),
    // component --list needs core; without it the contract is unobtainable.
    usable: Boolean(cli) && core,
    reason: !cli
      ? ASTryxNotInstalled
      : !core
        ? CoreNotInstalled
        : null,
  };
}

/**
 * Fetch the Astryx CLI contract (commands + global options).
 * Cached per CLI version. This is the machine-readable equivalent of docs.
 */
export function getManifest(projectRoot, { refresh = false } = {}) {
  const version = readCliVersion(projectRoot);
  if (!refresh) {
    const hit = readCache(projectRoot, "manifest", version);
    if (hit) return { ok: true, data: hit, version, cached: true };
  }

  const res = runCli(projectRoot, ["manifest", "--json"]);
  if (!res.ok) return { ...res, version };

  const data = res.envelope && res.envelope.data;
  if (!data || !Array.isArray(data.commands)) {
    return { ok: false, code: CliFailed, error: "Unrecognised manifest payload shape.", version };
  }

  writeCache(projectRoot, "manifest", version, data);
  return { ok: true, data, version, cached: false };
}

/**
 * Fetch the full component list, normalised to a flat array.
 *
 * Output entries are shaped to match scanLocalComponents() so mapping.js can
 * consume both libraries through one code path.
 *
 * @returns {{ok:boolean, components?:Array, categories?:Object, code?:string, error?:string}}
 */
export function listComponents(projectRoot, { refresh = false } = {}) {
  if (!hasAstryxCore(projectRoot)) {
    return { ok: false, code: CoreNotInstalled, error: `${PKG} is not installed in this project.` };
  }

  const version = readCliVersion(projectRoot);
  if (!refresh) {
    const hit = readCache(projectRoot, "components", version);
    if (hit) return { ok: true, ...hit, version, cached: true };
  }

  const res = runCli(projectRoot, ["component", "--list", "--json"]);
  if (!res.ok) return { ...res, version };

  const grouped = res.envelope?.data?.components;
  if (!grouped || typeof grouped !== "object") {
    return { ok: false, code: CliFailed, error: "Unrecognised component-list payload shape.", version };
  }

  // Flatten { Category: [{name, package}] } into one entry per component,
  // preserving the category for grouping and for subpath import resolution.
  const components = [];
  for (const [category, items] of Object.entries(grouped)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item.name !== "string") continue;
      components.push({
        name: item.name,
        package: item.package || PKG,
        category,
        importPath: `${item.package || PKG}/${item.name}`,
        variants: {},
        hasCVA: false,
        source: "astryx",
        libs: [CLI_PKG.replace("/cli", "")],
      });
    }
  }

  const data = { components, categories: Object.keys(grouped) };
  writeCache(projectRoot, "components", version, data);
  return { ok: true, ...data, version, cached: false };
}

/**
 * Fetch props for the named components using batch selectors (<=100 per call).
 *
 * @param {string[]} names component names, e.g. ["Button", "Badge"]
 * @returns {{ok:boolean, props:Object, unresolved:string[], version:string|null}}
 *          props maps component name -> { <propName>: { type, required, values, default } }
 */
export function getComponentProps(projectRoot, names, { refresh = false } = {}) {
  const wanted = [...new Set((names || []).filter((n) => typeof n === "string" && n))];
  const result = { ok: true, props: {}, unresolved: [], version: readCliVersion(projectRoot) };
  if (wanted.length === 0) return result;

  if (!hasAstryxCore(projectRoot)) {
    return { ...result, ok: false, code: CoreNotInstalled, error: `${PKG} is not installed in this project.` };
  }

  for (let i = 0; i < wanted.length; i += BATCH_LIMIT) {
    const batch = wanted.slice(i, i + BATCH_LIMIT);
    const key = batch.join(",");

    if (!refresh) {
      const hit = readCache(projectRoot, `props-${hashKey(key)}`, result.version);
      if (hit) {
        for (const [name, entry] of Object.entries(hit)) {
          if (entry.resolved) result.props[name] = entry.props;
          else result.unresolved.push(name);
        }
        continue;
      }
    }

    const res = runCli(projectRoot, ["component", ...batch, "--props", "--json"]);
    if (!res.ok) {
      // A failed batch is non-fatal: record it and keep whatever else resolved.
      result.unresolved.push(...batch);
      continue;
    }

    const results = res.envelope?.data?.results;
    if (!Array.isArray(results)) {
      result.unresolved.push(...batch);
      continue;
    }

    const cacheEntry = {};
    for (const row of results) {
      const name = row?.selector;
      if (!name) continue;
      if (row.status !== "found" || !row.result?.data) {
        result.unresolved.push(name);
        cacheEntry[name] = { resolved: false };
        continue;
      }
      result.props[name] = normalizeProps(row.result.data);
      cacheEntry[name] = { resolved: true, props: result.props[name] };
    }

    // Names the CLI did not mention at all are unresolved too.
    for (const name of batch) {
      if (!(name in cacheEntry)) {
        result.unresolved.push(name);
        cacheEntry[name] = { resolved: false };
      }
    }

    if (!refresh) {
      writeCache(projectRoot, `props-${hashKey(key)}`, result.version, cacheEntry);
    }
  }

  result.unresolved = [...new Set(result.unresolved)];
  return result;
}

/** Convert raw CLI prop rows into a lookup keyed by prop name. */
function normalizeProps(rows) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const p of rows) {
    if (!p || typeof p.name !== "string") continue;
    out[p.name] = {
      type: typeof p.type === "string" ? p.type : "unknown",
      values: parseUnionValues(p.type),
      required: Boolean(p.required),
      default: p.default ?? null,
      description: typeof p.description === "string" ? p.description : "",
    };
  }
  return out;
}

/** Stable short hash for cache filenames. */
function hashKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ─── Mapping bridge ───────────────────────────────────────────────────────

/**
 * Build a local-component descriptor for a single Astryx component so it can
 * be passed straight into mapToVariant().
 *
 * The `variants` map that mapToVariant() consumes is keyed by dimension, and
 * each dimension holds the allowed literal values. For Astryx that is exactly
 * the set of union-typed props, so we project props -> dimensions here. Enum
 * props become variant dimensions; non-enum props are omitted because
 * mapToVariant() only matches against a known value set.
 */
export function toLocalComponent(component, propEntry) {
  const variants = {};
  if (propEntry) {
    for (const [propName, spec] of Object.entries(propEntry)) {
      if (spec?.values?.length) variants[propName] = spec.values;
    }
  }
  return {
    name: component.name,
    importPath: component.importPath,
    file: null,
    variants,
    hasCVA: false,
    libs: [PKG],
    source: "astryx",
  };
}

/**
 * End-to-end helper: resolve one Astryx component into a descriptor plus its
 * props, ready for mapToVariant(). Never throws.
 */
export function resolveAstryxComponent(projectRoot, name, options = {}) {
  const list = listComponents(projectRoot, options);
  if (!list.ok) return { ok: false, code: list.code, error: list.error };

  const component = list.components.find((c) => c.name === name);
  if (!component) {
    return { ok: false, code: "ERR_UNKNOWN_COMPONENT", error: `Astryx has no component named "${name}".` };
  }

  const props = getComponentProps(projectRoot, [name], options);
  const propEntry = props.ok ? props.props[name] : null;
  return {
    ok: true,
    component: toLocalComponent(component, propEntry),
    version: list.version,
  };
}

export const ASTRYX_ERRORS = {
  CLI_NOT_INSTALLED: ASTryxNotInstalled,
  CORE_NOT_INSTALLED: CoreNotInstalled,
  CLI_FAILED: CliFailed,
};
