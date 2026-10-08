import { FUNCTIONAL_CURRENCY, money, roundAmount } from '@kaluch/shared';
import type { InventoryLocation } from '@prisma/client';
import type { Tx } from './client';
import { LedgerError } from './errors';
import { toDate } from './fx';
import { nextNumber, postEntry, resolveMapping, type PostLineInput } from './ledger';
import { createOpenItem } from './parties';
import { getParam } from './params';

type Money = ReturnType<typeof money>;
type Db = Pick<Tx, 'exportInvoice' | 'container' | 'inventoryMovement' | 'salesInvoice' | 'salesLine' | 'journalLine' | 'segment' | 'containerInvestor' | 'product'>;

const usdLine = (accountId: string, amount: Money, memo: string, extra: Partial<PostLineInput> = {}): PostLineInput => ({
  accountId, currency: FUNCTIONAL_CURRENCY, amount: roundAmount(amount).toFixed(4), memo: memo.slice(0, 500), ...extra,
});

async function segmentId(tx: Tx, code: string) {
  return (await tx.segment.findUnique({ where: { code } }))?.id ?? null;
}

async function usdPartyAccount(tx: Tx, id: string, label: string) {
  const pa = await tx.partyAccount.findUnique({ where: { id }, include: { party: true, company: true } });
  if (!pa) throw new LedgerError('NOT_FOUND', `${label}: cuenta corriente no encontrada`);
  if (!pa.active) throw new LedgerError('INVALID_INPUT', `${label}: la cuenta corriente ${pa.name} está inactiva`);
  if (pa.currency !== FUNCTIONAL_CURRENCY) throw new LedgerError('INVALID_INPUT', `${label}: la cuenta corriente debe estar en USD`);
  return pa;
}

const nonNegative = (v: string | undefined, label: string) => {
  const m = money(v ?? 0);
  if (m.lt(0)) throw new LedgerError('INVALID_INPUT', `${label} no puede ser negativo`);
  return roundAmount(m);
};

// ───────────────────────── Facturas de exportación ─────────────────────────

export interface ExportInvoiceInput {
  partyAccountId: string;
  number: string;
  /** AAAA-MM-DD */
  invoiceDate: string;
  service: 'GOODS' | 'SERVICES';
  internal?: boolean;
  description: string;
  amountUsd: string;
  factoryUsd?: string;
  logisticsUsd?: string;
  otherUsd?: string;
  estimatedUsd?: string;
  commissionUsd?: string;
  sellerPartyAccountId?: string | null;
  dueDate?: string | null;
  createdBy?: string | null;
}

/**
 * Emite una factura de exportación: queda pendiente de cierre. Cargo al cliente contra Ventas pendientes (2900) y
 * los costos ya conocidos de mercancías pendientes de facturar (180.888x) a Costos pendientes (2814–2816), con una
 * partida abierta por cobrar.
 */
