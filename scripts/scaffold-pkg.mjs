// One-off helper used to scaffold library packages consistently.
import { mkdirSync, writeFileSync } from "node:fs";
const [dir, name, deps = "", devDeps = "", extra = ""] = process.argv.slice(2);
const toObj = (s) => Object.fromEntries(s.split(",").filter(Boolean).map((d) => {
  const i = d.lastIndexOf("@"); return i > 0 ? [d.slice(0, i), d.slice(i + 1)] : [d, "workspace:*"];
}));
const jsx = extra.includes("jsx");
const pkg = {
  name, version: "0.1.0", private: true, type: "module",
  exports: { ".": { "@platform/source": "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" } },
  scripts: {
    build: "tsc -p tsconfig.build.json",
    typecheck: "tsc -p tsconfig.json --noEmit",
    test: "vitest run --passWithNoTests",
  },
  dependencies: toObj(deps),
  devDependencies: { "@types/node": "^24", typescript: "^7.0.2", vitest: "^5.0.3", ...toObj(devDeps) },
};
mkdirSync(`${dir}/src`, { recursive: true });
writeFileSync(`${dir}/package.json`, JSON.stringify(pkg, null, 2) + "\n");
const co = jsx ? { jsx: "react-jsx", lib: ["es2023", "dom"] } : {};
writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({
  extends: "../../tsconfig.base.json",
  compilerOptions: { noEmit: true, customConditions: ["@platform/source"], ...co },
  include: ["src", "test"],
}, null, 2) + "\n");
writeFileSync(`${dir}/tsconfig.build.json`, JSON.stringify({
  extends: "../../tsconfig.base.json",
  compilerOptions: { outDir: "dist", rootDir: "src", ...co },
  include: ["src"],
}, null, 2) + "\n");
writeFileSync(`${dir}/vitest.config.ts`, `import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["@platform/source", "module", "node"] },
  ssr: { resolve: { conditions: ["@platform/source", "module", "node"] } },
  test: { include: ["test/**/*.test.ts"] },
});
`);
