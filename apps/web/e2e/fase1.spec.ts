import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'Kaluch-demo-2026';

async function login(page: Page, email = 'admin@kaluch.local') {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Acceder' }).click();
  await expect(page.getByRole('heading', { name: /Hola/ })).toBeVisible();
}

test('redirige a la pantalla de acceso y rechaza credenciales incorrectas', async ({ page }) => {
  await page.goto('/balance');
  await expect(page).toHaveURL(/\/login\?next=%2Fbalance/);
  await page.getByLabel('Correo electrónico').fill('admin@kaluch.local');
  await page.getByLabel('Contraseña').fill('incorrecta');
  await page.getByRole('button', { name: 'Acceder' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveText('Correo o contraseña incorrectos');
});

test('el panel muestra el control de cuadre del grupo', async ({ page }) => {
  await login(page);
  await expect(page.getByText('Cuadre del balance')).toBeVisible();
  await expect(page.getByText('Cuadra', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Empresa')).toHaveValue('');
});

test('crear un asiento multimoneda, verlo en el diario y anularlo', async ({ page }) => {
  await login(page);
  await page.goto('/diario/nuevo');
  await page.getByLabel('Empresa').last().selectOption({ label: "DM · MPM D'Milio S.U.R.L." });
  await page.getByLabel('Fecha').fill('10/06/2026');
  await page.getByLabel('Fecha').blur();
  await page.getByLabel('Descripción').fill('Venta minorista E2E');

  await page.getByLabel('Cuenta línea 1').fill('101.0001');
  await page.getByLabel('Cuenta línea 1').blur();
  await expect(page.getByLabel('Moneda línea 1')).toHaveValue('CUP');
  await page.getByLabel('Debe línea 1').fill('40.000');

  await page.getByLabel('Cuenta línea 2').fill('900.0001');
  await page.getByLabel('Cuenta línea 2').blur();
  await page.getByLabel('Moneda línea 2').selectOption('CUP');
  await page.getByLabel('Haber línea 2').fill('40.000');
  await expect(page.getByText('Cuadra', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Contabilizar' }).click();
  await expect(page.getByRole('heading', { name: /Asiento DM-2026-\d{6}/ })).toBeVisible();
  await expect(page.getByText('Contabilizado')).toBeVisible();
  await expect(page.getByRole('cell', { name: /101\.0001/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: '40.000,00' })).toHaveCount(2);

  await page.getByRole('button', { name: 'Anular' }).click();
  await page.getByRole('button', { name: 'Confirmar anulación' }).click();
  await expect(page.getByText('Anulación', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/anula DM-2026-/)).toBeVisible();
});

test('un asiento descuadrado muestra el error del motor en español', async ({ page }) => {
  await login(page);
  await page.goto('/diario/nuevo');
  await page.getByLabel('Descripción').fill('Descuadre');
  await page.getByLabel('Fecha').fill('11/06/2026');
  await page.getByLabel('Fecha').blur();
  await page.getByLabel('Cuenta línea 1').fill('101.0002');
  await page.getByLabel('Cuenta línea 1').blur();
  await page.getByLabel('Debe línea 1').fill('100');
  await page.getByLabel('Cuenta línea 2').fill('900.0001');
  await page.getByLabel('Cuenta línea 2').blur();
  await page.getByLabel('Haber línea 2').fill('90');
  await page.getByRole('button', { name: 'Contabilizar' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toContainText('El asiento no cuadra: diferencia de 10.0000 USD');
});

test('balance de comprobación con formato es-ES y exportación a Excel', async ({ page }) => {
  await login(page);
  await page.goto('/balance');
  await page.getByLabel('Mes').selectOption({ label: 'Mayo' });
  await page.getByLabel('Año').fill('2026');
  const row = page.getByRole('row', { name: /109\.9001/ });
  await expect(row).toContainText('33.000,00');
  await expect(page.getByText(/^Cuadra/)).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Exportar a Excel' }).click();
  expect((await download).suggestedFilename()).toBe('BC-2026-05.xlsx');
});

test('plan de cuentas: árbol con búsqueda', async ({ page }) => {
  await login(page);
  await page.goto('/plan-de-cuentas');
  await page.getByPlaceholder('Buscar por código o nombre').fill('tenencia');
  await expect(page.getByRole('row', { name: /846\.0001/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /925\.0001/ })).toBeVisible();
});

test('un usuario de solo lectura no ve acciones de escritura', async ({ page }) => {
  await login(page, 'lectura@kaluch.local');
  await page.goto('/diario');
  await expect(page.getByRole('link', { name: 'Nuevo asiento' })).toHaveCount(0);
  await expect(page.getByLabel('Empresa')).toContainText('KEI');
  await expect(page.getByLabel('Empresa')).not.toContainText('DM ·');
});
