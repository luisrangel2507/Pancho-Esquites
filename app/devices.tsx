'use client';
import { useEffect, useState } from 'react';
import { supabase, rpc } from '@/lib/supabase';
import { dayTime } from './cash';

// Formato del código: XXXX-XXXX, sin letras confusas
const fmt = (v: string) => {
  const c = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c;
};

// Pantalla de un teléfono nuevo: se activa una sola vez con el código que genera el dueño
export function ActivateDevice({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function go() {
    setErr(''); setBusy(true);
    const { data, error } = await supabase.rpc('device_activate', { p_code: code });
    setBusy(false);
    if (error) return setErr(error.message);
    if (!data) return setErr('Código incorrecto o vencido. Pide uno nuevo.');
    onDone();
  }
  return <div className="pin">
    <div className="hero"><img src="/logo.webp" alt="Pancho Esquites" /></div>
    <h1 className="ptitle">Activar <span>teléfono</span></h1>
    <p className="psub act-sub">Se hace una sola vez. Pide el código al dueño:<br />Menú → Teléfonos → Activar otro teléfono.</p>
    <input className="code-in" value={code} placeholder="XXXX-XXXX" autoCapitalize="characters" autoCorrect="off" autoComplete="off"
      inputMode="text" onChange={e => setCode(fmt(e.target.value))} onKeyDown={e => e.key === 'Enter' && code.length === 9 && go()} />
    <p className="err">{err}</p>
    <button className="regv act" disabled={busy || code.length !== 9} onClick={go}>{busy ? 'Activando…' : 'Activar'}</button>
  </div>;
}

export function Connecting({ err, onRetry }: { err: string; onRetry?: () => void }) {
  return <div className="pin">
    <div className="hero"><img src="/logo.webp" alt="Pancho Esquites" /></div>
    <h1 className="ptitle">Conectando <span>caja</span>…</h1>
    <p className="psub act-sub">{err || 'Un momento'}</p>
    {onRetry ? <button className="regv act" onClick={onRetry}>Reintentar</button> : <div className="spin" />}
    {onRetry && <p className="psub">Se reintenta solo cada 10 segundos.</p>}
  </div>;
}

type Dev = { user_id: string; label: string; created_at: string; this_one: boolean };

// Para el dueño: ver teléfonos activados, quitarlos y generar códigos para activar otros
export function DevicesSheet({ pin, onClose }: { pin: string; onClose: () => void }) {
  const [list, setList] = useState<Dev[]>([]); const [err, setErr] = useState('');
  const [label, setLabel] = useState(''); const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const load = async () => {
    const { data, error } = await rpc('device_list', { p_admin_pin: pin });
    if (error) setErr(error.message); else setList(data ?? []);
  };
  useEffect(() => { load(); }, []);
  async function create() {
    setErr('');
    const { data, error } = await rpc('device_code_create', { p_admin_pin: pin, p_label: label || `Caja ${list.length + 1}` });
    if (error) return setErr(error.message);
    setCode(data); setLabel('');
  }
  async function remove(d: Dev) {
    if (!confirm(`¿Quitar "${d.label}"? Ese teléfono dejará de poder usar la caja hasta activarlo otra vez.`)) return;
    setErr('');
    const { error } = await rpc('device_remove', { p_admin_pin: pin, p_user: d.user_id });
    if (error) setErr(error.message); else load();
  }
  return <div className="sheet cobro staff" onClick={e => e.target === e.currentTarget && onClose()}><div className="panel">
    <div className="grab" />
    <div className="st-h">
      <span className="st-ic dev-ic">📱</span>
      <div className="st-t"><h2>Teléfonos</h2><small>Teléfonos que pueden usar la caja. Quita los que ya no uses.</small></div>
      <button className="st-x" aria-label="Cerrar" onClick={onClose}>×</button>
    </div>
    <div className="st-list">
      {list.map(d => <div className="st-row" key={d.user_id}>
        <span className="av green">📱</span>
        <div className="st-n"><div className="st-nm"><b>{d.label}</b>{d.this_one && <em className="bd-a">Este</em>}</div>
          <small>Activado {dayTime(d.created_at)}</small></div>
        {!d.this_one && <div className="st-b"><button className="b-off" onClick={() => remove(d)}>Quitar</button></div>}
      </div>)}
    </div>
    <div className="sup">
      <div className="sup-h"><span className="sup-ic">＋</span>
        <div><h3>Activar otro teléfono</h3><small>Genera un código, ábrelo en el teléfono nuevo y escríbelo. Sirve una vez y dura 30 minutos.</small></div></div>
      {code && <div className="sup-new"><small>Código de activación</small><b className="dev-code">{code.code}</b>
        <small>Vence {dayTime(code.expires_at)}</small></div>}
      <input placeholder={`Nombre del teléfono (ej. Caja ${list.length + 1})`} value={label} maxLength={30} onChange={e => setLabel(e.target.value)} />
      <button className="regv sm" onClick={create}>{code ? 'Generar otro código' : 'Generar código'}</button>
    </div>
    <p className="err">{err}</p>
    <button className="st-close" onClick={onClose}>Cerrar</button>
  </div></div>;
}
