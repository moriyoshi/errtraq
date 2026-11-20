import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["development"] },
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/.agents-workspace/**",
      "**/.pnpm-store/**",
    ],
  },
});
