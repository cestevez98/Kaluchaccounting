'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

interface SubItem {
  href: string;
  label: string;
  perm?: string;
}
interface Module {
  key: string;
  icon: string;
  label: string;
  href: string;
  perm?: string;
  /** Fase en la que se construye (módulos aún no disponibles). */
  phase?: number;
  groups?: { label: string; items: SubItem[] }[];
}

/** Navegación por módulos, como en el diseño de Figma. */
export const MODULES: Module[] = [
  { key: 'dashboard', icon: '⊞', label: 'Dashboard', href: '/' },
  {
    key: 'contabilidad', icon: '📒', label: 'Contabilidad', href: '/diario', perm: 'ledger:read',
    groups: [
      { label: 'Libros', items: [
        { href: '/diario', label: 'Libro diario', perm: 'ledger:read' },
        { href: '/diario/nuevo', label: 'Nuevo asiento', perm: 'ledger:post' },
        { href: '/mayor', label: 'Libro mayor', perm: 'ledger:read' },
      ] },
      { label: 'Informes', items: [
        { href: '/balance', label: 'Balance de comprobación', perm: 'reports:financial' },
        { href: '/conciliacion-bc', label: 'Conciliación con el Excel', perm: 'reports:financial' },
      ] },
      { label: 'Cierre', items: [
        { href: '/periodos', label: 'Periodos', perm: 'period:read' },
        { href: '/tesoreria/revaluacion', label: 'Revaluación (tenencia)', perm: 'ledger:read' },
        { href: '/terceros/reclasificacion', label: 'Reclasificación por signo', perm: 'parties:read' },
        { href: '/cierre', label: 'Cierre de mes y de ejercicio', perm: 'ledger:read' },
      ] },
      { label: 'Patrimonio', items: [{ href: '/capital', label: 'Capital por socio', perm: 'ledger:read' }] },
      { label: 'Maestros', items: [{ href: '/plan-de-cuentas', label: 'Plan de cuentas', perm: 'accounts:read' }] },
    ],
  },
  {
    key: 'bancos', icon: '🏦', label: 'Bancos y Caja', href: '/tesoreria', perm: 'ledger:read',
    groups: [
      { label: 'Tesorería', items: [
        { href: '/tesoreria', label: 'Resumen de tesorería', perm: 'ledger:read' },
        { href: '/tesoreria/movimientos', label: 'Movimientos', perm: 'ledger:read' },
        { href: '/tesoreria/nuevo', label: 'Nuevo movimiento', perm: 'cash:operate' },
      ] },
      { label: 'Revisión', items: [{ href: '/tesoreria/revision', label: 'Bandeja de revisión', perm: 'ledger:read' }] },
      { label: 'Conciliación', items: [{ href: '/tesoreria/extractos', label: 'Extractos y conciliación', perm: 'bank:reconcile' }] },
      { label: 'Configuración', items: [{ href: '/tesoreria/categorias', label: 'Categorías', perm: 'ledger:read' }] },
    ],
  },
  {
    key: 'ventas', icon: '🛒', label: 'Ventas', href: '/ventas', perm: 'sales:read',
    groups: [
      {
        label: 'Exportación',
        items: [
          { href: '/ventas', label: 'Facturas de exportación', perm: 'sales:read' },
          { href: '/ventas/exportacion/nueva', label: 'Nueva factura', perm: 'sales:operate' },
        ],
      },
      {
        label: 'Distribución',
        items: [
          { href: '/ventas/distribucion', label: 'Facturas de distribución', perm: 'sales:read' },
          { href: '/ventas/distribucion/nueva', label: 'Nueva factura', perm: 'sales:operate' },
          { href: '/ventas/comisiones', label: 'Comisiones de vendedores', perm: 'sales:read' },
        ],
      },
    ],
  },
  {
    key: 'cobrar', icon: '📥', label: 'Cuentas por Cobrar', href: '/cobrar', perm: 'parties:read',
    groups: [{ label: 'Cuentas por cobrar', items: [
      { href: '/cobrar', label: 'Saldos y antigüedad', perm: 'parties:read' },
      { href: '/cobrar/partidas', label: 'Partidas por cobrar', perm: 'parties:read' },
    ] }],
  },
  {
    key: 'compras', icon: '📦', label: 'Compras', href: '/pagar/partidas', perm: 'parties:read',
    groups: [{ label: 'Proveedores', items: [
      { href: '/pagar/partidas', label: 'Facturas de proveedores', perm: 'parties:read' },
      { href: '/terceros/documento?tipo=factura', label: 'Registrar factura', perm: 'parties:manage' },
    ] }],
  },
  {
    key: 'pagar', icon: '📤', label: 'Cuentas por Pagar', href: '/pagar', perm: 'parties:read',
    groups: [{ label: 'Cuentas por pagar', items: [
      { href: '/pagar', label: 'Saldos y antigüedad', perm: 'parties:read' },
      { href: '/pagar/partidas', label: 'Partidas por pagar', perm: 'parties:read' },
    ] }],
  },
  {
    key: 'terceros', icon: '👥', label: 'Terceros', href: '/terceros', perm: 'parties:read',
    groups: [
      { label: 'Contrapartes', items: [
        { href: '/terceros', label: 'Listado', perm: 'parties:read' },
        { href: '/terceros/nuevo', label: 'Nueva contraparte', perm: 'parties:manage' },
      ] },
      { label: 'Operaciones', items: [
        { href: '/terceros/documento', label: 'Cargo, abono o cesión', perm: 'parties:manage' },
        { href: '/terceros/reclasificacion', label: 'Reclasificación por signo', perm: 'parties:read' },
      ] },
    ],
  },
  {
    key: 'inventario', icon: '🗄️', label: 'Inventario', href: '/inventario', perm: 'sales:read',
    groups: [
      {
        label: 'Distribución',
        items: [
          { href: '/inventario', label: 'Contenedores y utilidad', perm: 'sales:read' },
          { href: '/inventario/productos', label: 'Productos y kardex', perm: 'sales:read' },
        ],
      },
    ],
  },
  {
    key: 'inversiones', icon: '📈', label: 'Inversiones', href: '/inversiones', perm: 'sales:read',
    groups: [
      {
        label: 'Inversiones',
        items: [
          { href: '/inversiones', label: 'Inversionistas por contenedor', perm: 'sales:read' },
          { href: '/terceros?role=INVESTOR', label: 'Cuentas de inversionistas', perm: 'parties:read' },
        ],
      },
    ],
  },
  {
    key: 'financiamientos', icon: '💰', label: 'Financiamientos', href: '/financiamientos', perm: 'ledger:read',
    groups: [
      {
        label: 'Préstamos',
        items: [
          { href: '/financiamientos', label: 'Préstamos dados y recibidos', perm: 'ledger:read' },
          { href: '/financiamientos/nuevo', label: 'Nuevo préstamo', perm: 'finance:manage' },
          { href: '/terceros?role=LENDER', label: 'Prestamistas', perm: 'parties:read' },
        ],
      },
    ],
  },
  {
    key: 'impuestos', icon: '🧾', label: 'Impuestos', href: '/impuestos', perm: 'ledger:read',
    groups: [{ label: 'Fiscal', items: [{ href: '/impuestos', label: 'ONAT y Hacienda', perm: 'ledger:read' }] }],
  },
  {
    key: 'rrhh', icon: '🧑‍💼', label: 'RRHH', href: '/rrhh', perm: 'parties:read',
    groups: [{ label: 'Nómina', items: [
      { href: '/rrhh', label: 'Nóminas', perm: 'parties:read' },
      { href: '/rrhh/nueva', label: 'Nueva nómina', perm: 'payroll:manage' },
      { href: '/terceros?role=EMPLOYEE', label: 'Trabajadores', perm: 'parties:read' },
    ] }],
  },
  { key: 'reportes', icon: '📊', label: 'Reportes', href: '#', phase: 6 },
  {
    key: 'configuracion', icon: '⚙️', label: 'Configuración', href: '/tasas',
    groups: [
      { label: 'General', items: [
        { href: '/tasas', label: 'Tasas de cambio', perm: 'fx:read' },
        { href: '/admin/usuarios', label: 'Usuarios y roles', perm: 'admin:users' },
        { href: '/admin/importar', label: 'Importar Excel', perm: 'admin:settings' },
        { href: '/seguridad', label: 'Mi seguridad (2FA)' },
      ] },
    ],
  },
  { key: 'auditoria', icon: '🔍', label: 'Auditoría', href: '/auditoria', perm: 'audit:read' },
];

