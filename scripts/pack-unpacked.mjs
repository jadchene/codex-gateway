import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(projectRoot, "release");
const outputDir = path.join(releaseRoot, "win-unpacked");
const electronExecutable = require("electron");
const electronDist = path.dirname(electronExecutable);

if (path.dirname(outputDir) !== releaseRoot || path.dirname(releaseRoot) !== projectRoot) {
  throw new Error(`拒绝清理非预期打包目录：${outputDir}`);
}
if (!fs.existsSync(path.join(projectRoot, "dist", "renderer", "index.html"))) {
  throw new Error("缺少 renderer 构建产物，请先运行 npm run build。");
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(releaseRoot, { recursive: true });
fs.cpSync(electronDist, outputDir, { recursive: true });

const sourceExecutable = path.join(outputDir, path.basename(electronExecutable));
const targetExecutable = path.join(outputDir, "Codex Gateway.exe");
fs.renameSync(sourceExecutable, targetExecutable);

const resourcesDir = path.join(outputDir, "resources");
fs.rmSync(path.join(resourcesDir, "default_app.asar"), { force: true });
const appDir = path.join(resourcesDir, "app");
fs.mkdirSync(path.join(appDir, "dist"), { recursive: true });
fs.mkdirSync(path.join(appDir, "src"), { recursive: true });
fs.cpSync(path.join(projectRoot, "dist", "renderer"), path.join(appDir, "dist", "renderer"), { recursive: true });
fs.cpSync(path.join(projectRoot, "src", "main"), path.join(appDir, "src", "main"), { recursive: true });
fs.mkdirSync(path.join(appDir, "node_modules"), { recursive: true });
fs.cpSync(path.join(projectRoot, "node_modules", "ws"), path.join(appDir, "node_modules", "ws"), { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
fs.writeFileSync(path.join(appDir, "package.json"), `${JSON.stringify({
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  license: manifest.license,
  main: manifest.main,
  dependencies: { ws: manifest.dependencies.ws }
}, null, 2)}\n`, "utf8");

console.log(`Unpacked application created: ${outputDir}`);
