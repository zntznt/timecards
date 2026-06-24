// Zero-dependency web build. Strips TypeScript types (Node's built-in transform)
// and rewrites .ts import specifiers to .js so browsers can load the modules
// natively as ES modules. Output -> /docs (GitHub Pages serves from there).
//
// ponytail: no bundler, no esbuild. Node already does type-stripping; we just
// copy + rewrite. The whole "build" is a few file reads and one regex.

import { stripTypeScriptTypes } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const root = new URL("..", import.meta.url).pathname; // repo root
const out = join(root, "docs");
mkdirSync(out, { recursive: true });
mkdirSync(join(out, "core"), { recursive: true });

// The browser entry pulls in the core modules. We transpile each to .js and
// rewrite imports. Auto-discover every core/*.ts EXCEPT the ones that can't run in
// a browser (sqlite-store imports node:sqlite) or aren't shipped (*.test.ts). This
// avoids the trap of forgetting to add a new core module to a hardcoded list.
const webFiles = ["app.ts", "idb-store.ts"];
const coreFiles = readdirSync(join(root, "core"))
  .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "sqlite-store.ts");

function transpile(srcPath: string, isWebEntry = false): string {
  const ts = readFileSync(srcPath, "utf8");
  const js = stripTypeScriptTypes(ts, { mode: "strip" });
  // Rewrite relative .ts specifiers -> .js (browsers require explicit .js extensions).
  let out = js.replace(/(from\s+["'][^"']+?)\.ts(["'])/g, "$1.js$2");
  // Web entry files live in web/ (so they import ../core), but the build FLATTENS
  // them to the publish root (docs/app.js) next to docs/core/. After flattening,
  // ../core climbs above the publish root — fatal on a subpath host like GitHub
  // Pages (zntznt.com/timecards/). Rewrite ../core -> ./core so it resolves.
  if (isWebEntry) out = out.replace(/(from\s+["'])\.\.\/core\//g, "$1./core/");
  return out;
}

for (const f of coreFiles) {
  writeFileSync(join(out, "core", f.replace(/\.ts$/, ".js")), transpile(join(root, "core", f)));
}
for (const f of webFiles) {
  writeFileSync(join(out, f.replace(/\.ts$/, ".js")), transpile(join(root, "web", f), true));
}

// Static assets copied as-is.
for (const f of ["index.html", "app.css"]) {
  copyFileSync(join(root, "web", f), join(out, f));
}

// GitHub Pages: .nojekyll stops Jekyll from ignoring files, keeps things literal.
writeFileSync(join(out, ".nojekyll"), "");

console.log(`built web -> ${out}`);
console.log("  " + readdirSync(out).join("  "));
