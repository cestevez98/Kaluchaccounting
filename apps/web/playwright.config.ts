import { defineConfig, devices } from '@playwright/test';

/**
 * E2E contra API + web reales y una base de datos propia (se recrea en cada ejecución).
 * Puertos distintos a los de desarrollo para no interferir.
 */
const E2E_DB = process.env.E2E_DATABASE_URL ?? 'postgresql://kaluch:kaluch@localhost:5432/kaluch_e2e_test?schema=public';
const API_PORT = 4100;
const WEB_PORT = 3100;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: `http://localhost:${API_PORT}/api/v1/health`,
      env: { DATABASE_URL: E2E_DB, JWT_SECRET: 'e2e-secret', API_PORT: String(API_PORT), WEB_ORIGIN: `http://localhost:${WEB_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec next start -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/login`,
      env: { API_INTERNAL_URL: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