export async function issueExportInvoice(tx: Tx, input: ExportInvoiceInput) {
  const amount = roundAmount(money(input.amountUsd));
  if (amount.lte(0)) throw new LedgerError('INVALID_INPUT', 'El importe de la factura debe ser positivo');
  const factory = nonNegative(input.factoryUsd, 'El costo de fábrica');
  const logistics = nonNegative(input.logisticsUsd, 'El costo de logística');
  const other = nonNegative(input.otherUsd, 'Otros costos');
  const estimated = nonNegative(input.estimatedUsd, 'El costo estimado');
  const commission = nonNegative(input.commissionUsd, 'La comisión');
  const pa = await usdPartyAccount(tx, input.partyAccountId, 'Cliente');
  if (!commission.isZero() && !input.sellerPartyAccountId) throw new LedgerError('INVALID_INPUT', 'Indica el vendedor que cobra la comisión');
  if (input.sellerPartyAccountId) {
    const seller = await usdPartyAccount(tx, input.sellerPartyAccountId, 'Vendedor');
    if (seller.companyId !== pa.companyId) throw new LedgerError('INVALID_INPUT', 'El vendedor debe tener cuenta corriente en la misma empresa');
  }
  if (await tx.exportInvoice.findUnique({ where: { companyId_number: { companyId: pa.companyId, number: input.number } } })) {
    throw new LedgerError('INVALID_INPUT', `Ya existe la factura ${input.number}`);
  }
  const ctx = { companyId: pa.companyId };
  const seg = await segmentId(tx, '888');
  const memo = `Factura ${input.number} ${pa.party.name}: ${input.description}`;
  const lines: PostLineInput[] = [
    usdLine(pa.accountId, amount, memo, { partyId: pa.partyId, segmentId: seg }),
    usdLine(await resolveMapping(tx, 'export.pending.sales', ctx), amount.neg(), memo, { segmentId: seg }),
  ];
  const pending: [Money, string, string][] = [
    [factory, 'export.pending.factory', 'export.stock.factory'],
    [logistics, 'export.pending.logistics', 'export.stock.logistics'],
    [other, 'export.pending.other', 'export.stock.other'],
  ];
  for (const [value, pendingKey, stockKey] of pending) {
    if (value.isZero()) continue;
    lines.push(usdLine(await resolveMapping(tx, pendingKey, ctx), value, memo, { segmentId: seg }));
    lines.push(usdLine(await resolveMapping(tx, stockKey, ctx), value.neg(), memo, { segmentId: seg }));
  }
  const date = toDate(input.invoiceDate);
  const year = date.getUTCFullYear();
  const seq = await nextNumber(tx, pa.companyId, year, 'FEX');
  const doc = await tx.document.create({
    data: {
      companyId: pa.companyId, docType: 'EXPORT_INVOICE', number: `${pa.company.code}-FEX-${year}-${String(seq).padStart(6, '0')}`,
      docDate: date, memo: memo.slice(0, 500), createdBy: input.createdBy ?? null,
    },
  });
  const entry = await postEntry(tx, { companyId: pa.companyId, entryDate: input.invoiceDate, kind: 'AUTO', memo: memo.slice(0, 500), documentId: doc.id, createdBy: input.createdBy ?? null, lines });
  const invoice = await tx.exportInvoice.create({
    data: {
      companyId: pa.companyId, partyAccountId: pa.id, sellerPartyAccountId: input.sellerPartyAccountId ?? null, number: input.number,
      invoiceDate: date, service: input.service, internal: input.internal ?? false, description: input.description,
      amountUsd: amount.toFixed(4), factoryUsd: factory.toFixed(4), logisticsUsd: logistics.toFixed(4), otherUsd: other.toFixed(4),
      estimatedUsd: estimated.toFixed(4), commissionUsd: commission.toFixed(4), issueDocumentId: doc.id, createdBy: input.createdBy ?? null,
    },
  });
  const openItem = await createOpenItem(tx, {
    partyAccountId: pa.id, documentId: doc.id, date: input.invoiceDate, dueDate: input.dueDate ?? null,
    amount: amount.toFixed(4), amountUsd: amount.toFixed(4), reference: input.number, description: memo,
  });
  return { invoice, document: doc, entry, openItem };
}

/**
 * Cierra una factura de exportación: pasa de pendiente a venta (900/901, o 1900 si el cliente es interno) y los
 * costos pendientes a costo de ventas (814–816, o 1814–1816), y registra el costo estimado (contra Facimpex
 * pendiente de facturar) y la comisión del vendedor.
 */
