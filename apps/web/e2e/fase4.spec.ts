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

test('emitir una factura de exportación, verla pendiente y cerrarla', async ({ page }) => {
  await login(page);
  await page.goto('/ventas/exportacion/nueva');
  await selectByText(page.getByLabel('Cliente', { exact: true }), /Cliente exportación demo/);
  await page.getByLabel('Nº de factura').fill('KAL-E2E-001');
  await fillDate(page.getByLabel('Fecha de factura'), '01/08/2026');
  await page.getByLabel('Descripción').fill('Contenedor E2E');
  await page.getByLabel('Importe facturado (USD)').fill('12.000,00');
  await page.getByLabel('Fábrica').fill('8.000');
  await page.getByLabel('Logística').fill('1.500');
  await expect(page.getByText(/Margen estimado: 2\.500,00 USD/)).toBeVisible();
  await page.getByRole('button', { name: 'Emitir factura' }).click();
  await expect(page.getByText(/Factura emitida \(KEI-FEX-2026-\d{6}\)/)).toBeVisible();

  await page.goto('/ventas');
  const row = page.getByRole('row', { name: /KAL-E2E-001/ });
  await expect(row.getByText('Pendiente de cierre')).toBeVisible();
  await row.getByRole('link', { name: 'KAL-E2E-001' }).click();
  await expect(page.getByRole('heading', { name: 'Factura KAL-E2E-001' })).toBeVisible();
  await fillDate(page.getByLabel('Fecha de cierre'), '31/08/2026');
  await page.getByRole('button', { name: 'Cerrar factura' }).click();
  await expect(page.getByText(/Cerrada el 31\/08\/2026/)).toBeVisible();
  await expect(page.getByRole('cell', { name: /900\.8880/ })).toBeVisible();
});

test('contenedor demo: utilidad, venta de distribución y comisiones', async ({ page }) => {
  await login(page);
  await page.goto('/inventario');
  await page.getByRole('link', { name: 'CONT-DEMO-01' }).click();
  await expect(page.getByRole('heading', { name: 'Contenedor CONT-DEMO-01' })).toBeVisible();
  await expect(page.getByText('En almacén', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Inversionista demo' })).toBeVisible();

  await page.goto('/ventas/distribucion/nueva');
  await selectByText(page.locator('#company'), /^GR/);
  await selectByText(page.getByLabel('Cliente', { exact: true }), /Cliente distribución demo/);
  await fillDate(page.getByLabel('Fecha', { exact: true }), '15/09/2026');
  await page.getByLabel('Descripción').fill('Venta E2E');
  await selectByText(page.getByLabel('Lote 1'), /Aceite vegetal 1 L · CONT-DEMO-01/);
  await page.getByLabel('Cantidad 1').fill('10');
  await page.getByLabel('Precio 1').fill('95');
  await page.getByLabel('Comisión 1').fill('2');
  await selectByText(page.getByLabel('Vendedor 1'), /Vendedor demo/);
  await page.getByRole('button', { name: 'Contabilizar factura' }).click();
  await expect(page.getByText(/Factura GR-FAC-2026-\d{6} contabilizada por 950,00 USD/)).toBeVisible();

  await page.goto('/ventas/comisiones');
  await page.getByLabel('Desde').fill('01/09/2026');
  await page.getByLabel('Desde').blur();
  await page.getByLabel('Hasta').fill('30/09/2026');
  await page.getByLabel('Hasta').blur();
  await expect(page.getByRole('link', { name: 'Vendedor demo' })).toBeVisible();

  await page.goto('/inventario/productos');
  await page.getByRole('link', { name: 'Aceite vegetal 1 L' }).click();
  await expect(page.getByRole('heading', { name: /Kardex · Aceite vegetal 1 L/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Venta' }).first()).toBeVisible();
});
