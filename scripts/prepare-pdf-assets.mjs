import { readFile, mkdir, cp } from "node:fs/promises";
const root = new URL("../node_modules/pdfjs-dist/", import.meta.url);
const { version } = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const out = new URL(`../public/pdfjs/${version}/`, import.meta.url);
await mkdir(out, { recursive: true });
await cp(
  new URL("build/pdf.worker.min.mjs", root),
  new URL("pdf.worker.min.mjs", out),
);
for (const folder of ["cmaps", "standard_fonts", "wasm"])
  await cp(new URL(folder, root), new URL(folder, out), { recursive: true });
console.log("Prepared local PDF worker and fonts.");