export async function closeExportInvoice(tx: Tx, p: { id: string; closeDate: string; createdBy?: string | null }) {
  const inv = await tx.exportInvoice.findUnique({ where: { id: p.id }, include: { partyAccount: { include: { party: true } }, company: true, sellerPartyAccount: true } });
  if (!inv) throw new LedgerError('NOT_FOUND', 'Factura de exportación no encontrada');
  if (inv.status !== 'PENDING') throw new LedgerError('INVALID_INPUT', `La factura ${inv.number} no está pendiente`);
  const closeDate = toDate(p.closeDate);
  if (closeDate < inv.invoiceDate) throw new LedgerError('INVALID_INPUT', 'La fecha de cierre es anterior a la de la factura');
  const ctx = { companyId: inv.companyId };
  const seg = await segmentId(tx, '888');
  const memo = `Cierre de la factura ${inv.number} ${inv.partyAccount.party.name}`;
  const prefix = inv.internal ? 'export.internal' : 'export';
  const salesKey = inv.internal ? 'export.sales.internal' : inv.service === 'GOODS' ? 'export.sales.goods' : 'export.sales.services';
  const amount = money(inv.amountUsd);
  const lines: PostLineInput[] = [
    usdLine(await resolveMapping(tx, 'export.pending.sales', ctx), amount, memo, { segmentId: seg }),
    usdLine(await resolveMapping(tx, salesKey, ctx), amount.neg(), memo, { segmentId: seg }),
  ];
  const costs: [Money, string, string][] = [
    [money(inv.factoryUsd), `${prefix}.cost.factory`, 'export.pending.factory'],
    [money(inv.logisticsUsd), `${prefix}.cost.logistics`, 'export.pending.logistics'],
    [money(inv.otherUsd), `${prefix}.cost.other`, 'export.pending.other'],
  ];
  for (const [value, costKey, pendingKey] of costs) {
    if (value.isZero()) continue;
    lines.push(usdLine(await resolveMapping(tx, costKey, ctx), value, memo, { segmentId: seg }));
    lines.push(usdLine(await resolveMapping(tx, pendingKey, ctx), value.neg(), memo, { segmentId: seg }));
  }
  const estimated = money(inv.estimatedUsd);
  if (!estimated.isZero()) {
    lines.push(usdLine(await resolveMapping(tx, `${prefix}.cost.estimated`, ctx), estimated, `${memo} (costo estimado)`, { segmentId: seg }));
    lines.push(usdLine(await resolveMapping(tx, 'export.stock.estimated', ctx), estimated.neg(), `${memo} (costo estimado)`, { segmentId: seg }));
  }
  const commission = money(inv.commissionUsd);
  if (!commission.isZero() && inv.sellerPartyAccount) {
    lines.push(usdLine(await resolveMapping(tx, `${prefix}.commission`, ctx), commission, `${memo} (comisión)`, { segmentId: seg }));
    lines.push(usdLine(inv.sellerPartyAccount.accountId, commission.neg(), `${memo} (comisión)`, { partyId: inv.sellerPartyAccount.partyId }));
  }
  const year = closeDate.getUTCFullYear();
  const seq = await nextNumber(tx, inv.companyId, year, 'FEX');
  const doc = await tx.document.create({
    data: {
      companyId: inv.companyId, docType: 'EXPORT_INVOICE_CLOSE', number: `${inv.company.code}-FEX-${year}-${String(seq).padStart(6, '0')}`,
      docDate: closeDate, memo, createdBy: p.createdBy ?? null,
    },
  });
  const entry = await postEntry(tx, { companyId: inv.companyId, entryDate: p.closeDate, kind: 'AUTO', memo, documentId: doc.id, createdBy: p.createdBy ?? null, lines });
  if (!commission.isZero() && inv.sellerPartyAccount) {
    await createOpenItem(tx, {
      partyAccountId: inv.sellerPartyAccount.id, documentId: doc.id, date: p.closeDate, amount: commission.neg().toFixed(4),
      amountUsd: commission.neg().toFixed(4), reference: `COM-${inv.number}`, description: `Comisión de la factura ${inv.number}`,
    });
  }
  const invoice = await tx.exportInvoice.update({ where: { id: inv.id }, data: { status: 'CLOSED', closeDate, closeDocumentId: doc.id } });
  return { invoice, document: doc, entry };
}

/** Margen de una factura de exportación (importe − costos − comisión). */
export function exportMargin(inv: { amountUsd: unknown; factoryUsd: unknown; logisticsUsd: unknown; otherUsd: unknown; estimatedUsd: unknown; commissionUsd: unknown }) {
  return money(String(inv.amountUsd))
    .minus(money(String(inv.factoryUsd))).minus(money(String(inv.logisticsUsd))).minus(money(String(inv.otherUsd)))
    .minus(money(String(inv.estimatedUsd))).minus(money(String(inv.commissionUsd)));
}

// ───────────────────────── Distribución: contenedores e inventario ─────────────────────────

/** Existencias (cantidad e importe) de un lote (contenedor × producto) en una ubicación. */
export async function lotBalance(db: Db, p: { containerId: string; productId: string | null; location: InventoryLocation }) {
  const agg = await db.inventoryMovement.aggregate({
    where: { containerId: p.containerId, productId: p.productId, location: p.location },
    _sum: { quantity: true, amountUsd: true },
  });
  return { quantity: money(agg._sum.quantity ?? 0), amountUsd: money(agg._sum.amountUsd ?? 0) };
}

async function containerOrThrow(tx: Tx, id: string) {
  const c = await tx.container.findUnique({ where: { id }, include: { company: true } });
  if (!c) throw new LedgerError('NOT_FOUND', 'Contenedor no encontrado');
  if (c.status === 'CLOSED') throw new LedgerError('INVALID_INPUT', `El contenedor ${c.code} está cerrado`);
  return c;
}

/**
 * Costo de un contenedor (mercancía, flete, aduana…): entra en Mercancías en tránsito (181.9991) mientras el
 * contenedor no se recibe, o en almacén (181.9990) asignado a un producto si ya está recibido. La contrapartida es
 * la cuenta corriente del proveedor (con partida abierta por pagar) o la cuenta indicada.
 */
