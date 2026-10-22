'use client';
import { useEffect, useState } from 'react';
import { supabase, mx } from '@/lib/supabase';

// El panel admin exige sesión de Supabase Auth de un usuario en la tabla `admins` (con 2FA activado).
// Las políticas RLS hacen que, aunque alguien abra esta página, sin ser admin no reciba datos.
export default function Admin() {
  const [ok, setOk] = useState<boolean | null>(null);
  const [tab, setTab] = useState<'corte' | 'inv' | 'emp'>('corte');
  useEffect(() => { supabase.rpc('is_admin').then(({ data }) => setOk(!!data)); }, []);
  if (ok === null) return null;
  if (!ok) return <AdminLogin />;
  return <div className="wrap">
    <div className="row" style={{ border: 'none' }}><b>Administración</b><a href="/">Caja</a></div>
    <div className="cats" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
      {([['corte', 'Corte'], ['inv', 'Inventario'], ['emp', 'Empleados']] as const).map(([k, l]) =>
        <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
    </div>
    {tab === 'corte' && <Corte />}{tab === 'inv' && <Inventario />}{tab === 'emp' && <Empleados />}
  </div>;
}

function Corte() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    supabase.from('sales').select('id,total_cents,pay_method,voided,created_at,employees(name)')
      .gte('created_at', from.toISOString()).order('created_at', { ascending: false })
      .then(({ data }) => setRows(data ?? []));
  }, []);
  const ok = rows.filter(r => !r.voided);
  const sum = (f: (r: any) => boolean) => ok.filter(f).reduce((s, r) => s + r.total_cents, 0);
  return <>
    <h2>Hoy · {mx(sum(() => true))} · {ok.length} ventas</h2>
    {[['cash', 'Efectivo'], ['card', 'Tarjeta'], ['spei', 'Transferencia']].map(([k, l]) =>
      <div className="row" key={k}><span>{l}</span><span>{mx(sum(r => r.pay_method === k))}</span></div>)}
    <h3>Últimas ventas</h3>
    {rows.slice(0, 20).map(r => <div className="row" key={r.id}>
      <span>#{r.id} · {new Date(r.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} · {r.employees?.name}{r.voided ? ' · ANULADA' : ''}</span>
      <span>{mx(r.total_cents)}</span></div>)}
  </>;
}

function Inventario() {
  const [items, setItems] = useState<any[]>([]); const [q, setQ] = useState<Record<string, string>>({});
  const load = () => supabase.from('inventory_items').select('*').order('name').then(({ data }) => setItems(data ?? []));
  useEffect(() => { load(); }, []);
  async function move(id: string, kind: 'entrada' | 'conteo') {
    const v = parseFloat(q[id]); if (isNaN(v) || v < 0) return;
    const { error } = await supabase.rpc('admin_inventory_move', { p_item: id, p_qty: v, p_kind: kind });
    if (!error) { setQ({ ...q, [id]: '' }); load(); }
  }
  return <>{items.map(i => <div key={i.id} style={{ padding: '8px 0', borderBottom: '1px dashed #EADBB4' }}>
    <div className="row" style={{ border: 'none' }}><b style={{ color: +i.stock <= +i.min_stock ? '#C8381F' : undefined }}>{i.name}</b>
      <span>{+i.stock} {i.unit} (mín. {+i.min_stock})</span></div>
    <input id={`inv-${i.id}`} inputMode="decimal" placeholder={`Cantidad (${i.unit})`} value={q[i.id] ?? ''} onChange={e => setQ({ ...q, [i.id]: e.target.value })} />
    <button onClick={() => move(i.id, 'entrada')}>+ Entrada</button> <button onClick={() => move(i.id, 'conteo')}>Conteo</button>
  </div>)}</>;
}

function Empleados() {
  const [list, setList] = useState<any[]>([]); const [name, setName] = useState(''); const [pin, setPin] = useState('');
  const [role, setRole] = useState<'cajero' | 'admin'>('cajero'); const [err, setErr] = useState('');
  const load = () => supabase.from('employees').select('id,name,role,active').order('name').then(({ data }) => setList(data ?? []));
  useEffect(() => { load(); }, []);
  async function save() {
    setErr('');
    const { error } = await supabase.rpc('admin_upsert_employee', { p_id: null, p_name: name, p_pin: pin, p_role: role, p_active: true });
    if (error) return setErr(error.message);
    setName(''); setPin(''); load();
  }
  async function toggle(e: any) {
    await supabase.rpc('admin_upsert_employee', { p_id: e.id, p_name: e.name, p_pin: null, p_role: e.role, p_active: !e.active }); load();
  }
  return <>
    {list.map(e => <div className="row" key={e.id}><span>{e.name} · {e.role}{e.active ? '' : ' (inactivo)'}</span>
      <button onClick={() => toggle(e)}>{e.active ? 'Desactivar' : 'Activar'}</button></div>)}
    <h3>Nuevo empleado</h3>
    <input id="e-name" placeholder="Nombre" value={name} onChange={e => setName(e.target.value)} />
    <input id="e-pin" inputMode="numeric" maxLength={6} placeholder="PIN (4 a 6 números)" value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} />
    <div className="cats" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <button className={role === 'cajero' ? 'on' : ''} onClick={() => setRole('cajero')}>Cajero</button>
      <button className={role === 'admin' ? 'on' : ''} onClick={() => setRole('admin')}>Admin</button></div>
    <p className="err">{err}</p><button className="primary" onClick={save}>Agregar</button>
  </>;
}

function AdminLogin() {
  const [email, setEmail] = useState(''); const [pass, setPass] = useState(''); const [code, setCode] = useState('');
  const [step, setStep] = useState<'pass' | 'mfa' | 'enroll'>('pass'); const [err, setErr] = useState('');
  const [qr, setQr] = useState(''); const [fid, setFid] = useState('');
  async function login() {
    setErr('');
    const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
    if (error) return setErr('Correo o contraseña incorrectos');
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data?.currentLevel === 'aal2') return location.reload();
    if (data?.nextLevel === 'aal2') return setStep('mfa');
    // Primer inicio: dar de alta la app autenticadora
    const { data: en, error: e2 } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
    if (e2 || !en || en.type !== 'totp') return setErr('No se pudo activar 2FA');
    setQr(en.totp.qr_code); setFid(en.id); setStep('enroll');
  }
  async function verify() {
    let id = fid;
    if (!id) { const { data: f } = await supabase.auth.mfa.listFactors(); id = f?.totp?.[0]?.id ?? ''; }
    if (!id) return setErr('Sin 2FA configurado');
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: id, code });
    if (error) return setErr('Código incorrecto'); location.reload();
  }
  return <div className="wrap center"><h2>Administración</h2>
    {step === 'pass' ? <>
      <input id="a-email" type="email" placeholder="Correo" value={email} onChange={e => setEmail(e.target.value)} />
      <input id="a-pass" type="password" placeholder="Contraseña" value={pass} onChange={e => setPass(e.target.value)} />
      <p className="err">{err}</p><button className="primary" onClick={login}>Entrar</button>
    </> : <>
      {step === 'enroll' && <><p>Escanea con Google Authenticator o 1Password</p><img src={qr} alt="Código QR de 2FA" width={200} height={200} /></>}
      <p>Código de tu app autenticadora</p>
      <input id="a-code" inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value)} />
      <p className="err">{err}</p><button className="primary" onClick={verify}>Verificar</button>
    </>}
    <p><a href="/">Volver a la caja</a></p></div>;
}
