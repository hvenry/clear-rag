import { defineConfig, devices } from "@playwright/test";

// The browser tests run against the Vite dev server with every /api call answered by
// fixtures in the spec, so they need no backend, no models and no index. A port of
// their own keeps them from colliding with a `make dev` session already on 5173.
const PORT = 5174;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false
  }
});
