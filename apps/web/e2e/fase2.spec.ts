import { expect, test, type Locator, type Page } from '@playwright/test';

/** Selecciona la opción cuyo texto cumple la expresión (selectOption no admite RegExp). */
async function selectByText(select: Locator, re: RegExp) {
  await expect(select.locator('option', { hasText: re }).first()).toBeAttached();
  const value = await select.locator('option', { hasText: re }).first().getAttribute('value');
  await select.selectOption(value!);
}

const PASSWORD = 'Kaluch-demo-2026';

async function login(page: Page, email = 'admin@kaluch.local') {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Acceder' }).click();
  await expect(page.getByRole('heading', { name: /Hola/ })).toBeVisible();
}

test('cambio de moneda en caja: se contabiliza con diferencia de cambio', async ({ page }) => {
  await login(page);
  await page.goto('/tesoreria/nuevo');
  await page.getByRole('tab', { name: 'Cambio de moneda' }).click();
  await page.getByLabel('Empresa').last().selectOption({ label: "DM · MPM D'Milio S.U.R.L." });
  await page.getByLabel('Fecha').fill('12/06/2026');
  await page.getByLabel('Fecha').blur();
  await page.getByLabel('Concepto').fill('Cambio E2E de 100 USD');
  await selectByText(page.getByLabel('Sale de'), /Caja USD/);
  await page.getByLabel('Importe que sale').fill('100');
  await selectByText(page.getByLabel('Entra en'), /Caja CUP/);
  await page.getByLabel('Importe que entra').fill('45.000');
  await page.getByRole('button', { name: 'Contabilizar' }).click();
  await expect(page.getByRole('heading', { name: /Movimiento DM-TES-2026-\d{6}/ })).toBeVisible();
  await expect(page.getByText('Cambio de moneda').first()).toBeVisible();
  await expect(page.getByRole('cell', { name: '45.000,00' })).toBeVisible();
  // El asiento generado está enlazado.
  await page.getByRole('link', { name: /DM-2026-\d{6}/ }).first().click();
  await expect(page.getByRole('heading', { name: /Asiento DM-2026-/ })).toBeVisible();
});

test('un pago sin categoría va a la bandeja y se clasifica', async ({ page }) => {
  await login(page);
  await page.goto('/tesoreria/nuevo');
  await page.getByLabel('Empresa').last().selectOption({ label: "DM · MPM D'Milio S.U.R.L." });
  await page.getByLabel('Fecha').fill('13/06/2026');
  await page.getByLabel('Fecha').blur();
  await page.getByLabel('Concepto').fill('Pago pendiente E2E');
  await selectByText(page.getByLabel('Cuenta', { exact: true }), /Caja USD/);
  await page.getByLabel('Tipo').selectOption('OUT');
  await page.getByLabel(/^Importe/).fill('30');
  await page.getByRole('button', { name: 'Contabilizar' }).click();
  await expect(page.getByText('Pendiente de clasificar', { exact: true })).toBeVisible();
  await page.getByLabel('Cuenta').fill('837.0001');
  await page.getByLabel('Cuenta').blur();
  await page.getByRole('button', { name: 'Clasificar', exact: true }).click();
  await expect(page.getByText('Movimiento clasificado')).toBeVisible();
  await expect(page.getByText('Contabilizado', { exact: true })).toBeVisible();
});

test('tesorería muestra saldos por cuenta y la bandeja de revisión', async ({ page }) => {
  await login(page);
  await page.goto('/tesoreria');
  await expect(page.getByRole('row', { name: /Caja CUP.*101\.0001/ })).toBeVisible();
  await expect(page.getByText('Total tesorería')).toBeVisible();
  await page.goto('/tesoreria/revision');
  await expect(page.getByRole('heading', { name: 'Bandeja de revisión' })).toBeVisible();
});

test('conciliación con el Excel y revaluación son accesibles', async ({ page }) => {
  await login(page);
  await page.goto('/conciliacion-bc');
  await expect(page.getByRole('heading', { name: 'Conciliación con el Excel' })).toBeVisible();
  await expect(page.getByText('Todavía no se ha importado el BC del Excel')).toBeVisible();
  await page.goto('/tesoreria/revaluacion');
  await page.getByLabel('Mes').selectOption({ label: 'Junio' });
  await page.getByLabel('Año').fill('2026');
  await page.getByRole('button', { name: /Revaluar y cerrar Junio 2026/ }).click();
  await expect(page.getByText(/Revaluación de Junio 2026 registrada/)).toBeVisible();
});

test('administración: crear un usuario cajero', async ({ page }) => {
  await login(page);
  await page.goto('/admin/usuarios');
  await page.getByLabel('Nombre').fill('Cajero E2E');
  await page.getByLabel('Correo').fill('cajero.e2e@kaluch.local');
  await page.getByLabel(/Contraseña inicial/).fill('Clave-segura-E2E-1');
  await page.getByLabel('Rol en DM').last().selectOption({ label: 'Cajero' });
  await page.getByRole('button', { name: 'Crear usuario' }).click();
  await expect(page.getByText('Usuario cajero.e2e@kaluch.local creado')).toBeVisible();
  await expect(page.getByRole('row', { name: /Cajero E2E/ })).toContainText('DM: Cajero');
});
