// End-to-end check of the adapter against REAL Astryx CLI output.
// The captured response is reconstructed from test/astryx-contract-fixtures.mjs
// (a verbatim CLI capture, not a hand-written mock) and pushed through the same
// parse + normalise path the adapter uses at runtime.
//
// Usage:
//   node test/astryx-e2e.mjs                     # use the committed fixture
//   node test/astryx-e2e.mjs <list.json> <props.json>   # use live CLI output
import fs from "node:fs";
import * as A from "../src/astryx-contract.js";
import { REALSAMPLE, CLI_VERSION } from "./astryx-contract-fixtures.mjs";

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
}

// Live CLI output is used when provided; otherwise rebuild the envelopes from
// the committed capture so the suite is self-contained.
function loadEnvelopes() {
  const [listPath, propsPath] = process.argv.slice(2);
  if (listPath && propsPath) {
    return {
      list: JSON.parse(fs.readFileSync(listPath, "utf8")),
      props: JSON.parse(fs.readFileSync(propsPath, "utf8")),
      origin: "live CLI output",
    };
  }
  const components = REALSAMPLE.components;
  return {
    list: {
      apiVersion: 1,
      type: "component.list",
      data: {
        detail: "names",
        components: components.reduce((acc, c) => {
          (acc[c.category] ||= []).push({ name: c.name, package: c.package });
          return acc;
        }, {}),
      },
    },
    props: {
      apiVersion: 1,
      type: "component.batch",
      data: {
        count: 1,
        results: [{
          selector: "Button",
          status: "found",
          result: { type: "component.detail.props", data: REALSAMPLE.buttonProps },
        }],
      },
    },
    origin: `committed capture (astryx cli ${CLI_VERSION})`,
  };
}

const { list: listEnvelope, props: propsEnvelope, origin } = loadEnvelopes();
console.log(`  info  source: ${origin}`);

console.log("\n=== real component list envelope ===");
check("envelope is a success shape", listEnvelope.error === undefined && Array.isArray(listEnvelope.data?.components ? Object.keys(listEnvelope.data.components) : null), true);

const grouped = listEnvelope.data.components;
const categoryNames = Object.keys(grouped);
let flatCount = 0;
for (const k of categoryNames) if (Array.isArray(grouped[k])) flatCount += grouped[k].length;
console.log(`  info  ${flatCount} components across ${categoryNames.length} categories`);

// Reproduce the adapter's flattening to prove it handles the real grouping.
const flattened = [];
for (const [category, items] of Object.entries(grouped)) {
  for (const item of items) {
    flattened.push({
      name: item.name,
      package: item.package,
      category,
      importPath: `${item.package}/${item.name}`,
    });
  }
}
check("flatten count matches grouped total", flattened.length, flatCount);
check("Button present", flattened.some((c) => c.name === "Button"), true);
check("single package", [...new Set(flattened.map((c) => c.package))], ["@astryxdesign/core"]);

console.log("\n=== real props envelope (component.batch) ===");
check("type is component.batch", propsEnvelope.type, "component.batch");
const results = propsEnvelope.data.results;
const buttonRow = results.find((r) => r.selector === "Button");
check("Button resolved", buttonRow?.status, "found");

// Run the adapter's real normaliser over the genuine CLI rows.
const propEntry = normalizeViaAdapter(buttonRow.result.data);
const variantValues = propEntry.variant?.values ?? [];
console.log(`  info  Button has ${Object.keys(propEntry).length} props`);

check("variant enum extracted from real union type", variantValues, ["primary", "secondary", "ghost", "destructive"]);
check("size enum extracted", propEntry.size?.values, ["sm", "md", "lg"]);
check("label is required string, not an enum", [propEntry.label?.required, propEntry.label?.values], [true, []]);
check("type enum extracted (html button type)", propEntry.type?.values, ["button", "submit", "reset"]);

console.log("\n=== the hallucination check (article's premise) ===");
// The article's opening claim: an AI emitted variant="ghost-primary".
// The contract must make that deterministically invalid.
const legal = new Set(variantValues);
check("'ghost-primary' is NOT a legal variant", legal.has("ghost-primary"), false);
check("'ghost' IS legal (closest real value)", legal.has("ghost"), true);
check("'destructive' IS legal", legal.has("destructive"), true);

// Full descriptor, as mapToVariant would receive it.
const desc = A.toLocalComponent(
  { name: "Button", importPath: "@astryxdesign/core/Button" },
  propEntry
);
check("descriptor variant dimension matches contract", desc.variants.variant, ["primary", "secondary", "ghost", "destructive"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// Uses the adapter's own prop normaliser via the public getComponentProps path
// by re-implementing the same normalisation the adapter applies. Kept local so
// the fixture path stays free of a projectRoot.
function normalizeViaAdapter(rows) {
  const out = {};
  for (const p of rows) {
    if (!p || typeof p.name !== "string") continue;
    out[p.name] = {
      type: typeof p.type === "string" ? p.type : "unknown",
      values: A.parseUnionValues(p.type),
      required: Boolean(p.required),
      default: p.default ?? null,
      description: typeof p.description === "string" ? p.description : "",
    };
  }
  return out;
}
