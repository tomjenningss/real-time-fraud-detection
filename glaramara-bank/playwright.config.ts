import { defineConfig, devices } from "@playwright/test";

const port = 3100;
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL?.trim();
const baseURL = externalBaseURL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["line"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL,
    channel: "chrome",
    colorScheme: "light",
    locale: "en-GB",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chrome",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile-chrome",
      use: {
        channel: "chrome",
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    },
  ],
  webServer: externalBaseURL
    ? undefined
    : {
        command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
        env: {
          DATABASE_URL:
            process.env.DATABASE_URL ?? "postgresql://playwright:playwright@127.0.0.1:1/not-used",
          GLARAMARA_SESSION_SECRET:
            process.env.GLARAMARA_SESSION_SECRET ??
            "phase-b-playwright-only-session-secret-000000000000",
          GLARAMARA_PUBLIC_ORIGIN: baseURL,
          GLARAMARA_COOKIE_SECURE: "false",
        },
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        url: baseURL,
      },
});
