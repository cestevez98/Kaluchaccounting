import { expect, test, type Locator, type Page } from '@playwright/test';

async function selectByText(select: Locator, re: RegExp) {
  await expect(select.locator('option', { hasText: re }).first()).toBeAttached();
  const value = await select.locator('option', { hasText: re }).first().getAttribute('value');
  await select.selectOption(value!);
}

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill('admin@kaluch.local');
  await page.getByLabel('Contraseña').fill('Kaluch-demo-2026');
  await page.getByRole('button', { name: 'Acceder' }).click();
  await expect(page.getByRole('heading', { name: /Hola/ })).toBeVisible();
}

async function fillDate(input: Locator, value: string) {
  await input.fill(value);
  await input.blur();
}

test('registrar un préstamo recibido y devengar su interés', async ({ page }) => {
  await login(page);
  await page.goto('/financiamientos/nuevo');
  await selectByText(page.getByLabel('Prestamista'), /Prestamista demo/);
  await page.getByLabel('Referencia').fill('FI-E2E-1');
  await page.getByLabel('Descripción').fill('Préstamo E2E');
  await fillDate(page.getByLabel('Inicio'), '01/09/2026');
  await fillDate(page.getByLabel('Vencimiento'), '30/09/2026');
  await page.getByLabel('Principal (USD)').fill('4.000');
  await page.getByLabel('Interés total (%)').fill('5');
  await expect(page.getByText('= 200,00 USD')).toBeVisible();
  await page.getByLabel('Cuenta del desembolso').fill('109.9001');
  await page.getByLabel('Cuenta del desembolso').blur();
  await page.getByRole('button', { name: 'Registrar préstamo' }).click();
  await expect(page.getByText('Préstamo FI-E2E-1 registrado.')).toBeVisible();

  await page.goto('/financiamientos');
  await selectByText(page.locator('#lco'), /^KEI/);
  await page.getByLabel('Mes (AAAA-MM)').fill('2026-09');
  await page.getByRole('button', { name: 'Devengar intereses del mes' }).click();
  await expect(page.getByText(/Interés devengado en \d+ préstamos/)).toBeVisible();
  await expect(page.getByRole('row', { name: /FI-E2E-1/ })).toContainText('200,00');
});

test('impuestos ONAT, capital por socio y cierre de mes', async ({ page }) => {
  await login(page);
  await page.goto('/impuestos');
  await expect(page.getByRole('heading', { name: 'Impuestos' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /30\/06\/2026/ })).toBeVisible();

  await page.goto('/capital');
  await expect(page.getByRole('link', { name: 'Socia demo A' }).first()).toBeVisible();

  await page.goto('/cierre');
  await selectByText(page.locator('#co'), /^KEI/);
  await page.getByLabel('Mes (AAAA-MM)').fill('2026-08');
  await expect(page.getByRole('cell', { name: /Interés de préstamos devengado/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /Periodo cerrado/ })).toBeVisible();
});
