'use client';

import { PartyBalancesView } from '@/components/parties';
import { PageHeader } from '@/components/ui';

export default function ReceivablesPage() {
  return (
    <div>
      <PageHeader title="Cuentas por cobrar" subtitle="Saldos deudores de las cuentas corrientes (lo que nos deben) y antigüedad de las partidas abiertas." />
      <PartyBalancesView side="receivable" />
    </div>
  );
}
