'use client';
import { useEffect, useState } from 'react';
import { rpc, mx } from '@/lib/supabase';

export type CashOpen = {
  id: number; open: true; opened_at: string; opened_by: string; opening_cents: number;
  tickets: number; total_cents: number; cash_cents: number; card_cents: number; spei_cents: number;
  voided: number; voided_cents: number; expected_cents: number; counted_cents: number | null;
  closed_at: string | null; closed_by: string | null;
};
export type CashClosed = Omit<CashOpen, 'open'> & { open: false };
export type Cash = { open: false; id?: undefined } | CashOpen;

const toCents = (v: string) => Math.round(parseFloat(v || '0') * 100);
const clock = (iso: string) => new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
export const dayTime = (iso: string) => new Date(iso).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Diff({ cents }: { cents: number }) {
  if (cents === 0) return <b className="df ok">Cuadra ✓</b>;
  return <b className={'df ' + (cents > 0 ? 'up' : 'down')}>{cents > 0 ? 'Sobra ' : 'Falta '}{mx(Math.abs(cents))}</b>;
}

export function OpenCash({ pin, name, onOpened, onLogout }: { pin: string; name: string; onOpened: (c: CashOpen) => void; onLogout: () => void }) {
  const [amt, setAmt] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function open() {
    setErr(''); setBusy(true);
    const { data, error } = await rpc('cash_open', { p_pin: pin, p_opening_cents: toCents(amt) });
    setBusy(false);
    if (error) return setErr(error.message);
    onOpened(data as CashOpen);
  }
  return <div className="sheet cobro cashs"><div className="panel">
    <div className="grab" />
    <div className="ch">
      <span className="ch-ic">{'🔓'}</span>
      <div className="ch-t"><h2>Abrir caja</h2><small>Hola, {name}. Cuenta el efectivo con el que empiezas.</small></div>
    </div>
    <div className="recv"><label htmlFor="open-amt">Efectivo inicial (fondo) $</label>
      <div className="recv-in"><input id="open-amt" inputMode="decimal" autoFocus value={amt} onChange={e => setAmt(e.target.value.replace(/[^\d.]/g, ''))} />
        {amt && <button aria-label="Borrar" onClick={() => setAmt('')}>×</button>}</div></div>
    <div className="quick">{[0, 200, 500, 1000].map(v => <button key={v} onClick={() => setAmt(String(v))}>{mx(v * 100)}</button>)}</div>
    <p className="err">{err}</p>
    <button className="regv" disabled={busy || amt === ''} onClick={open}>Abrir caja</button>
    <button className="st-close" onClick={onLogout}>Salir</button>
  </div></div>;
}

function Row({ l, v, bold }: { l: string; v: React.ReactNode; bold?: boolean }) {
  return <div className={'cs-row' + (bold ? ' bold' : '')}><span>{l}</span><span>{v}</span></div>;
}

