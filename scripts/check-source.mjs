import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["src/main", "scripts", "test"];
const files = roots.flatMap((root) => collect(path.join(projectRoot, root)))
  .filter((file) => /\.(?:cjs|mjs)$/.test(file));

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}
console.log(`Checked ${files.length} Node source files.`);

function collect(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? collect(target) : [target];
  });
}
