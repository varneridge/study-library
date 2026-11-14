import { defineConfig } from "@playwright/test";

// Design checks only. Run with: npx playwright test -c playwright.design.config.ts
export default defineConfig({
  testDir: "tests/design",
  fullyParallel: true,
  reporter: [["list"]],
  use: { browserName: "chromium", colorScheme: "light" },
});
