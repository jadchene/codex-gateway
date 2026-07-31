import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRoots = ["scripts", "test"];
const files = nodeRoots.flatMap((root) => collect(path.join(projectRoot, root)))
  .filter((file) => /\.(?:cjs|mjs)$/.test(file));

const applicationSources = collect(path.join(projectRoot, "src"));
const testSources = collect(path.join(projectRoot, "test"));
const runtimeModuleSources = applicationSources.filter((file) => /\.(?:cjs|mjs)$/.test(file));
if (runtimeModuleSources.length > 0) {
  throw new Error(`src 下不允许保留运行时 CJS/MJS 源码：\n${runtimeModuleSources.join("\n")}`);
}

const legacyTestSources = testSources.filter((file) => /\.test\.mjs$/.test(file)
  || (/\.test\.ts$/.test(file) && fs.readFileSync(file, "utf8").includes('"node:test"')));
if (legacyTestSources.length > 0) {
  throw new Error(`Tests must use Vitest TypeScript instead of node:test MJS:\n${legacyTestSources.join("\n")}`);
}

const transitionalTypecheckAllowlist = new Set();
const unexpectedTypecheckSkips = applicationSources.filter((file) => {
  if (!/\.tsx?$/.test(file) || transitionalTypecheckAllowlist.has(file)) return false;
  return fs.readFileSync(file, "utf8").includes("@ts-nocheck");
});
if (unexpectedTypecheckSkips.length > 0) {
  throw new Error(`发现未授权的 @ts-nocheck：\n${unexpectedTypecheckSkips.join("\n")}`);
}

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}
console.log(`Checked ${files.length} Node scripts; src is TypeScript/TSX and tests use Vitest TypeScript.`);

function collect(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? collect(target) : [target];
  });
}