export async function postContainerCost(
  tx: Tx,
  p: { containerId: string; date: string; amountUsd: string; description: string; productId?: string | null; partyAccountId?: string | null; counterAccountId?: string | null; reference?: string | null; createdBy?: string | null },
) {
  const c = await containerOrThrow(tx, p.containerId);
  const amount = roundAmount(money(p.amountUsd));
  if (amount.isZero()) throw new LedgerError('INVALID_INPUT', 'El importe no puede ser 0');
  const location: InventoryLocation = c.status === 'TRANSIT' ? 'TRANSIT' : 'WAREHOUSE';
  if (location === 'WAREHOUSE' && !p.productId) throw new LedgerError('INVALID_INPUT', 'El contenedor ya está en almacén: indica a qué producto se carga el costo');
  if (!!p.partyAccountId === !!p.counterAccountId) throw new LedgerError('INVALID_INPUT', 'Indica el proveedor o la cuenta de contrapartida (una de las dos)');
  const ctx = { companyId: c.companyId };
  const seg = await segmentId(tx, '999');
  const stock = await resolveMapping(tx, location === 'TRANSIT' ? 'distribution.stock.transit' : 'distribution.stock.warehouse', ctx);
  const memo = `Contenedor ${c.code}: ${p.description}`;
  const lines: PostLineInput[] = [usdLine(stock, amount, memo, { segmentId: seg, containerId: c.id })];
  let supplier = null;
  if (p.partyAccountId) {
    supplier = await usdPartyAccount(tx, p.partyAccountId, 'Proveedor');
    if (supplier.companyId !== c.companyId) throw new LedgerError('INVALID_INPUT', 'El proveedor debe tener cuenta corriente en la empresa del contenedor');
    lines.push(usdLine(supplier.accountId, amount.neg(), memo, { partyId: supplier.partyId }));
  } else {
    lines.push(usdLine(p.counterAccountId!, amount.neg(), memo));
  }
  const date = toDate(p.date);
  const year = date.getUTCFullYear();
  const seq = await nextNumber(tx, c.companyId, year, 'INV');
  const doc = await tx.document.create({
    data: { companyId: c.companyId, docType: 'CONTAINER_COST', number: `${c.company.code}-INV-${year}-${String(seq).padStart(6, '0')}`, docDate: date, memo: memo.slice(0, 500), createdBy: p.createdBy ?? null },
  });
  const entry = await postEntry(tx, { companyId: c.companyId, entryDate: p.date, kind: 'AUTO', memo: memo.slice(0, 500), documentId: doc.id, createdBy: p.createdBy ?? null, lines });
  const movement = await tx.inventoryMovement.create({
    data: { companyId: c.companyId, containerId: c.id, productId: p.productId ?? null, date, kind: 'COST', location, quantity: '0', amountUsd: amount.toFixed(4), description: p.description, documentId: doc.id },
  });
  if (supplier && amount.gt(0)) {
    await createOpenItem(tx, {
      partyAccountId: supplier.id, documentId: doc.id, date: p.date, amount: amount.neg().toFixed(4), amountUsd: amount.neg().toFixed(4),
      reference: p.reference ?? doc.number, description: memo,
    });
  }
  return { document: doc, entry, movement };
}

/**
 * Recepción del contenedor en almacén: reparte el costo acumulado en tránsito entre sus productos (cantidad y
 * costo de cada uno) y lo pasa de 181.9991 a 181.9990. La suma de los costos debe ser el saldo en tránsito.
 */
