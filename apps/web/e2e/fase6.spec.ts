import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill('admin@kaluch.local');
  await page.getByLabel('Contraseña').fill('Kaluch-demo-2026');
  await page.getByRole('button', { name: 'Acceder' }).click();
  await expect(page.getByRole('heading', { name: /Hola/ })).toBeVisible();
}

test('estados financieros: situación que cuadra, resultados y flujo de efectivo', async ({ page }) => {
  await login(page);
  await page.goto('/estados?code=ES&year=2026&from=1&to=9');
  await expect(page.getByRole('heading', { name: 'Estado de situación' })).toBeVisible();
  const control = page.getByRole('row', { name: /Diferencia ACTIVOS/ });
  await expect(control).toBeVisible();
  // La línea de control es 0 en todas las columnas.
  await expect(control.locator('td.num').filter({ hasNotText: /^0,00$/ })).toHaveCount(0);
  // Una línea de cuentas se despliega con su detalle.
  await page.getByRole('button', { name: /600 Capital/ }).click();
  await expect(page.getByRole('cell', { name: /600\.0001/ })).toBeVisible();

  await page.getByRole('tab', { name: 'ER' }).click();
  await expect(page.getByRole('heading', { name: 'Estado de resultados' })).toBeVisible();
  await expect(page.getByRole('row', { name: /RESULTADO DEL PERÍODO/ })).toBeVisible();

  await page.getByRole('tab', { name: 'EFE' }).click();
  await expect(page.getByRole('heading', { name: 'Estado de flujo de efectivo' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Diferencia \(debe ser 0\)/ }).locator('td.num').filter({ hasNotText: /^0,00$/ })).toHaveCount(0);
});

test('diseñador: añadir una línea de fórmula y verla en el estado', async ({ page }) => {
  await login(page);
  await page.goto('/estados/disenador?code=ER');
  await expect(page.getByRole('heading', { name: 'Diseñador de estados financieros' })).toBeVisible();
  await page.getByLabel('Copiar como').fill('ER_E2E');
  await page.getByRole('button', { name: 'Crear copia' }).click();
  await expect(page.getByText('Plantilla ER_E2E creada.')).toBeVisible();
  await page.getByRole('button', { name: 'Añadir línea al final' }).click();
  const last = page.getByRole('row').last();
  await last.getByLabel('Clave').fill('MARGEN');
  await last.getByLabel('Texto').fill('Margen calculado E2E');
  await last.getByLabel('Origen').selectOption('FORMULA');
  await last.getByLabel('Fórmula').fill('[INGRESOS]+');
  await expect(last.getByText('La fórmula está incompleta')).toBeVisible();
  await last.getByLabel('Fórmula').fill('[INGRESOS]+[GASTOS]');
  await page.getByRole('button', { name: 'Guardar plantilla' }).click();
  await expect(page.getByText('Plantilla guardada.')).toBeVisible();
  await page.getByRole('link', { name: 'Ver el estado' }).click();
  await expect(page.getByRole('row', { name: /Margen calculado E2E/ })).toBeVisible();
});

test('panel de dirección con resultado mensual, antigüedad y alertas', async ({ page }) => {
  await login(page);
  await expect(page.getByText(/Resultado mensual 20\d\d/)).toBeVisible();
  await expect(page.getByText('📥 Antigüedad de cuentas por cobrar')).toBeVisible();
  await expect(page.getByText('🚢 Utilidad por contenedor')).toBeVisible();
  await expect(page.getByText(/Inventario valorado/)).toBeVisible();
});