export function CloseCash({ pin, onClose, onDone }: { pin: string; onClose: () => void; onDone: () => void }) {
  const [s, setS] = useState<CashOpen | null>(null);
  const [counted, setCounted] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<(Omit<CashOpen, 'open'> & { open: boolean }) | null>(null);
  useEffect(() => {
    rpc('cash_status', { p_pin: pin }).then(({ data, error }) => {
      if (error) setErr(error.message); else if (data?.open) setS(data as CashOpen); else onDone();
    });
  }, []);
  async function close() {
    if (!confirm('¿Cerrar la caja? Ya no podrás cobrar hasta abrir otra.')) return;
    setErr(''); setBusy(true);
    const { data, error } = await rpc('cash_close', { p_pin: pin, p_counted_cents: toCents(counted) });
    setBusy(false);
    if (error) return setErr(error.message);
    setRes(data);
  }
  const diff = s && counted !== '' ? toCents(counted) - s.expected_cents : null;

  if (res) return <div className="sheet cobro cashs" ><div className="panel center">
    <div className="grab" />
    <h2 className="cs-t">Caja cerrada</h2>
    <p className="muted">{res.opened_by} abrió a las {clock(res.opened_at)} · cerró {res.closed_at ? clock(res.closed_at) : ''}</p>
    <div className="cs-box">
      <Row l="Efectivo esperado" v={mx(res.expected_cents)} />
      <Row l="Efectivo contado" v={mx(res.counted_cents ?? 0)} />
      <Row bold l="Diferencia" v={<Diff cents={(res.counted_cents ?? 0) - res.expected_cents} />} />
    </div>
    <p className="muted">Total vendido {mx(res.total_cents)} · {res.tickets} tickets</p>
    <button className="regv" onClick={onDone}>Listo</button>
  </div></div>;

  return <div className="sheet cobro cashs" onClick={e => e.target === e.currentTarget && onClose()}><div className="panel">
    <div className="grab" />
    <div className="ch">
      <span className="ch-ic">{'🔒'}</span>
      <div className="ch-t"><h2>Cerrar caja</h2><small>{s ? `Abierta ${dayTime(s.opened_at)} por ${s.opened_by}` : 'Cargando…'}</small></div>
      <button className="st-x" aria-label="Cerrar" onClick={onClose}>×</button>
    </div>
    {s && <>
      <div className="cs-box">
        <Row l="Fondo inicial" v={mx(s.opening_cents)} />
        <Row l="+ Ventas en efectivo" v={mx(s.cash_cents)} />
        <Row bold l="Efectivo esperado" v={mx(s.expected_cents)} />
      </div>
      <div className="cs-box soft">
        <Row l="Tarjeta" v={mx(s.card_cents)} />
        <Row l="Transferencia" v={mx(s.spei_cents)} />
        <Row bold l={`Total vendido · ${s.tickets} tickets`} v={mx(s.total_cents)} />
        {s.voided > 0 && <Row l={`Anuladas (${s.voided})`} v={mx(s.voided_cents)} />}
      </div>
      <div className="recv"><label htmlFor="cnt">Efectivo contado en caja $</label>
        <div className="recv-in"><input id="cnt" inputMode="decimal" value={counted} onChange={e => setCounted(e.target.value.replace(/[^\d.]/g, ''))} />
          {counted && <button aria-label="Borrar" onClick={() => setCounted('')}>×</button>}</div></div>
      <div className={'chg' + (diff !== null && diff !== 0 ? (diff > 0 ? ' up' : ' low') : '')}>
        <b>Diferencia</b>{diff === null ? <strong>—</strong> : <strong><Diff cents={diff} /></strong>}
      </div>
    </>}
    <p className="err">{err}</p>
    <button className="regv" disabled={busy || !s || counted === ''} onClick={close}>Cerrar caja</button>
  </div></div>;
}

export function CashHistory({ pin }: { pin: string }) {
  const [rows, setRows] = useState<(Omit<CashOpen, 'open'> & { open: boolean })[] | null>(null);
  useEffect(() => {
    rpc('cash_history', { p_admin_pin: pin, p_limit: 15 }).then(({ data, error }) => setRows(error ? [] : data ?? []));
  }, []);
  if (!rows || rows.length === 0) return null;
  return <>{rows.map(r => <div className="cs-hist" key={r.id}>
    <div className="cs-row bold"><span>Caja #{r.id} · {dayTime(r.opened_at)}</span><span>{mx(r.total_cents)}</span></div>
    <small>Abrió {r.opened_by}{r.closed_by ? ` · cerró ${r.closed_by}` : ' · abierta'} · {r.tickets} tickets</small>
    {r.counted_cents !== null && <div className="cs-row"><span>Esperado {mx(r.expected_cents)} · contado {mx(r.counted_cents)}</span>
      <Diff cents={r.counted_cents - r.expected_cents} /></div>}
  </div>)}</>;
}