export async function receiveContainer(
  tx: Tx,
  p: { containerId: string; date: string; lines: { productId: string; quantity: string; amountUsd: string }[]; createdBy?: string | null },
) {
  const c = await containerOrThrow(tx, p.containerId);
  if (c.status !== 'TRANSIT') throw new LedgerError('INVALID_INPUT', `El contenedor ${c.code} ya está recibido`);
  if (!p.lines.length) throw new LedgerError('INVALID_INPUT', 'Indica los productos del contenedor');
  const transit = await tx.inventoryMovement.aggregate({ where: { containerId: c.id, location: 'TRANSIT' }, _sum: { amountUsd: true } });
  const transitUsd = roundAmount(money(transit._sum.amountUsd ?? 0));
  const total = roundAmount(p.lines.reduce((s, l) => s.plus(money(l.amountUsd)), money(0)));
  if (!total.minus(transitUsd).isZero()) {
    throw new LedgerError('INVALID_INPUT', `El reparto (${total.toFixed(2)}) no coincide con el costo en tránsito del contenedor (${transitUsd.toFixed(2)})`);
  }
  for (const l of p.lines) {
    if (money(l.quantity).lte(0)) throw new LedgerError('INVALID_INPUT', 'Las cantidades deben ser positivas');
    if (money(l.amountUsd).lt(0)) throw new LedgerError('INVALID_INPUT', 'Los costos no pueden ser negativos');
  }
  const ctx = { companyId: c.companyId };
  const seg = await segmentId(tx, '999');
  const memo = `Recepción en almacén del contenedor ${c.code}`;
  const date = toDate(p.date);
  const year = date.getUTCFullYear();
  const seq = await nextNumber(tx, c.companyId, year, 'INV');
  const doc = await tx.document.create({
    data: { companyId: c.companyId, docType: 'CONTAINER_RECEIPT', number: `${c.company.code}-INV-${year}-${String(seq).padStart(6, '0')}`, docDate: date, memo, createdBy: p.createdBy ?? null },
  });
  let entry = null;
  if (!transitUsd.isZero()) {
    entry = await postEntry(tx, {
      companyId: c.companyId, entryDate: p.date, kind: 'AUTO', memo, documentId: doc.id, createdBy: p.createdBy ?? null,
      lines: [
        usdLine(await resolveMapping(tx, 'distribution.stock.warehouse', ctx), transitUsd, memo, { segmentId: seg, containerId: c.id }),
        usdLine(await resolveMapping(tx, 'distribution.stock.transit', ctx), transitUsd.neg(), memo, { segmentId: seg, containerId: c.id }),
      ],
    });
  }
  await tx.inventoryMovement.create({
    data: { companyId: c.companyId, containerId: c.id, productId: null, date, kind: 'RECEIPT', location: 'TRANSIT', quantity: '0', amountUsd: transitUsd.neg().toFixed(4), description: memo, documentId: doc.id },
  });
  for (const l of p.lines) {
    await tx.inventoryMovement.create({
      data: {
        companyId: c.companyId, containerId: c.id, productId: l.productId, date, kind: 'RECEIPT', location: 'WAREHOUSE',
        quantity: money(l.quantity).toFixed(4), amountUsd: roundAmount(money(l.amountUsd)).toFixed(4), description: memo, documentId: doc.id,
      },
    });
  }
  const container = await tx.container.update({ where: { id: c.id }, data: { status: 'WAREHOUSE', arrivalDate: date } });
  return { container, document: doc, entry };
}

export interface SalesInvoiceInput {
  companyId: string;
  date: string;
  description: string;
  /** Cliente a crédito (cuenta corriente 137) o, al contado, la cuenta de contrapartida (caja o puente). */
  partyAccountId?: string | null;
  counterAccountId?: string | null;
  /** Aplica la ONAT sobre ventas (parámetro onat.sales_rate). */
  fiscal?: boolean;
  dueDate?: string | null;
  lines: { productId: string; containerId: string; quantity: string; unitPriceUsd: string; commissionPerUnitUsd?: string; sellerPartyAccountId?: string | null }[];
  createdBy?: string | null;
}

/**
 * Factura de venta de distribución: ingreso (900.9990), costo identificado por lote al costo medio del lote
 * (814.9990 contra 181.9990), comisión por unidad del vendedor (824.9990 contra su cuenta corriente 410.9990) y
 * ONAT sobre ventas devengada (830.9990 contra 480.9990).
 */
