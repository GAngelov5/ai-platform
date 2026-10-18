import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["@platform/source", "module", "node"] },
  ssr: { resolve: { conditions: ["@platform/source", "module", "node"] } },
  test: { include: ["test/**/*.test.ts"] },
});
