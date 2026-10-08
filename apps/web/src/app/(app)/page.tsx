'use client';

import Link from 'next/link';
import { money, MONTH_NAMES } from '@kaluch/shared';
import { Alert, Amount, PageHeader, Spinner } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { TrialBalance } from '@/lib/types';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium tracking-wide text-gray-500 uppercase">{label}</div>
      <div className="mt-1 text-xl font-semibold">
        <Amount value={value} /> <span className="text-sm font-normal text-gray-400">USD</span>
      </div>
    </div>
  );
}

export default function HomePage() {
  const { me, companyId, can } = useSession();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const canReports = can('reports:financial');
  const { data, error, loading } = useApi<TrialBalance>(
    me && canReports ? `/reports/trial-balance${qs({ year, month, companyId })}` : null,
  );
  const company = me?.companies.find((c) => c.id === companyId);

  return (
    <div>
      <PageHeader
        title={`Hola${me ? `, ${me.name}` : ''}`}
        subtitle={`${company ? `${company.code} · ${company.legalName}` : 'Grupo consolidado'} · ${MONTH_NAMES[month - 1]} ${year}`}
      />
      {me?.requires2fa && !me.totpEnabled && (
        <div className="mb-4">
          <Alert kind="warning">
            Tu rol exige verificación en dos pasos. <Link className="underline" href="/seguridad">Actívala ahora</Link>.
          </Alert>
        </div>
      )}
      {canReports && (
        <>
          {loading && !data && <Spinner />}
          {error && <Alert>{error.message}</Alert>}
          {data && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Activo" value={data.summary.assets} />
                <Stat label="Pasivo" value={data.summary.liabilities} />
                <Stat label="Patrimonio" value={data.summary.equity} />
                <Stat label="Resultado acumulado" value={money(data.summary.income).minus(data.summary.expenses).toFixed(4)} />
              </div>
              <div className="mt-4">
                {data.summary.balanced ? (
                  <Alert kind="success">El balance cuadra: Activo = Pasivo + Patrimonio + Resultado.</Alert>
                ) : (
                  <Alert>
                    El balance NO cuadra: diferencia de <Amount value={data.summary.difference} /> USD. Revisa el balance de comprobación.
                  </Alert>
                )}
              </div>
            </>
          )}
        </>
      )}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { href: '/diario/nuevo', title: 'Nuevo asiento', text: 'Registrar un asiento manual multimoneda', perm: 'ledger:post' },
          { href: '/balance', title: 'Balance de comprobación', text: 'Mensual, por empresa y segmento, con exportación a Excel', perm: 'reports:financial' },
          { href: '/tasas', title: 'Tasas de cambio', text: 'Tasas diarias por par y tipo (OC, IC, OUE, ORD)', perm: 'fx:read' },
        ]
          .filter((l) => can(l.perm))
          .map((l) => (
            <Link key={l.href} href={l.href} className="card block p-4 hover:border-brand-600">
              <div className="font-medium">{l.title}</div>
              <div className="text-sm text-gray-500">{l.text}</div>
            </Link>
          ))}
      </div>
    </div>
  );
}