export async function postSalesInvoice(tx: Tx, input: SalesInvoiceInput) {
  if (!input.lines.length) throw new LedgerError('INVALID_INPUT', 'La factura no tiene líneas');
  if (!!input.partyAccountId === !!input.counterAccountId) throw new LedgerError('INVALID_INPUT', 'Indica el cliente (a crédito) o la cuenta de cobro (al contado)');
  const company = await tx.company.findUnique({ where: { id: input.companyId } });
  if (!company) throw new LedgerError('NOT_FOUND', 'Empresa no encontrada');
  const customer = input.partyAccountId ? await usdPartyAccount(tx, input.partyAccountId, 'Cliente') : null;
  if (customer && customer.companyId !== company.id) throw new LedgerError('INVALID_INPUT', 'El cliente debe tener cuenta corriente en la empresa de la factura');
  const date = toDate(input.date);
  const fiscal = input.fiscal ?? true;
  const onatRate = fiscal ? money(await getParam<string>(tx, 'onat.sales_rate', date)) : money(0);
  const ctx = { companyId: company.id };
  const seg = await segmentId(tx, '999');
  const accounts = {
    sales: await resolveMapping(tx, 'distribution.sales', ctx),
    cost: await resolveMapping(tx, 'distribution.cost', ctx),
    stock: await resolveMapping(tx, 'distribution.stock.warehouse', ctx),
    commission: await resolveMapping(tx, 'distribution.commission', ctx),
    onat: onatRate.isZero() ? null : await resolveMapping(tx, 'onat.expense', ctx),
    onatPayable: onatRate.isZero() ? null : await resolveMapping(tx, 'onat.payable', ctx),
  };
  const year = date.getUTCFullYear();
  const seq = await nextNumber(tx, company.id, year, 'FAC');
  const number = `${company.code}-FAC-${year}-${String(seq).padStart(6, '0')}`;
  const memo = `Factura ${number}: ${input.description}`;
  const doc = await tx.document.create({
    data: { companyId: company.id, docType: 'SALES_INVOICE', number, docDate: date, memo: memo.slice(0, 500), createdBy: input.createdBy ?? null },
  });

  const lines: PostLineInput[] = [];
  const computed: { input: SalesInvoiceInput['lines'][number]; amount: Money; cost: Money; commission: Money; onat: Money; seller: Awaited<ReturnType<typeof usdPartyAccount>> | null }[] = [];
  // Existencias consumidas en esta misma factura (dos líneas del mismo lote).
  const used = new Map<string, { quantity: Money; amount: Money }>();
  for (const l of input.lines) {
    const qty = money(l.quantity);
    const price = money(l.unitPriceUsd);
    if (qty.lte(0)) throw new LedgerError('INVALID_INPUT', 'Las cantidades deben ser positivas');
    if (price.lt(0)) throw new LedgerError('INVALID_INPUT', 'El precio no puede ser negativo');
    const container = await tx.container.findUnique({ where: { id: l.containerId } });
    if (!container || container.companyId !== company.id) throw new LedgerError('NOT_FOUND', 'Contenedor no encontrado en la empresa de la factura');
    const product = await tx.product.findUnique({ where: { id: l.productId } });
    if (!product) throw new LedgerError('NOT_FOUND', 'Producto no encontrado');
    const key = `${l.containerId}|${l.productId}`;
    const lot = await lotBalance(tx, { containerId: l.containerId, productId: l.productId, location: 'WAREHOUSE' });
    const u = used.get(key) ?? { quantity: money(0), amount: money(0) };
    const available = lot.quantity.minus(u.quantity);
    if (available.lt(qty)) {
      throw new LedgerError('INVALID_INPUT', `No hay existencias suficientes de ${product.name} en el contenedor ${container.code} (quedan ${available.toFixed(2)})`);
    }
    const remainingValue = lot.amountUsd.minus(u.amount);
    // Costo medio del lote; la última salida se lleva el resto (sin residuos de redondeo).
    const cost = available.eq(qty) ? roundAmount(remainingValue) : roundAmount(remainingValue.div(available).times(qty));
    used.set(key, { quantity: u.quantity.plus(qty), amount: u.amount.plus(cost) });
    const amount = roundAmount(price.times(qty));
    const commission = roundAmount(money(l.commissionPerUnitUsd ?? 0).times(qty));
    if (commission.lt(0)) throw new LedgerError('INVALID_INPUT', 'La comisión no puede ser negativa');
    if (!commission.isZero() && !l.sellerPartyAccountId) throw new LedgerError('INVALID_INPUT', 'Indica el vendedor de las líneas con comisión');
    const seller = l.sellerPartyAccountId ? await usdPartyAccount(tx, l.sellerPartyAccountId, 'Vendedor') : null;
    if (seller && seller.companyId !== company.id) throw new LedgerError('INVALID_INPUT', 'El vendedor debe tener cuenta corriente en la empresa de la factura');
    const onat = roundAmount(amount.times(onatRate));
    computed.push({ input: l, amount, cost, commission, onat, seller });
    const lm = `${memo} · ${product.name} × ${qty.toFixed(2)}`;
    lines.push(usdLine(accounts.sales, amount.neg(), lm, { segmentId: seg, containerId: container.id }));
    if (!cost.isZero()) {
      lines.push(usdLine(accounts.cost, cost, lm, { segmentId: seg, containerId: container.id }));
      lines.push(usdLine(accounts.stock, cost.neg(), lm, { segmentId: seg, containerId: container.id }));
    }
    if (!commission.isZero()) {
      lines.push(usdLine(accounts.commission, commission, `${lm} (comisión)`, { segmentId: seg, containerId: container.id }));
      lines.push(usdLine(seller!.accountId, commission.neg(), `${lm} (comisión)`, { partyId: seller!.partyId }));
    }
    if (!onat.isZero()) {
      lines.push(usdLine(accounts.onat!, onat, `${lm} (ONAT)`, { segmentId: seg, containerId: container.id }));
      lines.push(usdLine(accounts.onatPayable!, onat.neg(), `${lm} (ONAT)`));
    }
  }
  const total = computed.reduce((s, c) => s.plus(c.amount), money(0));
  if (total.isZero()) throw new LedgerError('INVALID_INPUT', 'La factura no tiene importe');
  lines.unshift(customer
    ? usdLine(customer.accountId, total, memo, { partyId: customer.partyId, segmentId: seg })
    : usdLine(input.counterAccountId!, total, memo, { segmentId: seg }));
  const entry = await postEntry(tx, { companyId: company.id, entryDate: input.date, kind: 'AUTO', memo: memo.slice(0, 500), documentId: doc.id, createdBy: input.createdBy ?? null, lines });

  const sum = (f: (c: (typeof computed)[number]) => Money) => computed.reduce((s, c) => s.plus(f(c)), money(0));
  const invoice = await tx.salesInvoice.create({
    data: {
      id: doc.id, partyAccountId: customer?.id ?? null, counterAccountId: input.counterAccountId ?? null,
      totalUsd: total.toFixed(4), costUsd: sum((c) => c.cost).toFixed(4), commissionUsd: sum((c) => c.commission).toFixed(4),
      onatUsd: sum((c) => c.onat).toFixed(4), onatRate: onatRate.toFixed(6),
    },
  });
  for (const c of computed) {
    const line = await tx.salesLine.create({
      data: {
        invoiceId: invoice.id, productId: c.input.productId, containerId: c.input.containerId, quantity: money(c.input.quantity).toFixed(4),
        unitPriceUsd: money(c.input.unitPriceUsd).toFixed(4), amountUsd: c.amount.toFixed(4), costUsd: c.cost.toFixed(4),
        commissionPerUnitUsd: money(c.input.commissionPerUnitUsd ?? 0).toFixed(4), commissionUsd: c.commission.toFixed(4),
        sellerPartyAccountId: c.seller?.id ?? null, onatUsd: c.onat.toFixed(4),
      },
    });
    await tx.inventoryMovement.create({
      data: {
        companyId: company.id, containerId: c.input.containerId, productId: c.input.productId, date, kind: 'SALE', location: 'WAREHOUSE',
        quantity: money(c.input.quantity).neg().toFixed(4), amountUsd: c.cost.neg().toFixed(4), description: memo.slice(0, 500), documentId: doc.id, salesLineId: line.id,
      },
    });
  }
  const openItem = customer ? await createOpenItem(tx, {
    partyAccountId: customer.id, documentId: doc.id, date: input.date, dueDate: input.dueDate ?? null,
    amount: total.toFixed(4), amountUsd: total.toFixed(4), reference: number, description: memo,
  }) : null;
  return { invoice, document: doc, entry, openItem };
}

