'use client';
import { useEffect, useMemo, useState } from 'react';
import { supabase, mx } from '@/lib/supabase';

type Row = { name: string; qty: number; cents: number };
type Report = {
  totals: { cents: number; tickets: number; items: number; voided: number; voided_cents: number };
  prev: { cents: number; tickets: number };
  by_pay: { method: 'cash' | 'card' | 'spei'; cents: number; tickets: number }[];
  top: Row[]; by_cat: Row[];
  by_hour: { hour: number; cents: number; tickets: number }[];
  by_day: { day: string; cents: number; tickets: number }[];
  by_emp: { name: string; cents: number; tickets: number }[];
  recent: { id: number; at: string; employee: string; total_cents: number; pay_method: string; voided: boolean }[];
};

const PERIODS = [['hoy', 'Hoy'], ['ayer', 'Ayer'], ['7', '7 días'], ['30', '30 días'], ['mes', 'Este mes']] as const;
type Period = typeof PERIODS[number][0];
const PAY: Record<string, string> = { cash: 'Efectivo', card: 'Tarjeta', spei: 'Transferencia' };
const day0 = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function range(p: Period): [Date, Date] {
  const t = day0();
  if (p === 'hoy') return [t, addDays(t, 1)];
  if (p === 'ayer') return [addDays(t, -1), t];
  if (p === '7') return [addDays(t, -6), addDays(t, 1)];
  if (p === '30') return [addDays(t, -29), addDays(t, 1)];
  return [new Date(t.getFullYear(), t.getMonth(), 1), new Date(t.getFullYear(), t.getMonth() + 1, 1)];
}

const hr = (h: number) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;

function Bars({ rows, fmt }: { rows: { label: string; value: number; sub?: string }[]; fmt: (n: number) => string }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return <>{rows.map((r, i) => <div className="hb" key={i}>
    <div className="hb-top"><span className="hb-l">{r.label}</span><b>{fmt(r.value)}</b></div>
    <div className="hb-track"><div className="hb-fill" style={{ width: `${(r.value / max) * 100}%` }} /></div>
    {r.sub && <small>{r.sub}</small>}
  </div>)}</>;
}

function Delta({ now, before, short }: { now: number; before: number; short?: boolean }) {
  if (!before) return <small className="dl">—</small>;
  const p = Math.round(((now - before) / before) * 100);
  return <small className={'dl ' + (p >= 0 ? 'up' : 'down')}>{p >= 0 ? '▲' : '▼'} {Math.abs(p)}%{short ? '' : ' vs. periodo anterior'}</small>;
}

