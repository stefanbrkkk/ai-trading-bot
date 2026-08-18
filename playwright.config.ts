import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * The Chromium to drive, if a specific one has to be named.
 *
 * The image this was developed in ships a Chromium that does not match what
 * `@playwright/test` would download, so the path was pinned outright. That made
 * `npm run e2e` — and therefore `npm run verify` — pass only on that machine:
 * anywhere else Playwright was handed a path that does not exist and failed
 * before the first test. A handed-over repository whose verification command
 * cannot run is not verifiable by the person receiving it.
 *
 * So the pin is now conditional. `CHROMIUM_PATH` wins if set; the image's build
 * is used when it is actually present; otherwise nothing is specified and
 * Playwright uses its own managed browser, which `npx playwright install
 * chromium` provides.
 */
function resolveChromium(): string | null {
  const candidates = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  /** Trains the ensemble into `.data/e2e` if it is not already there. */
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    viewport: { width: 1600, height: 1000 },
    colorScheme: 'dark',
  },
  /**
   * The image ships a Chromium build that does not match what this
   * `@playwright/test` version would download, and downloading is neither possible
   * nor desirable in a sealed environment. Naming the binary explicitly is the
   * documented escape hatch. `CHROMIUM_PATH` overrides it so the suite still runs
   * on a machine where Playwright manages its own browsers.
   */
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Only pinned when that exact build is present. On any other machine
          // Playwright's own managed browser is used, so `npm run e2e` works
          // after `npx playwright install chromium` without touching this file.
          ...(resolveChromium() ? { executablePath: resolveChromium() as string } : {}),
        },
      },
    },
  ],
  webServer: {
    command: `npm run start -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'production',
      AURELIUS_DATA_DIR: '.data/e2e',
      AURELIUS_SEED: '424242',
    },
  },
});
