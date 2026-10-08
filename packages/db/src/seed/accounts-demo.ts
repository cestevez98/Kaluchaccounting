/**
 * Plan de cuentas de DEMOSTRACIÓN: estructura de grupos del BC con subcuentas
 * genéricas. El plan real se importa del Excel con `pnpm etl coa`.
 * [código, subcuenta | null, nombre, naturaleza, clasificación, opciones]
 */
type Nature = 'DEUDORA' | 'ACREEDORA' | 'MIXTA';
type Cls = 'AC' | 'PC' | 'CC' | 'CND' | 'CNA';
interface Opts {
  currency?: string;
  reval?: string;
  intercompany?: boolean;
  pending?: boolean;
  segment?: string;
}
export type DemoAccount = [string, string | null, string, Nature, Cls, Opts?];

export const DEMO_ACCOUNTS: DemoAccount[] = [
  ['101', null, 'Efectivo en Caja', 'DEUDORA', 'AC'],
  ['101', '0001', 'Efectivo en Caja - CUP', 'DEUDORA', 'AC', { currency: 'CUP', reval: 'IC' }],
  ['101', '0002', 'Efectivo en Caja - USD', 'DEUDORA', 'AC', { currency: 'USD' }],
  ['101', '0003', 'Efectivo en Caja - EUR', 'DEUDORA', 'AC', { currency: 'EUR', reval: 'IC' }],
  ['109', null, 'Efectivo en Banco Empresarial Dominicana', 'DEUDORA', 'AC'],
  ['109', '9001', 'Banco USD - Demo Dominicana', 'DEUDORA', 'AC', { currency: 'USD' }],
  ['109', '9002', 'Banco DOP - Demo Dominicana', 'DEUDORA', 'AC', { currency: 'DOP', reval: 'ORD' }],
  ['110', null, 'Efectivo en Banco Empresarial España', 'DEUDORA', 'AC'],
  ['110', '9003', 'Banco EUR - Demo España', 'DEUDORA', 'AC', { currency: 'EUR', reval: 'IC' }],
  ['111', null, 'Efectivo en Banco Empresarial Cuba', 'DEUDORA', 'AC'],
  ['111', '9004', 'Banco CUP - Demo Cuba', 'DEUDORA', 'AC', { currency: 'CUP', reval: 'IC' }],
  ['114', null, 'Efectivo en Banco Personal Cuba', 'DEUDORA', 'AC'],
  ['114', '9005', 'Banco MLC - Socio demo', 'DEUDORA', 'AC', { currency: 'MLC', reval: 'IC' }],
  ['135', null, 'Cuenta por Cobrar a Corto Plazo Oficina', 'DEUDORA', 'AC'],
  ['135', '0001', 'CxC Oficina - Contraparte demo', 'DEUDORA', 'AC'],
  ['137', null, 'Cuenta por Cobrar a Corto Plazo Distribución', 'DEUDORA', 'AC'],
  ['181', null, 'Mercancías Distribución', 'DEUDORA', 'AC'],
  ['181', '0001', 'Mercancías Distribución - Almacén', 'DEUDORA', 'AC', { segment: '999' }],
  ['405', null, 'Cuenta por Pagar a Corto Plazo Oficina', 'ACREEDORA', 'PC'],
  ['405', '0001', 'CxP Oficina - Contraparte demo', 'ACREEDORA', 'PC'],
  ['409', null, 'Cuenta por Pagar a Corto Plazo Otros Proveedores', 'ACREEDORA', 'PC'],
  ['600', null, 'Capital', 'ACREEDORA', 'CC'],
  ['600', '0001', 'Capital - Aportes de socios', 'ACREEDORA', 'CC'],
  ['630', null, 'Utilidades Retenidas', 'ACREEDORA', 'CC'],
  ['696', null, 'Operaciones entre Dependencias', 'MIXTA', 'CC', { intercompany: true }],
  ['699', null, 'Transitoria del Sistema', 'MIXTA', 'CC'],
  ['699', '0001', 'Transitoria - Banco a Banco', 'MIXTA', 'CC'],
  ['814', null, 'Costo de Ventas de Bienes', 'DEUDORA', 'CND'],
  ['814', '0001', 'Costo de Ventas de Bienes - Distribución', 'DEUDORA', 'CND', { segment: '999' }],
  ['826', null, 'Gastos de Operación - Salario', 'DEUDORA', 'CND'],
  ['826', '0001', 'Salario - Oficina', 'DEUDORA', 'CND'],
  ['837', null, 'Gastos de Operación - Alquiler', 'DEUDORA', 'CND'],
  ['837', '0001', 'Alquiler - Locales', 'DEUDORA', 'CND'],
  ['845', null, 'Gastos por Variación de Tasas de Cambio', 'DEUDORA', 'CND'],
  ['845', '0001', 'Variación TC - Cambios', 'DEUDORA', 'CND'],
  ['845', '0002', 'Variación TC - Traspasos', 'DEUDORA', 'CND'],
  ['845', '0003', 'Variación TC - Pago a Coprove', 'DEUDORA', 'CND'],
  ['846', null, 'Gastos por Tenencia', 'DEUDORA', 'CND'],
  ['846', '0001', 'Gastos por Tenencia - Efectivo', 'DEUDORA', 'CND'],
  ['900', null, 'Ventas de Bienes', 'ACREEDORA', 'CNA'],
  ['900', '0001', 'Ventas de Bienes - Distribución minorista', 'ACREEDORA', 'CNA', { segment: '999' }],
  ['900', '0002', 'Ventas de Bienes - Exportación', 'ACREEDORA', 'CNA', { segment: '888' }],
  ['924', null, 'Ingresos por Variación de Tasas de Cambio', 'ACREEDORA', 'CNA'],
  ['924', '0001', 'Variación TC - Cambios', 'ACREEDORA', 'CNA'],
  ['924', '0002', 'Variación TC - Traspasos', 'ACREEDORA', 'CNA'],
  ['925', null, 'Ingresos por Tenencia', 'ACREEDORA', 'CNA'],
  ['925', '0001', 'Ingresos por Tenencia - Efectivo', 'ACREEDORA', 'CNA'],
  ['1900', null, 'Ventas de Bienes Internas', 'ACREEDORA', 'CNA', { intercompany: true }],
  ['2900', null, 'Ventas Pendientes de Exportación', 'ACREEDORA', 'CNA', { pending: true }],
];
