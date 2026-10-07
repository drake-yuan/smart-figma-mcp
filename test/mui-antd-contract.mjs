// mui-antd-contract.test.mjs — contract extraction for antd / @mui/material
//
// Hermetic: reads committed .d.ts fixtures and builds a fake node_modules tree
// in a temp dir, so it never depends on an actual antd/mui install or network.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractVariantProps,
  toLocalComponentFromDts,
  scanTypedLibComponents,
  isTypedLib,
} from "../src/mui-antd-contract.js";
import { mapToVariant } from "../src/mapping.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "fixtures");

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✅ ${name}`);
}

// ─── 1. antd: alias resolution + literal unions ─────────────────────────────
const antdSrc = fs.readFileSync(path.join(FIX, "antd-button.d.ts"), "utf8");
const antdVariants = extractVariantProps(antdSrc, "Button");

ok("antd resolves type via ButtonType alias", JSON.stringify(antdVariants.type) === JSON.stringify(["default", "primary", "dashed", "link", "text"]));
ok("antd resolves size literals", JSON.stringify(antdVariants.size) === JSON.stringify(["large", "middle", "small"]));
ok("antd resolves shape literals", JSON.stringify(antdVariants.shape) === JSON.stringify(["default", "circle", "round"]));
ok("antd drops boolean prop (disabled)", !("disabled" in antdVariants));
ok("antd drops callback prop (onClick)", !("onClick" in antdVariants));

// ─── 2. mui: OverridableStringUnion + inline literal union ──────────────────
const muiSrc = fs.readFileSync(path.join(FIX, "mui-button.d.ts"), "utf8");
const muiVariants = extractVariantProps(muiSrc, "Button");

ok("mui variant via alias+OverridableStringUnion", JSON.stringify(muiVariants.variant) === JSON.stringify(["text", "outlined", "contained"]));
ok("mui color not contaminated with 'string'", !muiVariants.color.includes("string") && JSON.stringify(muiVariants.color) === JSON.stringify(["inherit", "primary", "secondary", "success", "error", "info", "warning"]));
ok("mui size resolved", JSON.stringify(muiVariants.size) === JSON.stringify(["small", "medium", "large"]));
ok("mui inline literal union (loadingPosition)", JSON.stringify(muiVariants.loadingPosition) === JSON.stringify(["center", "end", "start"]));
ok("mui drops boolean prop (disabled)", !("disabled" in muiVariants));

// ─── 3. descriptor shape matches mapToVariant's expectations ────────────────
const antdButton = toLocalComponentFromDts("Button", "antd", antdVariants);
ok("descriptor has name/importPath/variants/source", antdButton.name === "Button" && antdButton.importPath === "antd" && antdButton.source === "typed-dts" && Array.isArray(antdButton.variants.type));

// ─── 4. zero-hallucination: valid passes, out-of-range dropped ──────────────
const inRange = mapToVariant({ type: "primary" }, antdButton);
ok("valid antd value maps through", inRange.props.type === "primary" && inRange.confidence === 1);

const outOfRange = mapToVariant({ type: "ghost-primary" }, antdButton);
ok("out-of-range antd value is dropped (no hallucination)", outOfRange.props.type === undefined && outOfRange.confidence === 0);

// ─── 4b. alias fallback still works for shadcn-style libraries ───────────────
// After the exact-match-first change, the alias table must still translate
// designer labels when the library has no matching literal of its own.
const shadcnButton = toLocalComponentFromDts("Button", "shadcn/ui", {
  variant: ["default", "destructive", "outline", "secondary", "ghost", "link"],
  size: ["sm", "md", "lg"],
});
const dangerMapped = mapToVariant({ variant: "Danger" }, shadcnButton);
ok("alias fallback: Figma 'Danger' -> shadcn 'destructive'", dangerMapped.props.variant === "destructive");
const smallMapped = mapToVariant({ size: "Small" }, shadcnButton);
ok("alias fallback: Figma 'Small' -> shadcn 'sm'", smallMapped.props.size === "sm");
const primaryShadcn = mapToVariant({ variant: "Primary" }, shadcnButton);
ok("alias fallback: Figma 'Primary' -> shadcn 'default'", primaryShadcn.props.variant === "default");

// ─── 5. isTypedLib guard ────────────────────────────────────────────────────
ok("isTypedLib recognises antd & mui", isTypedLib("antd") && isTypedLib("@mui/material") && !isTypedLib("shadcn/ui"));

// ─── 6. scanTypedLibComponents against a fake node_modules tree ─────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smart-figma-typed-"));
try {
  const antdDir = path.join(tmp, "node_modules", "antd", "es", "button");
  fs.mkdirSync(antdDir, { recursive: true });
  fs.writeFileSync(path.join(antdDir, "button.d.ts"), antdSrc);

  const muiDir = path.join(tmp, "node_modules", "@mui", "material", "Button");
  fs.mkdirSync(muiDir, { recursive: true });
  fs.writeFileSync(path.join(muiDir, "Button.d.ts"), muiSrc);

  const antdScanned = scanTypedLibComponents(tmp, "antd");
  ok("scanTypedLibComponents finds antd Button", antdScanned.length >= 1 && antdScanned[0].name === "Button" && antdScanned[0].variants.type.length === 5);

  const muiScanned = scanTypedLibComponents(tmp, "@mui/material");
  ok("scanTypedLibComponents finds mui Button", muiScanned.some((c) => c.name === "Button" && c.variants.variant.includes("contained")));

  ok("scanTypedLibComponents returns [] for absent lib dir", scanTypedLibComponents(tmp, "@mui/material").length >= 1 && scanTypedLibComponents(path.join(tmp, "empty"), "@mui/material").length === 0);
  ok("scanTypedLibComponents ignores non-typed lib", scanTypedLibComponents(tmp, "shadcn/ui").length === 0);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} assertions passed.`);
