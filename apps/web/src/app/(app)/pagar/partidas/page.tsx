'use client';

import { OpenItemsTable } from '@/components/parties';
import { PageHeader } from '@/components/ui';

export default function PayableItemsPage() {
  return (
    <div>
      <PageHeader title="Partidas por pagar" subtitle="Facturas de proveedores, nóminas y otras deudas pendientes. Liquídalas con el pago ya registrado en Bancos y Caja." />
      <OpenItemsTable side="PAYABLE" />
    </div>
  );
}
