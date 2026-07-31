import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/preload/index.ts" },
  format: ["cjs"],
  outDir: "dist/preload",
  outExtension: () => ({ js: ".cjs" }),
  platform: "node",
  target: "node24",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  ignoreWatch: ["**/.runtime/**", "**/data/**", "**/release/**"],
  external: ["electron"]
});
