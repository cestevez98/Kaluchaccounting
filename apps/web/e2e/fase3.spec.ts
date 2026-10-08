import { expect, test, type Locator, type Page } from '@playwright/test';

async function selectByText(select: Locator, re: RegExp) {
  await expect(select.locator('option', { hasText: re }).first()).toBeAttached();
  const value = await select.locator('option', { hasText: re }).first().getAttribute('value');
  await select.selectOption(value!);
}

async function login(page: Page, email = 'admin@kaluch.local') {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill('Kaluch-demo-2026');
  await page.getByRole('button', { name: 'Acceder' }).click();
  await expect(page.getByRole('heading', { name: /Hola/ })).toBeVisible();
}

async function fillDate(input: Locator, value: string) {
  await input.fill(value);
  await input.blur();
}

test('registrar una factura de proveedor y verla en cuentas por pagar', async ({ page }) => {
  await login(page);
  await page.goto('/terceros/documento?tipo=factura');
  await expect(page.getByRole('heading', { name: 'Registrar factura de proveedor' })).toBeVisible();
  await page.getByLabel('Contraparte', { exact: true }).fill('Proveedor');
  await page.getByRole('button', { name: /Proveedor demo/ }).click();
  await expect(page.getByLabel('Contraparte: cuenta corriente')).toBeVisible();
  await fillDate(page.getByLabel('Fecha', { exact: true }), '15/09/2026');
  await page.getByLabel(/^Importe/).fill('2.500,00');
  await page.getByLabel('Contrapartida').fill('814.0001');
  await page.getByLabel('Contrapartida').blur();
  await page.getByLabel('Concepto').fill('Flete E2E');
  await page.getByLabel(/Referencia/).fill('E2E-FAC-1');
  await page.getByRole('button', { name: 'Contabilizar' }).click();
  await expect(page.getByText(/Documento KEI-CTE-2026-\d{6} contabilizado/)).toBeVisible();

  await page.goto('/pagar/partidas');
  await expect(page.getByRole('cell', { name: 'E2E-FAC-1' })).toBeVisible();
  await page.goto('/pagar');
  await expect(page.getByRole('link', { name: 'Proveedor demo S.L.' }).first()).toBeVisible();
});

test('cargo a una contraparte y su estado de cuenta', async ({ page }) => {
  await login(page);
  await page.goto('/terceros');
  await page.getByRole('link', { name: 'Contraparte demo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Contraparte demo', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Cargo / abono' }).click();
  await expect(page.getByLabel('Contraparte: cuenta corriente')).toBeVisible();
  await fillDate(page.getByLabel('Fecha', { exact: true }), '02/09/2026');
  await page.getByLabel(/^Importe/).fill('750');
  await page.getByLabel('Contrapartida').fill('900.0001');
  await page.getByLabel('Contrapartida').blur();
  await page.getByLabel('Concepto').fill('Envío E2E');
  await page.getByRole('button', { name: 'Contabilizar' }).click();
  await page.getByRole('link', { name: 'Ver estado de cuenta' }).click();
  await expect(page.getByText('Estado de cuenta en USD')).toBeVisible();
  await expect(page.getByRole('cell', { name: /Envío E2E/ })).toBeVisible();
  await page.getByRole('button', { name: 'Partidas abiertas' }).click();
  await expect(page.getByLabel('Estado')).toBeVisible();
});

test('nómina de un trabajador', async ({ page }) => {
  await login(page);
  await page.goto('/rrhh/nueva');
  await selectByText(page.getByLabel('Trabajador'), /Trabajadora demo/);
  await page.getByLabel('Periodo (AAAA-MM)').fill('2026-09');
  await fillDate(page.getByLabel('Fecha', { exact: true }), '30/09/2026');
  await page.getByLabel('Salario', { exact: true }).fill('300');
  await page.getByLabel('Descuento asistencia').fill('20');
  await page.getByRole('button', { name: 'Contabilizar nómina' }).click();
  await expect(page.getByText(/Nómina DM-NOM-2026-\d{6} contabilizada/)).toBeVisible();
  await page.goto('/rrhh');
  await expect(page.getByRole('cell', { name: '280,00' }).first()).toBeVisible();
});

test('cuentas por cobrar y reclasificación por signo', async ({ page }) => {
  await login(page);
  await page.goto('/cobrar');
  await expect(page.getByRole('heading', { name: 'Cuentas por cobrar' })).toBeVisible();
  await expect(page.getByText('Antigüedad de partidas abiertas')).toBeVisible();
  await page.goto('/terceros/reclasificacion');
  await page.getByLabel('Empresa', { exact: true }).last().selectOption({ label: "DM · MPM D'Milio S.U.R.L." });
  await page.getByLabel('Mes').selectOption({ label: 'Septiembre' });
  await page.getByLabel('Año').fill('2026');
  await page.getByRole('button', { name: 'Reclasificar' }).click();
  await expect(page.getByText(/reclasificados|No había nada que reclasificar/)).toBeVisible();
});