// ───────────────────────── Informes ─────────────────────────

/** Kardex de un producto: movimientos con existencias y valor acumulados (almacén). */
export async function productKardex(db: Db, p: { productId: string; containerId?: string | null }) {
  const moves = await db.inventoryMovement.findMany({
    where: { productId: p.productId, location: 'WAREHOUSE', ...(p.containerId ? { containerId: p.containerId } : {}) },
    include: { container: { select: { code: true } }, document: { select: { number: true } } },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });
  let qty = money(0);
  let value = money(0);
  return moves.map((m) => {
    qty = qty.plus(money(m.quantity));
    value = value.plus(money(m.amountUsd));
    return {
      id: m.id, date: m.date.toISOString().slice(0, 10), kind: m.kind, container: m.container.code, document: m.document.number, description: m.description,
      quantity: money(m.quantity).toFixed(4), amountUsd: money(m.amountUsd).toFixed(4), balanceQuantity: qty.toFixed(4), balanceUsd: value.toFixed(4),
    };
  });
}

/**
 * Utilidad por contenedor: ventas, costo de ventas, comisiones y ONAT de sus facturas, costo total del contenedor,
 * existencias que quedan y reparto de la utilidad entre inversionistas (% de utilidad).
 */
export async function containerUtility(db: Db, p: { companyId?: string | null; containerId?: string | null }) {
  const containers = await db.container.findMany({
    where: { ...(p.companyId ? { companyId: p.companyId } : {}), ...(p.containerId ? { id: p.containerId } : {}) },
    include: { investors: { include: { partyAccount: { include: { party: true } } } } },
    orderBy: { code: 'asc' },
  });
  const out = [];
  for (const c of containers) {
    const sales = await db.salesLine.aggregate({
      where: { containerId: c.id, invoice: { status: 'POSTED' } },
      _sum: { amountUsd: true, costUsd: true, commissionUsd: true, onatUsd: true, quantity: true },
    });
    const costs = await db.inventoryMovement.aggregate({ where: { containerId: c.id, kind: 'COST' }, _sum: { amountUsd: true } });
    const stock = await db.inventoryMovement.aggregate({ where: { containerId: c.id }, _sum: { amountUsd: true } });
    const stockQty = await db.inventoryMovement.aggregate({ where: { containerId: c.id, location: 'WAREHOUSE' }, _sum: { quantity: true } });
    const revenue = money(sales._sum.amountUsd ?? 0);
    const cost = money(sales._sum.costUsd ?? 0);
    const commission = money(sales._sum.commissionUsd ?? 0);
    const onat = money(sales._sum.onatUsd ?? 0);
    const utility = revenue.minus(cost).minus(commission).minus(onat);
    out.push({
      id: c.id, code: c.code, description: c.description, status: c.status, arrivalDate: c.arrivalDate?.toISOString().slice(0, 10) ?? null,
      totalCostUsd: money(costs._sum.amountUsd ?? 0).toFixed(4), soldQuantity: money(sales._sum.quantity ?? 0).toFixed(4),
      revenueUsd: revenue.toFixed(4), costOfSalesUsd: cost.toFixed(4), commissionUsd: commission.toFixed(4), onatUsd: onat.toFixed(4),
      utilityUsd: utility.toFixed(4), marginPct: revenue.isZero() ? null : utility.div(revenue).times(100).toFixed(2),
      stockQuantity: money(stockQty._sum.quantity ?? 0).toFixed(4), stockUsd: money(stock._sum.amountUsd ?? 0).toFixed(4),
      investors: c.investors.map((i) => ({
        id: i.id, partyAccountId: i.partyAccountId, partyId: i.partyAccount.partyId, name: i.partyAccount.party.name,
        investedUsd: money(i.investedUsd).toFixed(4), profitPct: money(i.profitPct).toFixed(4),
        shareUsd: roundAmount(utility.times(money(i.profitPct)).div(100)).toFixed(4),
      })),
    });
  }
  return out;
}