export default function Reports({ pin, onClose }: { pin: string; onClose: () => void }) {
  const [period, setPeriod] = useState<Period>('hoy');
  const [data, setData] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const [byMoney, setByMoney] = useState(false);

  const load = async () => {
    setErr('');
    const [from, to] = range(period);
    const { data, error } = await supabase.rpc('sales_report', { p_admin_pin: pin, p_from: from.toISOString(), p_to: to.toISOString() });
    if (error) { setErr(error.message); setData(null); } else setData(data as Report);
  };
  useEffect(() => { setData(null); load(); }, [period]);

  async function anular(id: number) {
    if (!confirm(`¿Anular la venta #${id}? Se regresa el inventario.`)) return;
    const { error } = await supabase.rpc('void_sale', { p_admin_pin: pin, p_sale_id: id });
    if (error) setErr(error.message); else load();
  }

  const view = useMemo(() => {
    if (!data) return null;
    const hours = data.by_hour;
    const peak = hours.length ? hours.reduce((a, b) => (b.cents > a.cents ? b : a)) : null;
    const best = data.by_day.length ? data.by_day.reduce((a, b) => (b.cents > a.cents ? b : a)) : null;
    const avg = data.totals.tickets ? Math.round(data.totals.cents / data.totals.tickets) : 0;
    const h0 = hours.length ? Math.min(...hours.map(h => h.hour)) : 0, h1 = hours.length ? Math.max(...hours.map(h => h.hour)) : 0;
    const full = Array.from({ length: h1 - h0 + 1 }, (_, i) => hours.find(h => h.hour === h0 + i) ?? { hour: h0 + i, cents: 0, tickets: 0 });
    const maxH = Math.max(1, ...full.map(h => h.cents));
    const top = [...data.top].sort((a, b) => (byMoney ? b.cents - a.cents : b.qty - a.qty));
    return { peak, best, avg, full, maxH, top };
  }, [data, byMoney]);

  const t = data?.totals;
  return <div className="rep">
    <div className="rep-head">
      <button onClick={onClose} aria-label="Volver">‹</button><b>Ventas</b><span />
    </div>
    <div className="rep-body">
      <div className="rep-tabs">
        {PERIODS.map(([k, l]) => <button key={k} className={k === period ? 'on' : ''} onClick={() => setPeriod(k)}>{l}</button>)}
      </div>
      {err && <p className="err">{err}</p>}
      {!data && !err && <p className="center">Cargando…</p>}
      {data && t && view && <>
        <div className="kpis">
          <div className="kpi big"><small>Ventas</small><b>{mx(t.cents)}</b><Delta now={t.cents} before={data.prev.cents} /></div>
          <div className="kpi"><small>Tickets</small><b>{t.tickets}</b><Delta short now={t.tickets} before={data.prev.tickets} /></div>
          <div className="kpi"><small>Promedio</small><b>{mx(view.avg)}</b></div>
          <div className="kpi"><small>Artículos</small><b>{t.items}</b></div>
        </div>
        {t.tickets === 0 && <p className="center muted">Todavía no hay ventas en este periodo.</p>}

        {data.top.length > 0 && <section className="sec">
          <div className="sec-h"><h3>🏆 Más vendidos</h3>
            <div className="seg"><button className={!byMoney ? 'on' : ''} onClick={() => setByMoney(false)}>Piezas</button>
              <button className={byMoney ? 'on' : ''} onClick={() => setByMoney(true)}>Dinero</button></div></div>
          <Bars rows={view.top.map((r, i) => ({ label: `${i + 1}. ${r.name}`, value: byMoney ? r.cents : r.qty, sub: byMoney ? `${r.qty} pzas` : mx(r.cents) }))}
            fmt={n => byMoney ? mx(n) : `${n} pzas`} />
        </section>}

        {view.peak && <section className="sec">
          <h3>🕐 Ventas por hora</h3>
          <p className="muted">Hora pico: <b>{view.peak.hour % 12 || 12}{view.peak.hour < 12 ? ' am' : ' pm'}</b> · {mx(view.peak.cents)}</p>
          <div className="vbars">{view.full.map(h => <div key={h.hour} className="vb" title={`${mx(h.cents)} · ${h.tickets} tickets`}>
            <div className={'vb-fill' + (h.hour === view.peak!.hour ? ' pk' : '')} style={{ height: `${(h.cents / view.maxH) * 100}%` }} />
            <span>{hr(h.hour)}</span></div>)}</div>
        </section>}

        {data.by_day.length > 1 && <section className="sec">
          <h3>📅 Por día</h3>
          {view.best && <p className="muted">Mejor día: <b>{new Date(view.best.day + 'T12:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' })}</b> · {mx(view.best.cents)}</p>}
          <Bars rows={data.by_day.map(d => ({ label: new Date(d.day + 'T12:00').toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric' }), value: d.cents, sub: `${d.tickets} tickets` }))} fmt={mx} />
        </section>}

        {data.by_cat.length > 0 && <section className="sec"><h3>🍽️ Por categoría</h3>
          <Bars rows={data.by_cat.map(c => ({ label: c.name, value: c.cents, sub: `${c.qty} pzas` }))} fmt={mx} /></section>}

        {data.by_pay.length > 0 && <section className="sec"><h3>💳 Forma de pago</h3>
          <Bars rows={data.by_pay.map(p => ({ label: PAY[p.method] ?? p.method, value: p.cents, sub: `${p.tickets} tickets · ${Math.round((p.cents / Math.max(1, t.cents)) * 100)}%` }))} fmt={mx} /></section>}

        {data.by_emp.length > 1 && <section className="sec"><h3>👤 Por empleado</h3>
          <Bars rows={data.by_emp.map(p => ({ label: p.name, value: p.cents, sub: `${p.tickets} tickets` }))} fmt={mx} /></section>}

        {t.voided > 0 && <p className="muted center">Anuladas: {t.voided} ({mx(t.voided_cents)}), no incluidas arriba.</p>}

        <section className="sec"><h3>🧾 Últimas ventas</h3>
          {data.recent.length === 0 && <p className="muted">Sin ventas.</p>}
          {data.recent.map(r => <div className={'row sale' + (r.voided ? ' void' : '')} key={r.id}>
            <span>#{r.id} · {new Date(r.at).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}<br />
              <small>{r.employee} · {PAY[r.pay_method] ?? r.pay_method}{r.voided ? ' · ANULADA' : ''}</small></span>
            <span><b>{mx(r.total_cents)}</b>{!r.voided && <><br /><button className="lnk" onClick={() => anular(r.id)}>Anular</button></>}</span>
          </div>)}
        </section>
      </>}
    </div>
  </div>;
}
