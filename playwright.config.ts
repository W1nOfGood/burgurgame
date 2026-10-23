import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/**
 * Multi-client browser tests. Starts a real game server (memory store, test hooks enabled) and
 * the Vite client. Desktop-browser touch emulation supplements — it does not replace — the
 * physical iPad Safari testing required by the spec.
 */
const SERVER_PORT = 2577;
const CLIENT_PORT = 5174;
const preinstalled = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "tests/e2e",
  // Two clients each load the Blender-built art (lightmaps, probes, food, rigs) and compile its
  // shaders in software WebGL, which alone can take a minute per page on a CI runner.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    trace: "retain-on-failure",
    launchOptions: {
      ...(existsSync(preinstalled) && !process.env.PW_USE_BUNDLED ? { executablePath: preinstalled } : {}),
      // Software WebGL2 so the suite runs on GPU-less CI machines.
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    },
  },
  webServer: [
    {
      command: "npx tsx --conditions=source apps/server/src/index.ts",
      url: `http://localhost:${SERVER_PORT}/healthz`,
      env: { PORT: String(SERVER_PORT), ALLOWED_ORIGINS: `http://localhost:${CLIENT_PORT}`, ENABLE_TEST_HOOKS: "1", LOG_LEVEL: "warn" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npm run dev -w @ahb/client -- --port ${CLIENT_PORT}`,
      url: `http://localhost:${CLIENT_PORT}`,
      env: { VITE_REALTIME_URL: `http://localhost:${SERVER_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
