/**
 * Permisos atómicos `recurso:acción`. Los roles son conjuntos editables de permisos
 * (ver docs/05-decisiones-y-preguntas.md §2). '*' = todos.
 */
export const PERMISSIONS = {
  'admin:users': 'Gestionar usuarios y roles',
  'admin:settings': 'Configuración general y parámetros',
  'org:manage': 'Empresas, segmentos y dimensiones',
  'accounts:read': 'Consultar plan de cuentas',
  'accounts:manage': 'Editar plan de cuentas y mapeos',
  'fx:read': 'Consultar tasas de cambio',
  'fx:manage': 'Registrar tasas de cambio',
  'ledger:read': 'Consultar libro diario y mayor',
  'ledger:post': 'Registrar asientos manuales',
  'ledger:reverse': 'Anular asientos (contra-asiento)',
  'ledger:post_soft_closed': 'Contabilizar en periodos en revisión de cierre',
  'period:read': 'Consultar periodos',
  'period:close': 'Pasar periodos a revisión de cierre',
  'period:lock': 'Bloquear periodos',
  'period:reopen': 'Reabrir periodos bloqueados',
  'reports:financial': 'Reportes financieros (BC, ES, ER, EFE)',
  'audit:read': 'Consultar auditoría',
  'parties:read': 'Consultar contrapartes, cuentas corrientes y estados de cuenta',
  'parties:manage': 'Contrapartes: alta, cargos, abonos, cesiones y liquidaciones',
  'payroll:manage': 'Registrar nóminas',
  // Fases siguientes (se declaran ya para poder asignarlos a roles)
  'cash:operate': 'Operar caja',
  'bank:reconcile': 'Conciliación bancaria y traspasos',
  'tax:manage': 'Impuestos y libro fiscal',
  'sales:operate': 'Facturación y cobros',
  'inventory:operate': 'Contenedores, inventario y kardex',
} as const;

export type Permission = keyof typeof PERMISSIONS | '*';

export interface SeedRole {
  name: string;
  description: string;
  requires2fa: boolean;
  permissions: Permission[];
}

const READ_ALL: Permission[] = [
  'accounts:read', 'fx:read', 'ledger:read', 'period:read', 'reports:financial', 'parties:read',
];

export const SEED_ROLES: SeedRole[] = [
  { name: 'Superadministrador', description: 'Acceso total', requires2fa: true, permissions: ['*'] },
  {
    name: 'Contador',
    description: 'Plan de cuentas, asientos, cierres y reportes',
    requires2fa: true,
    permissions: [
      ...READ_ALL, 'accounts:manage', 'fx:manage', 'ledger:post', 'ledger:reverse',
      'ledger:post_soft_closed', 'period:close', 'period:lock', 'audit:read', 'bank:reconcile',
      'tax:manage', 'parties:manage', 'payroll:manage',
    ],
  },
  { name: 'Cajero', description: 'Operación de caja', requires2fa: false, permissions: ['fx:read', 'cash:operate'] },
  {
    name: 'Conciliador',
    description: 'Extractos, conciliación y traspasos',
    requires2fa: false,
    permissions: ['fx:read', 'accounts:read', 'ledger:read', 'bank:reconcile', 'parties:read', 'parties:manage'],
  },
  {
    name: 'Fiscal',
    description: 'Libro fiscal e impuestos',
    requires2fa: false,
    permissions: [...READ_ALL, 'tax:manage'],
  },
  { name: 'Comercial y Ventas', description: 'Facturación y cobros', requires2fa: false, permissions: ['fx:read', 'sales:operate', 'parties:read'] },
  { name: 'Almacén', description: 'Inventario y contenedores', requires2fa: false, permissions: ['inventory:operate'] },
  { name: 'Solo lectura', description: 'Consulta de reportes', requires2fa: false, permissions: READ_ALL },
];

export function hasPermission(granted: Iterable<string>, required: Permission): boolean {
  for (const p of granted) {
    if (p === '*' || p === required) return true;
  }
  return false;
}
