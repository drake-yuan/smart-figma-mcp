// Ad-hoc verification of the Astryx adapter's pure logic (no CLI spawn).
import * as A from "../src/astryx-contract.js";

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
}

console.log("=== parseUnionValues ===");
check("Button.variant real union", A.parseUnionValues("'primary' | 'secondary' | 'ghost' | 'destructive'"),
  ["primary", "secondary", "ghost", "destructive"]);
check("Button.size", A.parseUnionValues("'sm' | 'md' | 'lg'"), ["sm", "md", "lg"]);
check("Button.type", A.parseUnionValues("'button' | 'submit' | 'reset'"), ["button", "submit", "reset"]);
check("plain string -> empty", A.parseUnionValues("string"), []);
check("non-literal union -> empty", A.parseUnionValues("string | number | readonly string[]"), []);
check("undefined -> empty", A.parseUnionValues(undefined), []);
check("null -> empty", A.parseUnionValues(null), []);
check("dedupes repeats", A.parseUnionValues("'a' | 'a' | 'b'"), ["a", "b"]);

console.log("\n=== toLocalComponent (props -> variants projection) ===");
const btn = A.toLocalComponent(
  { name: "Button", importPath: "@astryxdesign/core/Button" },
  {
    label: { type: "string", values: [], required: true },
    variant: { type: "'primary' | 'secondary'", values: ["primary", "secondary"] },
    size: { type: "'sm' | 'md'", values: ["sm", "md"] },
  }
);
check("name", btn.name, "Button");
check("importPath uses per-category subpath", btn.importPath, "@astryxdesign/core/Button");
check("enum props become variant dimensions", btn.variants, { variant: ["primary", "secondary"], size: ["sm", "md"] });
check("non-enum prop excluded", "label" in btn.variants, false);
check("hasCVA false", btn.hasCVA, false);
check("source tagged", btn.source, "astryx");

console.log("\n=== toLocalComponent edge cases ===");
check("null props -> empty variants", A.toLocalComponent({ name: "X", importPath: "@x" }, null).variants, {});
check("empty props -> empty variants", A.toLocalComponent({ name: "X", importPath: "@x" }, {}).variants, {});

console.log("\n=== probeAstryx on a project without Astryx ===");
const bare = A.probeAstryx("D:/Research/Kiro/smart-figma-mcp");
check("bare project not usable", bare.usable, false);
check("bare project reason tagged", bare.reason, "astryx_cli_not_installed");
check("bare project coreInstalled false", bare.coreInstalled, false);

console.log("\n=== listComponents degrades cleanly when core missing ===");
const degraded = A.listComponents("D:/Research/Kiro/smart-figma-mcp");
check("degrades to ok:false", degraded.ok, false);
check("degrades with code, no throw", typeof degraded.code, "string");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
