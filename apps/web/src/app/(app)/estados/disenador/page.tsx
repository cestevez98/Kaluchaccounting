'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { parseFormula, REPORT_LINE_SOURCES, REPORT_SOURCE_LABELS, type ReportLineSource } from '@kaluch/shared';
import { Suspense, useEffect, useState } from 'react';
import { Alert, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';

interface EditLine {
  key: string; label: string; source: ReportLineSource; accounts: string[]; categories: string[]; cashFlow: string | null;
  formula: string | null; negate: boolean; indent: number; bold: boolean; option: string | null;
}
interface TemplateDetail {
  code: string; name: string; kind: 'BALANCE' | 'INCOME' | 'CASHFLOW'; origin: string; notes: string; active: boolean; checkCoverage: boolean; lines: EditLine[];
}
interface TemplateRow { code: string; name: string; kind: string; origin: string; active: boolean }

const KIND_LABEL = { BALANCE: 'Estado de situación (saldos a fin de mes)', INCOME: 'Estado de resultados (movimiento del mes)', CASHFLOW: 'Flujo de efectivo (caja y bancos)' };
const blankLine = (n: number): EditLine => ({
  key: `L${n}`, label: '', source: 'NONE', accounts: [], categories: [], cashFlow: null, formula: null, negate: false, indent: 0, bold: false, option: null,
});

function formulaError(f: string | null) {
  if (!f?.trim()) return 'Escribe la fórmula';
  try {
    parseFormula(f);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function DesignerInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useSession();
  const code = params.get('code') ?? '';
  const { data: list, reload: reloadList } = useApi<TemplateRow[]>('/statements/templates');
  const { data: loaded, error, loading } = useApi<TemplateDetail>(code ? `/statements/templates/${encodeURIComponent(code)}` : null);
  const [t, setT] = useState<TemplateDetail | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [newCode, setNewCode] = useState('');

  useEffect(() => {
    if (loaded) setT(structuredClone(loaded));
  }, [loaded]);
  useEffect(() => {
    if (!code && list?.length) router.replace(`/estados/disenador?code=${encodeURIComponent(list[0]!.code)}`);
  }, [code, list, router]);

  const set = (i: number, patch: Partial<EditLine>) => setT((x) => (x ? { ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) } : x));
  const move = (i: number, d: -1 | 1) => setT((x) => {
    if (!x) return x;
    const lines = [...x.lines];
    const j = i + d;
    if (j < 0 || j >= lines.length) return x;
    [lines[i], lines[j]] = [lines[j]!, lines[i]!];
    return { ...x, lines };
  });
  const insert = (i: number) => setT((x) => (x ? { ...x, lines: [...x.lines.slice(0, i + 1), blankLine(x.lines.length + 1), ...x.lines.slice(i + 1)] } : x));
  const remove = (i: number) => setT((x) => (x ? { ...x, lines: x.lines.filter((_, j) => j !== i) } : x));

  async function save(asCode?: string) {
    if (!t) return;
    setSaving(true);
    setMsg(null);
    const target = asCode ?? t.code;
    try {
      await api(`/statements/templates/${encodeURIComponent(target)}`, {
        method: 'PUT',
        json: {
          code: target, name: asCode ? `${t.name} (copia)` : t.name, kind: t.kind, notes: t.notes, active: t.active, checkCoverage: t.checkCoverage,
          lines: t.lines.map((l) => ({ ...l, formula: l.source === 'FORMULA' ? l.formula : null })),
        },
      });
      setMsg({ kind: 'success', text: asCode ? `Plantilla ${target} creada.` : 'Plantilla guardada.' });
      reloadList();
      if (asCode) router.replace(`/estados/disenador?code=${encodeURIComponent(target)}`);
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? `${e.message}${e.issues?.length ? `: ${e.issues.map((x) => `${x.path} ${x.message}`).join(' · ')}` : ''}` : 'Error al guardar' });
    } finally {
      setSaving(false);
    }
  }

  const editable = can('reports:design');
  return (
    <div>
      <PageHeader
        title="Diseñador de estados financieros"
        subtitle="Cada línea suma cuentas del plan (una cuenta de grupo incluye sus subcuentas) o es una fórmula sobre otras líneas: [clave], + − * /, SUM([a]:[b]), MIN, MAX, ABS."
        actions={t && <Link className="btn-secondary" href={`/estados?code=${encodeURIComponent(t.code)}`}>Ver el estado</Link>}
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-3">
        <div>
          <label className="label" htmlFor="tpl">Plantilla</label>
          <select id="tpl" className="input" value={code} onChange={(e) => router.replace(`/estados/disenador?code=${encodeURIComponent(e.target.value)}`)}>
            {list?.map((x) => <option key={x.code} value={x.code}>{x.code} · {x.name}{x.active ? '' : ' (inactiva)'}</option>)}
          </select>
        </div>
        {editable && t && (
          <div className="flex items-end gap-2">
            <div>
              <label className="label" htmlFor="new-code">Copiar como</label>
              <input id="new-code" className="input w-36" placeholder="Código nuevo" value={newCode} onChange={(e) => setNewCode(e.target.value.toUpperCase())} />
            </div>
            <button className="btn-secondary" disabled={!newCode.trim() || saving} onClick={() => save(newCode.trim())}>Crear copia</button>
          </div>
        )}
      </div>
      {error && <Alert>{error.message}</Alert>}
      {msg && <div className="mb-3"><Alert kind={msg.kind}>{msg.text}</Alert></div>}
      {loading && !t && <Spinner />}
      {t && (
        <>
          <div className="card mb-4 grid gap-3 p-3 md:grid-cols-3">
            <div>
              <label className="label" htmlFor="tpl-name">Nombre</label>
              <input id="tpl-name" className="input w-full" value={t.name} disabled={!editable} onChange={(e) => setT({ ...t, name: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="tpl-kind">Tipo</label>
              <select id="tpl-kind" className="input w-full" value={t.kind} disabled={!editable} onChange={(e) => setT({ ...t, kind: e.target.value as TemplateDetail['kind'] })}>
                {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div className="flex items-end gap-4 text-xs">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={t.active} disabled={!editable} onChange={(e) => setT({ ...t, active: e.target.checked })} /> Activa</label>
              <label className="flex items-center gap-1.5" title="Avisa de las cuentas con importe que no están en ninguna línea">
                <input type="checkbox" checked={t.checkCoverage} disabled={!editable} onChange={(e) => setT({ ...t, checkCoverage: e.target.checked })} /> Avisar de cuentas sin línea
              </label>
            </div>
            <div className="md:col-span-3">
              <label className="label" htmlFor="tpl-notes">Notas</label>
              <textarea id="tpl-notes" className="input min-h-16 w-full" value={t.notes} disabled={!editable} onChange={(e) => setT({ ...t, notes: e.target.value })} />
            </div>
          </div>

          <div className="card overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-24">Clave</th><th className="min-w-[220px]">Texto</th><th className="w-14">Sangría</th><th className="w-10">Negrita</th>
                  <th className="w-44">Origen</th><th className="min-w-[260px]">Cuentas / fórmula / categorías</th><th className="w-14" title="Cambiar el signo al presentar">±</th>
                  {editable && <th className="w-32" />}
                </tr>
              </thead>
              <tbody>
                {t.lines.map((l, i) => {
                  const ferr = l.source === 'FORMULA' ? formulaError(l.formula) : null;
                  return (
                    <tr key={i}>
                      <td><input aria-label="Clave" className="input h-7 w-full font-mono text-xs" value={l.key} disabled={!editable} onChange={(e) => set(i, { key: e.target.value })} /></td>
                      <td><input aria-label="Texto" className={`input h-7 w-full text-xs ${l.bold ? 'font-bold' : ''}`} value={l.label} disabled={!editable} onChange={(e) => set(i, { label: e.target.value })} /></td>
                      <td><input aria-label="Sangría" type="number" min={0} max={6} className="input h-7 w-14 text-xs" value={l.indent} disabled={!editable} onChange={(e) => set(i, { indent: Number(e.target.value) })} /></td>
                      <td className="text-center"><input aria-label="Negrita" type="checkbox" checked={l.bold} disabled={!editable} onChange={(e) => set(i, { bold: e.target.checked })} /></td>
                      <td>
                        <select aria-label="Origen" className="input h-7 w-full text-xs" value={l.source} disabled={!editable} onChange={(e) => set(i, { source: e.target.value as ReportLineSource })}>
                          {REPORT_LINE_SOURCES.map((s) => <option key={s} value={s}>{REPORT_SOURCE_LABELS[s]}</option>)}
                        </select>
                      </td>
                      <td>
                        {l.source === 'ACCOUNTS' && (
                          <input aria-label="Cuentas" className="input h-7 w-full font-mono text-xs" placeholder="900.8880, 901.8880" value={l.accounts.join(', ')} disabled={!editable}
                            onChange={(e) => set(i, { accounts: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
                        )}
                        {l.source === 'UNMAPPED' && (
                          <input aria-label="Clasificaciones" className="input h-7 w-full font-mono text-xs" placeholder="AC, PC, CC, CND, CNA" value={l.accounts.join(', ')} disabled={!editable}
                            onChange={(e) => set(i, { accounts: e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) })} />
                        )}
                        {l.source === 'FORMULA' && (
                          <div>
                            <input aria-label="Fórmula" className={`input h-7 w-full font-mono text-xs ${ferr ? 'border-bad' : ''}`} placeholder="[F4]+[F13]" value={l.formula ?? ''} disabled={!editable}
                              onChange={(e) => set(i, { formula: e.target.value })} />
                            {ferr && <div className="mt-0.5 text-[10px] text-bad">{ferr}</div>}
                          </div>
                        )}
                        {l.source === 'CASH' && (
                          <div className="flex gap-1">
                            <input aria-label="Categorías" className="input h-7 flex-1 text-xs" placeholder="Categorías de tesorería (separadas por ;) o vacío = el resto" value={l.categories.join('; ')} disabled={!editable}
                              onChange={(e) => set(i, { categories: e.target.value.split(';').map((x) => x.trim()).filter(Boolean) })} />
                            <select aria-label="Actividad" className="input h-7 w-24 text-xs" value={l.cashFlow ?? ''} disabled={!editable} onChange={(e) => set(i, { cashFlow: e.target.value || null })}>
                              <option value="">—</option><option value="OPER">Explotación</option><option value="INV">Inversión</option><option value="FIN">Financiación</option>
                            </select>
                          </div>
                        )}
                        {l.source === 'RESULT_YTD' && (
                          <select aria-label="Resultado" className="input h-7 text-xs" value={l.option ?? ''} disabled={!editable} onChange={(e) => set(i, { option: e.target.value || null })}>
                            <option value="">Todas las cuentas de resultados</option>
                            <option value="REALIZADO">Realizado (sin exportación pendiente de cierre)</option>
                            <option value="PENDIENTE">Solo exportación pendiente de cierre</option>
                          </select>
                        )}
                        {l.source === 'CASH_BALANCE' && (
                          <select aria-label="Saldo" className="input h-7 text-xs" value={l.option ?? 'CLOSING'} disabled={!editable} onChange={(e) => set(i, { option: e.target.value })}>
                            <option value="OPENING">Saldo inicial del mes</option><option value="CLOSING">Saldo final del mes</option>
                          </select>
                        )}
                      </td>
                      <td className="text-center"><input aria-label="Cambiar signo" type="checkbox" checked={l.negate} disabled={!editable} onChange={(e) => set(i, { negate: e.target.checked })} /></td>
                      {editable && (
                        <td className="whitespace-nowrap text-xs">
                          <button className="px-1 hover:text-brand-600" title="Subir" onClick={() => move(i, -1)}>↑</button>
                          <button className="px-1 hover:text-brand-600" title="Bajar" onClick={() => move(i, 1)}>↓</button>
                          <button className="px-1 hover:text-brand-600" title="Insertar línea debajo" onClick={() => insert(i)}>＋</button>
                          <button className="px-1 hover:text-bad" title="Quitar la línea" onClick={() => remove(i)}>✕</button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {editable && (
            <div className="mt-3 flex gap-2">
              <button className="btn-primary" disabled={saving} onClick={() => save()}>{saving ? 'Guardando…' : 'Guardar plantilla'}</button>
              <button className="btn-secondary" onClick={() => setT((x) => (x ? { ...x, lines: [...x.lines, blankLine(x.lines.length + 1)] } : x))}>Añadir línea al final</button>
              <button className="btn-secondary" onClick={() => loaded && setT(structuredClone(loaded))}>Descartar cambios</button>
            </div>
          )}
          {!editable && <p className="mt-3 text-xs text-muted">Solo lectura: diseñar plantillas requiere el permiso “Diseñar las plantillas de los estados financieros”.</p>}
        </>
      )}
    </div>
  );
}

export default function DesignerPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <DesignerInner />
    </Suspense>
  );
}
