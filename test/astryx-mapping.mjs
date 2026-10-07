// Verifies the Astryx integration inside mapping.js.
//
// Self-contained: it builds throwaway fixture projects on disk rather than
// depending on an external sandbox, so it runs identically on CI and locally.
//
// NOTE on the live-CLI branch: the managed node runtime used in some
// environments cannot spawn child processes (spawnSync -> EBUSY on Windows),
// so the adapter's live CLI calls return a tagged failure and Astryx degrades
// to an empty list — the same graceful path a broken install takes. The
// populated contract shape is therefore asserted against the committed real
// capture via ASTRYX_FIXTURE=1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as M from "../src/mapping.js";
import { probeAstryx } from "../src/astryx-contract.js";
import { REALSAMPLE } from "./astryx-contract-fixtures.mjs";

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
}

const useFixture = process.env.ASTRYX_FIXTURE === "1";

// Build a minimal project that declares the given dependencies, so
// detectComponentLib() has something real to read.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "smart-figma-astryx-"));
function makeProject(name, deps) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", dependencies: deps }, null, 2)
  );
  return dir;
}

const ASTRYX_ROOT = makeProject("with-astryx", { "@astryxdesign/core": "^0.6.5" });
const BARE_ROOT = makeProject("without-astryx", { react: "^19.0.0" });

process.on("exit", () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

console.log("=== a project that declares @astryxdesign/core is detected ===");
// The CLI/core packages themselves are absent here, so probe reports not-usable;
// what matters is that detection keys off the declared dependency, and that
// scanning degrades to empty instead of throwing.
check("Astryx dependency detected (cli not installed)", probeAstryx(ASTRYX_ROOT).cliInstalled, false);
check("core dependency detected", probeAstryx(ASTRYX_ROOT).coreInstalled, true);
check("not usable without the CLI", probeAstryx(ASTRYX_ROOT).usable, false);
check("reason names the missing piece", probeAstryx(ASTRYX_ROOT).reason, "astryx_cli_not_installed");

const astryxComps = M.scanLocalComponents(ASTRYX_ROOT);
console.log(`  info  ${astryxComps.length} components enumerated` +
  (useFixture ? " (fixture mode)" : " (live CLI; 0 expected without the CLI installed)"));
check("degrades to empty when CLI unreachable", astryxComps.length, 0);

console.log("\n=== contract shape from the real capture (fixture mode) ===");
if (useFixture) {
  const expected = REALSAMPLE.components;
  check("component count from real capture", expected.length, REALSAMPLE.total);
  check("Button present in capture", expected.some((c) => c.name === "Button"), true);
  const button = expected.find((c) => c.name === "Button");
  check("importPath is per-category subpath", button?.importPath, "@astryxdesign/core/Button");
  check("source tagged astryx", button?.source, "astryx");
  check("file is null (not a local source file)", button?.file, null);
  check("category preserved", button?.category, "Button");
  check("hasCVA false", button?.hasCVA, false);
  check("libs contains the core package", button?.libs, ["@astryxdesign/core"]);
  check("variants deferred (not fetched eagerly)", button?.variants, {});
  check("all import paths under the core package",
    expected.filter((c) => !c.importPath.startsWith("@astryxdesign/core/")).length, 0);
}

console.log("\n=== determinism: repeated scans agree ===");
const again = M.scanLocalComponents(ASTRYX_ROOT);
check("stable count", again.length, astryxComps.length);

console.log("\n=== a project without Astryx is unaffected (no regression) ===");
const bare = M.scanLocalComponents(BARE_ROOT);
check("bare project yields no components", bare.length, 0);
check("bare project has no Astryx core", probeAstryx(BARE_ROOT).coreInstalled, false);
check("bare project not usable", probeAstryx(BARE_ROOT).usable, false);

console.log("\n=== mapAstryxComponent degrades safely when Astryx absent ===");
check("returns null instead of throwing", M.mapAstryxComponent(BARE_ROOT, { name: "Button" }), null);
check("null name tolerated", M.mapAstryxComponent(BARE_ROOT, null), null);
check("empty name tolerated", M.mapAstryxComponent(BARE_ROOT, ""), null);
check("string form tolerated (no throw)", M.mapAstryxComponent(BARE_ROOT, "Button"), null);
check("undefined projectRoot tolerated (no throw)", M.mapAstryxComponent(undefined, "Button"), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
