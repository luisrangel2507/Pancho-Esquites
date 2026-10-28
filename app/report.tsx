'use client';
import { useEffect, useState } from 'react';
import { rpc } from '@/lib/supabase';

// El dueño elige hasta 3 correos; cada cierre de caja les manda el reporte del día
export function ReportSheet({ pin, onClose }: { pin: string; onClose: () => void }) {
  const [emails, setEmails] = useState(['', '', '']);
  const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    rpc('report_settings_get', { p_admin_pin: pin }).then(({ data, error }) => {
      if (error) setErr(error.message);
      else setEmails([0, 1, 2].map(i => (data ?? [])[i] ?? ''));
    });
  }, []);
  async function save() {
    setErr(''); setMsg(''); setBusy(true);
    const { data, error } = await rpc('report_settings_set', {
      p_admin_pin: pin, p_emails: emails.filter(e => e.trim()),
      p_fn_url: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/aviso-cierre`,
    });
    setBusy(false);
    if (error) return setErr(error.message);
    setEmails([0, 1, 2].map(i => (data ?? [])[i] ?? ''));
    setMsg((data ?? []).length ? 'Guardado. Llegará un correo cada vez que se cierre la caja.' : 'Guardado sin correos: no se mandarán reportes.');
  }
  async function test() {
    setErr(''); setMsg(''); setBusy(true);
    const { error } = await rpc('report_send_test', { p_admin_pin: pin });
    setBusy(false);
    if (error) setErr(error.message); else setMsg('Enviado. Revisa tu correo en un minuto (también la carpeta de spam).');
  }
  return <div className="sheet cobro staff" onClick={e => e.target === e.currentTarget && onClose()}><div className="panel">
    <div className="grab" />
    <div className="st-h">
      <span className="st-ic dev-ic">✉️</span>
      <div className="st-t"><h2>Reporte por correo</h2><small>Cada vez que se cierra la caja llega el resumen del día: total, cierre, formas de pago y lo más vendido.</small></div>
      <button className="st-x" aria-label="Cerrar" onClick={onClose}>×</button>
    </div>
    {emails.map((v, i) => <div key={i}>
      <label className="st-l" htmlFor={`rep-${i}`}>Correo {i + 1}{i ? ' (opcional)' : ''}</label>
      <div className="st-f"><input id={`rep-${i}`} type="email" inputMode="email" autoCapitalize="none" placeholder="nombre@correo.com"
        value={v} onChange={e => setEmails(es => es.map((x, j) => j === i ? e.target.value : x))} /></div>
    </div>)}
    <p className="err">{err}</p>
    {msg && <p className="ok-msg">{msg}</p>}
    <button className="regv" disabled={busy} onClick={save}>Guardar</button>
    <button className="st-close" disabled={busy} onClick={test}>Enviar reporte de prueba</button>
  </div></div>;
}
