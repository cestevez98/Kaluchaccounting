'use client';

import Link from 'next/link';
import { PartyBalancesView } from '@/components/parties';
import { PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function PayablesPage() {
  const { can } = useSession();
  return (
    <div>
      <PageHeader
        title="Cuentas por pagar"
        subtitle="Saldos acreedores (lo que debemos) a proveedores, trabajadores, inversionistas y otras contrapartes."
        actions={can('parties:manage') ? <Link className="btn-primary" href="/terceros/documento?tipo=factura">Registrar factura de proveedor</Link> : null}
      />
      <PartyBalancesView side="payable" />
    </div>
  );
}
