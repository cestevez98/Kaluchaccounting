'use client';

import { OpenItemsTable } from '@/components/parties';
import { PageHeader } from '@/components/ui';

export default function ReceivableItemsPage() {
  return (
    <div>
      <PageHeader title="Partidas por cobrar" subtitle="Facturas y deudas a nuestro favor pendientes de cobro. Liquídalas con el cobro ya registrado en Bancos y Caja." />
      <OpenItemsTable side="RECEIVABLE" />
    </div>
  );
}