/** Comisiones de distribución por vendedor y semana (lunes), para la liquidación semanal. */
export async function commissionsBySeller(db: Db, p: { from: string; to: string; companyId?: string | null }) {
  const lines = await db.salesLine.findMany({
    where: {
      commissionUsd: { gt: 0 }, invoice: { status: 'POSTED', document: { docDate: { gte: toDate(p.from), lte: toDate(p.to) }, ...(p.companyId ? { companyId: p.companyId } : {}) } },
    },
    include: { invoice: { include: { document: true } }, sellerPartyAccount: { include: { party: true } }, product: true },
  });
  const groups = new Map<string, { sellerPartyAccountId: string; partyId: string; seller: string; week: string; units: Money; salesUsd: Money; commissionUsd: Money; invoices: Set<string> }>();
  for (const l of lines) {
    if (!l.sellerPartyAccount) continue;
    const d = l.invoice.document.docDate;
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    const k = `${l.sellerPartyAccountId}|${monday}`;
    const g = groups.get(k) ?? {
      sellerPartyAccountId: l.sellerPartyAccount.id, partyId: l.sellerPartyAccount.partyId, seller: l.sellerPartyAccount.party.name, week: monday,
      units: money(0), salesUsd: money(0), commissionUsd: money(0), invoices: new Set<string>(),
    };
    g.units = g.units.plus(money(l.quantity));
    g.salesUsd = g.salesUsd.plus(money(l.amountUsd));
    g.commissionUsd = g.commissionUsd.plus(money(l.commissionUsd));
    g.invoices.add(l.invoice.document.number);
    groups.set(k, g);
  }
  return [...groups.values()]
    .sort((a, b) => (a.week === b.week ? a.seller.localeCompare(b.seller) : a.week < b.week ? 1 : -1))
    .map((g) => ({ ...g, units: g.units.toFixed(4), salesUsd: g.salesUsd.toFixed(4), commissionUsd: g.commissionUsd.toFixed(4), invoices: [...g.invoices] }));
}
