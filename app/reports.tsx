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

const sv = (d: React.ReactNode) => <svg viewBox="0 0 24 24" className="ico">{d}</svg>;
const R = {
  bars: sv(<><path d="M5 20V12M12 20V5M19 20V9" strokeWidth="3.4" /></>),
  doc: sv(<><path d="M7 3h8l4 4v14H7z" /><path d="M15 3v4h4M10 12h6M10 16h6" /></>),
  coins: sv(<><ellipse cx="12" cy="7" rx="7" ry="3" /><path d="M5 7v5c0 1.700 3.100 3 7 3s7-1.300 7-3V7M5 12v5c0 1.700 3.100 3 7 3s7-1.300 7-3v-5" /></>),
  box: sv(<><path d="M12 3 4 7v10l8 4 8-4V7z" /><path d="M4 7l8 4 8-4M12 11v10" /></>),
  trophy: sv(<><path d="M8 4h8v6a4 4 0 0 1-8 0zM8 6H4v1a4 4 0 0 0 4 4M16 6h4v1a4 4 0 0 1-4 4M12 14v4M8 21h8M10 18h4" /></>),
  clock: sv(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  cal: sv(<><rect x="3.500" y="5" width="17" height="16" rx="2" /><path d="M3.500 10h17M8 3v4M16 3v4" /></>),
  grid: sv(<><rect x="4" y="4" width="7" height="7" rx="1.500" /><rect x="13" y="4" width="7" height="7" rx="1.500" /><rect x="4" y="13" width="7" height="7" rx="1.500" /><rect x="13" y="13" width="7" height="7" rx="1.500" /></>),
  card: sv(<><rect x="2.500" y="5" width="19" height="14" rx="2.500" /><path d="M2.500 10h19M6 15h4" /></>),
  user: sv(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>),
  back: sv(<path d="m15 5-7 7 7 7" strokeWidth="2.800" />),
};
const Spark = () => <svg className="spark" viewBox="0 0 60 60"><path d="M8 30h14M14 14l10 10M46 8 38 22M52 36H38" /></svg>;
const CupArt = () => <svg viewBox="0 0 200 150" className="art">
  <circle cx="100" cy="82" r="56" fill="#FCE6A8" />
  <path d="M62 66h76l-9 62a8 8 0 0 1-8 7H79a8 8 0 0 1-8-7z" fill="#FFF7DE" stroke="#3A2414" strokeWidth="3.500" strokeLinejoin="round" />
  <g fill="#F7CC3E" stroke="#3A2414" strokeWidth="2"><circle cx="82" cy="92" r="6" /><circle cx="100" cy="100" r="6" /><circle cx="118" cy="90" r="6" /><circle cx="90" cy="112" r="6" /><circle cx="110" cy="118" r="6" /></g>
  <g fill="#FFFDF5" stroke="#3A2414" strokeWidth="3"><circle cx="78" cy="62" r="11" /><circle cx="98" cy="54" r="12" /><circle cx="119" cy="60" r="11" /><circle cx="88" cy="72" r="9" /><circle cx="109" cy="73" r="9" /></g>
  <path d="M112 8 94 56" stroke="#3A2414" strokeWidth="9" strokeLinecap="round" /><path d="M112 8 94 56" stroke="#E7D3A6" strokeWidth="4" strokeLinecap="round" />
  <path d="M36 70l-14-6M32 86l-16 2M160 56l14-10M168 74l16 2M150 28l8-12" stroke="#F7B731" strokeWidth="4.500" strokeLinecap="round" />
</svg>;
const DocArt = () => <svg viewBox="0 0 160 110" className="art sm">
  <path d="M58 14h34l20 20v62a6 6 0 0 1-6 6H58a6 6 0 0 1-6-6V20a6 6 0 0 1 6-6z" fill="#E4E0D6" stroke="#9A958A" strokeWidth="4" strokeLinejoin="round" />
  <path d="M92 14v20h20" fill="none" stroke="#9A958A" strokeWidth="4" strokeLinejoin="round" />
  <path d="M66 52h34M66 66h34M66 80h20" stroke="#9A958A" strokeWidth="5" strokeLinecap="round" />
  <path d="M118 22l12-8M122 38l16-2M120 54l10 6" stroke="#9A958A" strokeWidth="4" strokeLinecap="round" />
</svg>;

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
  const Sec = ({ ic, title, right, children }: { ic: React.ReactNode; title: string; right?: React.ReactNode; children: React.ReactNode }) =>
    <section className="sec"><div className="sec-h"><span className="sec-ic">{ic}</span><h3>{title}</h3>{right}</div>{children}</section>;
  return <div className="rep">
    <header className="hdr rep-hdr">
      <button className="back" onClick={onClose} aria-label="Volver">{R.back}</button>
      <img className="logo" src="/logo.png" alt="Pancho Esquites" />
      <div className="tag">Esquites,<br />Elotes<br /><em>y más…</em></div>
    </header>
    <main className="sheetbody rep-body">
      <h1 className="rep-title">Ventas</h1>
      <div className="rep-tabs">
        {PERIODS.map(([k, l]) => <button key={k} className={k === period ? 'on' : ''} onClick={() => setPeriod(k)}>{l}</button>)}
      </div>
      {err && <p className="err">{err}</p>}
      {!data && !err && <p className="center">Cargando…</p>}
      {data && t && view && <>
        <div className="kbig">
          <span className="k-ic">{R.bars}</span>
          <div className="k-t"><small>Ventas</small><b>{mx(t.cents)}</b><Delta short now={t.cents} before={data.prev.cents} /></div>
          <img className="k-ph" src="/fotos/mediano.jpg" alt="" /><Spark />
        </div>
        <div className="kpis">
          <div className="kpi"><span className="kp-ic">{R.doc}</span><small>Tickets</small><b>{t.tickets}</b><Delta short now={t.tickets} before={data.prev.tickets} /></div>
          <div className="kpi"><span className="kp-ic">{R.coins}</span><small>Promedio</small><b>{mx(view.avg)}</b><small className="dl">—</small></div>
          <div className="kpi"><span className="kp-ic">{R.box}</span><small>Artículos</small><b>{t.items}</b><small className="dl">—</small></div>
        </div>
        {t.tickets === 0 && <section className="sec empty"><CupArt /><h3>Todavía no hay ventas<br />en este periodo.</h3></section>}

        {data.top.length > 0 && <Sec ic={R.trophy} title="Más vendidos" right={
          <div className="seg"><button className={!byMoney ? 'on' : ''} onClick={() => setByMoney(false)}>Piezas</button>
            <button className={byMoney ? 'on' : ''} onClick={() => setByMoney(true)}>Dinero</button></div>}>
          <Bars rows={view.top.map((r, i) => ({ label: `${i + 1}. ${r.name}`, value: byMoney ? r.cents : r.qty, sub: byMoney ? `${r.qty} pzas` : mx(r.cents) }))}
            fmt={n => byMoney ? mx(n) : `${n} pzas`} />
        </Sec>}

        {view.peak && <Sec ic={R.clock} title="Ventas por hora">
          <p className="muted">Hora pico: <b>{view.peak.hour % 12 || 12}{view.peak.hour < 12 ? ' am' : ' pm'}</b> · {mx(view.peak.cents)}</p>
          <div className="vbars">{view.full.map(h => <div key={h.hour} className="vb" title={`${mx(h.cents)} · ${h.tickets} tickets`}>
            <div className={'vb-fill' + (h.hour === view.peak!.hour ? ' pk' : '')} style={{ height: `${(h.cents / view.maxH) * 100}%` }} />
            <span>{hr(h.hour)}</span></div>)}</div>
        </Sec>}

        {data.by_day.length > 1 && <Sec ic={R.cal} title="Por día">
          {view.best && <p className="muted">Mejor día: <b>{new Date(view.best.day + 'T12:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' })}</b> · {mx(view.best.cents)}</p>}
          <Bars rows={data.by_day.map(d => ({ label: new Date(d.day + 'T12:00').toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric' }), value: d.cents, sub: `${d.tickets} tickets` }))} fmt={mx} />
        </Sec>}

        {data.by_cat.length > 0 && <Sec ic={R.grid} title="Por categoría">
          <Bars rows={data.by_cat.map(c => ({ label: c.name, value: c.cents, sub: `${c.qty} pzas` }))} fmt={mx} /></Sec>}

        {data.by_pay.length > 0 && <Sec ic={R.card} title="Forma de pago">
          <Bars rows={data.by_pay.map(p => ({ label: PAY[p.method] ?? p.method, value: p.cents, sub: `${p.tickets} tickets · ${Math.round((p.cents / Math.max(1, t.cents)) * 100)}%` }))} fmt={mx} /></Sec>}

        {data.by_emp.length > 1 && <Sec ic={R.user} title="Por empleado">
          <Bars rows={data.by_emp.map(p => ({ label: p.name, value: p.cents, sub: `${p.tickets} tickets` }))} fmt={mx} /></Sec>}

        {t.voided > 0 && <p className="muted center">Anuladas: {t.voided} ({mx(t.voided_cents)}), no incluidas arriba.</p>}

        <Sec ic={R.doc} title="Últimas ventas">
          {data.recent.length === 0 && <div className="empty-in"><DocArt /><p>Sin ventas.</p></div>}
          {data.recent.map(r => <div className={'row sale' + (r.voided ? ' void' : '')} key={r.id}>
            <span>#{r.id} · {new Date(r.at).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}<br />
              <small>{r.employee} · {PAY[r.pay_method] ?? r.pay_method}{r.voided ? ' · ANULADA' : ''}</small></span>
            <span><b>{mx(r.total_cents)}</b>{!r.voided && <><br /><button className="lnk" onClick={() => anular(r.id)}>Anular</button></>}</span>
          </div>)}
        </Sec>
      </>}
    </main>
  </div>;
}