/** Módulo y entrada activos: la ruta más específica que coincide. */
function locate(pathname: string) {
  let best: { module: Module; item?: SubItem; len: number } | null = null;
  for (const m of MODULES) {
    const candidates: { href: string; item?: SubItem }[] = [
      ...(m.groups ?? []).flatMap((g) => g.items.map((i) => ({ href: i.href, item: i }))),
      { href: m.href },
    ];
    for (const c of candidates) {
      if (c.href === '#') continue;
      const hit = c.href === '/' ? pathname === '/' : pathname === c.href || pathname.startsWith(`${c.href}/`);
      if (hit && (!best || c.href.length > best.len)) best = { module: m, item: c.item, len: c.href.length };
    }
  }
  return best;
}

export function CompanySelector() {
  const { me, companyId, setCompanyId } = useSession();
  if (!me) return null;
  return (
    <select aria-label="Empresa" className="input h-7 max-w-64 text-xs" value={companyId ?? ''} onChange={(e) => setCompanyId(e.target.value || null)}>
      <option value="">Consolidado (grupo)</option>
      {me.companies.map((c) => (
        <option key={c.id} value={c.id}>
          {c.code} · {c.legalName}
        </option>
      ))}
    </select>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}

function UserMenu() {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  if (!me) return null;
  const roles = [...new Set(me.companies.flatMap((c) => c.roles))];
  return (
    <div className="relative">
      <button className="flex items-center gap-2 rounded px-2 py-1 hover:bg-gray-100" onClick={() => setOpen(!open)} aria-label="Menú de usuario">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">{initials(me.name)}</span>
        <span className="hidden text-left md:block">
          <span className="block text-xs leading-tight font-medium">{me.name}</span>
          <span className="block text-[11px] text-muted">{roles.slice(0, 2).join(', ')}</span>
        </span>
        <span className="text-xs text-subtle">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-10 right-0 z-50 w-56 overflow-hidden rounded-lg border border-line bg-white shadow-lg">
            <div className="border-b border-line px-4 py-3">
              <div className="text-xs font-semibold">{me.name}</div>
              <div className="text-xs text-muted">{me.email}</div>
            </div>
            <Link href="/seguridad" className="block px-4 py-2 text-xs hover:bg-canvas" onClick={() => setOpen(false)}>
              Seguridad y verificación en dos pasos
            </Link>
            <button
              className="block w-full border-t border-line px-4 py-2 text-left text-xs text-bad hover:bg-canvas"
              onClick={async () => {
                await api('/auth/logout', { method: 'POST' });
                window.location.href = '/login';
              }}
            >
              Cerrar sesión
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { can } = useSession();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => setMobileOpen(false), [pathname]);
  const here = locate(pathname);
  const visibleGroups = (here?.module.groups ?? [])
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.perm || can(i.perm)) }))
    .filter((g) => g.items.length > 0);

  const nav = (
    <nav className="flex-1 overflow-y-auto py-2">
      {MODULES.filter((m) => m.phase || !m.perm || can(m.perm)).map((m) => {
        const active = here?.module.key === m.key;
        const base = 'flex w-full items-center gap-2.5 border-l-2 px-3 py-2 text-left text-[13px] transition';
        if (m.phase) {
          return (
            <div key={m.key} title={`Disponible en la fase ${m.phase}`} className={`${base} cursor-default border-transparent text-white/35`}>
              <span className="shrink-0 text-base grayscale">{m.icon}</span>
              {!collapsed && (
                <span className="flex flex-1 items-center justify-between overflow-hidden whitespace-nowrap">
                  {m.label}
                  <span className="rounded bg-white/10 px-1 text-[10px]">F{m.phase}</span>
                </span>
              )}
            </div>
          );
        }
        return (
          <Link
            key={m.key}
            href={m.href}
            title={collapsed ? m.label : undefined}
            className={`${base} ${active ? 'border-white/80 bg-white/12 text-white' : 'border-transparent text-white/65 hover:bg-white/7 hover:text-white/85'}`}
          >
            <span className="shrink-0 text-base">{m.icon}</span>
            {!collapsed && <span className="overflow-hidden text-ellipsis whitespace-nowrap">{m.label}</span>}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-canvas">
      {/* Barra lateral de módulos */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex shrink-0 flex-col border-r border-brand-700 bg-brand-900 transition-all md:static ${mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}
        style={{ width: collapsed ? 56 : 220 }}
      >
        <div className="flex h-12 shrink-0 items-center border-b border-white/10 px-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-white/15 text-sm font-bold text-white">K</span>
          {!collapsed && <span className="ml-2 text-sm font-semibold whitespace-nowrap text-white">Kaluch Group</span>}
        </div>
        {nav}
        <div className="border-t border-white/10 p-2">
          <button className="w-full rounded py-1 text-xs text-white/50 hover:text-white/80" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Expandir menú' : 'Colapsar menú'}>
            {collapsed ? '→' : '←'}
          </button>
        </div>
      </aside>
      {mobileOpen && <div className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={() => setMobileOpen(false)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barra superior */}
        <header className="z-20 flex h-12 shrink-0 items-center gap-3 border-b border-line bg-white px-4">
          <button className="text-lg md:hidden" aria-label="Abrir menú" onClick={() => setMobileOpen(true)}>☰</button>
          <CompanySelector />
          <div className="flex-1" />
          <UserMenu />
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Submenú del módulo */}
          {visibleGroups.length > 0 && (
            <aside className="hidden w-52 shrink-0 flex-col overflow-y-auto border-r border-line bg-white lg:flex">
              <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                <span className="text-base">{here!.module.icon}</span>
                <span className="text-sm font-semibold">{here!.module.label}</span>
              </div>
              <nav className="flex-1 py-2">
                {visibleGroups.map((g) => (
                  <div key={g.label} className="mb-1">
                    <div className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">{g.label}</div>
                    {g.items.map((i) => {
                      const active = here?.item?.href === i.href;
                      return (
                        <Link
                          key={i.href}
                          href={i.href}
                          className={`block border-l-2 px-4 py-1.5 text-xs ${active ? 'border-brand-600 bg-brand-100 font-medium text-brand-600' : 'border-transparent text-muted hover:bg-canvas'}`}
                        >
                          {i.label}
                        </Link>
                      );
                    })}
                  </div>
                ))}
              </nav>
            </aside>
          )}

          <div className="flex min-w-0 flex-1 flex-col">
            {here && here.module.key !== 'dashboard' && (
              <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-white px-6 py-2 text-xs">
                <Link href={here.module.href} className="text-subtle hover:underline">{here.module.label}</Link>
                {here.item && (
                  <>
                    <span className="text-gray-300">›</span>
                    <span className="font-medium">{here.item.label}</span>
                  </>
                )}
              </div>
            )}
            {/* Submenú en pantallas estrechas */}
            {visibleGroups.length > 0 && (
              <nav className="flex gap-1 overflow-x-auto border-b border-line bg-white px-2 py-1.5 lg:hidden">
                {visibleGroups.flatMap((g) => g.items).map((i) => (
                  <Link key={i.href} href={i.href} className={`shrink-0 rounded px-2 py-1 text-xs ${here?.item?.href === i.href ? 'bg-brand-100 text-brand-600' : 'text-muted'}`}>
                    {i.label}
                  </Link>
                ))}
              </nav>
            )}
            <main className="min-w-0 flex-1 overflow-auto px-4 py-5 md:px-6">{children}</main>
          </div>
        </div>
      </div>
    </div>
  );
}
