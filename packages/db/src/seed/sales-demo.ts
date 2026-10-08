import type { PrismaClient } from '@prisma/client';
import { withTx } from '../client';
import { closeExportInvoice, issueExportInvoice, postContainerCost, postSalesInvoice, receiveContainer } from '../sales';

/** Productos de DEMOSTRACIÓN. */
export const DEMO_PRODUCTS = [
  { code: 'ACEITE_1L', name: 'Aceite vegetal 1 L', unit: 'caja' },
  { code: 'ARROZ_25KG', name: 'Arroz 25 kg', unit: 'saco' },
];

export async function seedDemoProducts(prisma: PrismaClient) {
  for (const p of DEMO_PRODUCTS) await prisma.product.upsert({ where: { code: p.code }, update: {}, create: p });
}

/** Contenedor, venta de distribución y facturas de exportación de demostración (con asientos). */
export async function seedDemoSales(prisma: PrismaClient, userId: string) {
  const pa = (party: string, account: string) =>
    prisma.partyAccount.findFirstOrThrow({ where: { party: { code: party }, account: { fullCode: account } } });
  const gr = await prisma.company.findUniqueOrThrow({ where: { code: 'GR' } });
  const [supplier, customer, seller, sellerExport, investor, exportCustomer] = await Promise.all([
    pa('PROVEEDOR_DISTRIBUCION_DEMO', '406'), pa('CLIENTE_DISTRIBUCION_DEMO', '137'), pa('VENDEDOR_DEMO', '410.9990'),
    pa('VENDEDOR_DEMO', '410.8880'), pa('INVERSIONISTA_DEMO', '412'), pa('CLIENTE_EXPORTACION_DEMO', '136'),
  ]);
  const oil = await prisma.product.findUniqueOrThrow({ where: { code: 'ACEITE_1L' } });
  const rice = await prisma.product.findUniqueOrThrow({ where: { code: 'ARROZ_25KG' } });
  const container = await prisma.container.create({ data: { companyId: gr.id, code: 'CONT-DEMO-01', description: 'Contenedor demo (aceite y arroz)' } });
  await prisma.containerInvestor.create({ data: { containerId: container.id, partyAccountId: investor.id, investedUsd: '4000', profitPct: '40' } });
  await withTx(prisma, { userId }, async (tx) => {
    await postContainerCost(tx, { containerId: container.id, date: '2026-05-10', amountUsd: '9000', description: 'Mercancía', partyAccountId: supplier.id, reference: 'PRV-DEMO-1', createdBy: userId });
    await postContainerCost(tx, { containerId: container.id, date: '2026-05-20', amountUsd: '1000', description: 'Flete y aduana', partyAccountId: supplier.id, reference: 'PRV-DEMO-2', createdBy: userId });
    await receiveContainer(tx, {
      containerId: container.id, date: '2026-06-01', createdBy: userId,
      lines: [{ productId: oil.id, quantity: '100', amountUsd: '6000' }, { productId: rice.id, quantity: '50', amountUsd: '4000' }],
    });
    await postSalesInvoice(tx, {
      companyId: gr.id, date: '2026-06-10', description: 'Venta a crédito (demo)', partyAccountId: customer.id, createdBy: userId,
      lines: [
        { productId: oil.id, containerId: container.id, quantity: '40', unitPriceUsd: '90', commissionPerUnitUsd: '2', sellerPartyAccountId: seller.id },
        { productId: rice.id, containerId: container.id, quantity: '10', unitPriceUsd: '120', commissionPerUnitUsd: '3', sellerPartyAccountId: seller.id },
      ],
    });
    const closed = await issueExportInvoice(tx, {
      partyAccountId: exportCustomer.id, number: 'KAL-DEMO-001', invoiceDate: '2026-05-15', service: 'GOODS', description: 'Exportación de productos (demo)',
      amountUsd: '20000', factoryUsd: '12000', logisticsUsd: '2500', otherUsd: '500', commissionUsd: '400', sellerPartyAccountId: sellerExport.id, createdBy: userId,
    });
    await closeExportInvoice(tx, { id: closed.invoice.id, closeDate: '2026-06-30', createdBy: userId });
    await issueExportInvoice(tx, {
      partyAccountId: exportCustomer.id, number: 'KAL-DEMO-002', invoiceDate: '2026-09-20', service: 'GOODS', description: 'Exportación pendiente de cierre (demo)',
      amountUsd: '15000', factoryUsd: '9000', logisticsUsd: '1800', createdBy: userId,
    });
  });
}
