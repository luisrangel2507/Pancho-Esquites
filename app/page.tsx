'use client';
import { useEffect, useMemo, useState } from 'react';
import { supabase, mx, Product, Category, Employee } from '@/lib/supabase';
import Reports from './reports';

// Supabase exige un correo: al usuario "caja1" se le agrega este dominio interno
const USER_DOMAIN = 'esquites.com';
const AUTO_USER = process.env.NEXT_PUBLIC_CAJA_USER;
const AUTO_PASS = process.env.NEXT_PUBLIC_CAJA_PASS;
const toEmail = (u: string) => u.includes('@') ? u.trim() : `${u.trim().toLowerCase()}@${USER_DOMAIN}`;
const PIN_LEN = 6; // el PIN es de exactamente 6 dígitos y se verifica una sola vez, al completarlo
const IDLE_MS = 30 * 60 * 1000; // cierra el turno tras 30 min sin uso

type Cart = Record<number, { qty: number; note: string }>;

export default function Caja() {
  const [session, setSession] = useState<boolean | null>(null);
  const [emp, setEmp] = useState<Employee | null>(null);
  const [pin, setPin] = useState(''); // se guarda solo en memoria mientras dura el turno
  const [cats, setCats] = useState<Category[]>([]);
  const [prods, setProds] = useState<Product[]>([]);
  const [cur, setCur] = useState<number | null>(null);
  const [cart, setCart] = useState<Cart>({});
  const [checkout, setCheckout] = useState(false);
  const [pay, setPay] = useState<'cash' | 'card' | 'spei'>('cash');
  const [cash, setCash] = useState('');
  const [msg, setMsg] = useState('');
  const [menu, setMenu] = useState(false);
  const [staff, setStaff] = useState(false);
  const [reports, setReports] = useState(false);
  const [ticket, setTicket] = useState<{ id: number; total: number } | null>(null);

  // Con NEXT_PUBLIC_CAJA_USER/PASS definidas la caja se activa sola y solo se pide el PIN
  useEffect(() => {
    let alive = true;
    const auto = async () => {
      if (!AUTO_USER || !AUTO_PASS) return false;
      const { error } = await supabase.auth.signInWithPassword({ email: toEmail(AUTO_USER), password: AUTO_PASS });
      return !error;
    };
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!alive) return;
      setSession(data.session ? true : await auto());
    })();
    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, s) => {
      if (s) setSession(true); else setSession(await auto());
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!emp) return;
    let t: ReturnType<typeof setTimeout>;
    const out = () => { setEmp(null); setPin(''); setCart({}); setCheckout(false); setTicket(null); };
    const reset = () => { clearTimeout(t); t = setTimeout(out, IDLE_MS); };
    const evs = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;
    evs.forEach(e => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => { clearTimeout(t); evs.forEach(e => window.removeEventListener(e, reset)); };
  }, [emp]);

  useEffect(() => {
    if (!emp) return;
    (async () => {
      const [c, p] = await Promise.all([
        supabase.from('categories').select('id,name').order('sort'),
        supabase.from('products').select('*').eq('active', true).order('sort'),
      ]);
      setCats(c.data ?? []); setProds(p.data ?? []);
      setCur(c.data?.[0]?.id ?? null);
    })();
  }, [emp]);

  const total = useMemo(() => Object.entries(cart).reduce((s, [id, v]) =>
    s + (prods.find(p => p.id === +id)?.price_cents ?? 0) * v.qty, 0), [cart, prods]);
  const count = Object.values(cart).reduce((s, v) => s + v.qty, 0);

  if (session === null) return null;
  if (!session) return <DeviceLogin />;

  if (!emp) return <PinScreen onOk={(e, p) => { setEmp(e); setPin(p); }} />;

  const add = (id: number, d: number) => setCart(c => {
    const q = (c[id]?.qty ?? 0) + d; const n = { ...c };
    if (q <= 0) delete n[id]; else n[id] = { qty: q, note: c[id]?.note ?? '' };
    return n;
  });

  async function cobrar() {
    setMsg('');
    const items = Object.entries(cart).map(([id, v]) => ({ product_id: +id, qty: v.qty, note: v.note }));
    const cashCents = pay === 'cash' ? Math.round(parseFloat(cash || '0') * 100) : null;
    const { data, error } = await supabase.rpc('register_sale', { p_pin: pin, p_items: items, p_pay: pay, p_cash_cents: cashCents });
    if (error) return setMsg(error.message);
    setTicket({ id: data[0].sale_id, total: data[0].total_cents });
    setCart({}); setCash(''); setCheckout(false);
  }

  const cashCents = Math.round(parseFloat(cash || '0') * 100);
  const photoOf = (p: Product): string | null => {
    if (p.photo_path) return supabase.storage.from('products').getPublicUrl(p.photo_path).data.publicUrl;
    const f = cats.find(c => c.id === p.category_id)?.name === 'Esquites' ? FOTOS[p.short_name ?? p.name] : undefined;
    return f ? `/fotos/${f}.jpg` : null;
  };

  return (
    <div className="app">
      <header className="hdr">
        <button className="burger" aria-label="Menú" onClick={() => setMenu(m => !m)}>
          <svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
        <img className="logo" src="/logo.png" alt="Pancho Esquites" />
        <div className="tag">Esquites,<br />Elotes<br /><em>y más…</em></div>
        {emp.role === 'admin'
          ? <button className="pill" onClick={() => setMenu(m => !m)}>{USER_SVG}Admin ⌄</button>
          : <span className="pill">{USER_SVG}{emp.name}</span>}
        {menu && <div className="menu-bg" onClick={() => setMenu(false)} />}
        {menu && <div className="menu">
          <button onClick={() => { setEmp(null); setPin(''); setCart({}); setMenu(false); }}>Cerrar turno ({emp.name})</button>
          {emp.role === 'admin' && <button onClick={() => { setReports(true); setMenu(false); }}>Ventas e informes</button>}
          {emp.role === 'admin' && <button onClick={() => { setStaff(true); setMenu(false); }}>Empleados</button>}
          {emp.role === 'admin' && <a href="/admin">Administración</a>}
          <button className="mx" onClick={() => setMenu(false)}>Cerrar menú</button>
        </div>}
      </header>
      <main className="sheetbody">
        <div className="chips">
          {cats.map(c => {
            const n = prods.filter(p => p.category_id === c.id).reduce((a, p) => a + (cart[p.id]?.qty ?? 0), 0);
            return <button key={c.id} className={'chip' + (c.id === cur ? ' on' : '')} onClick={() => setCur(c.id)}>
              <i>{icon(c.name)}</i>{c.name}{n > 0 && <span className="n">{n}</span>}
            </button>;
          })}
        </div>
        <div className="grid3">
          {prods.filter(p => p.category_id === cur).map(p => {
            const cat = cats.find(c => c.id === p.category_id)?.name ?? '';
            const nm = p.short_name ?? p.name;
            const local = cat === 'Esquites' ? FOTOS[nm] : undefined;
            return <div key={p.id} role="button" className={'card' + (cart[p.id] ? ' sel' : '')} onClick={() => add(p.id, 1)}>
              <div className="ph">
                {p.photo_path
                  ? <img src={supabase.storage.from('products').getPublicUrl(p.photo_path).data.publicUrl} alt="" />
                  : local ? <img src={`/fotos/${local}.jpg`} alt="" /> : icon(cat)}
              </div>
              <div className="info">
                <div><b>{nm}</b>{cat === 'Esquites' && DESC[nm] && <small>{DESC[nm]}</small>}</div>
                <div className="prow"><span className="price">{mx(p.price_cents)}</span><span className="plus">+</span></div>
              </div>
              {cart[p.id] && <>
                <span className="cnt">{cart[p.id].qty}</span>
                <button className="minus" aria-label="Quitar uno" onClick={e => { e.stopPropagation(); add(p.id, -1); }}>−</button>
              </>}
            </div>;
          })}
        </div>
      </main>
      <div className="pay" role="button" aria-disabled={!count} onClick={() => count && setCheckout(true)}>
        <span className="cartic">
          <svg viewBox="0 0 24 24"><path d="M3 4h2l2.4 10.2a1 1 0 0 0 1 .8h8.8a1 1 0 0 0 1-.8L20 8H6.2" /><circle cx="9" cy="19" r="1.3" /><circle cx="17" cy="19" r="1.3" /></svg>
        </span>
        <span className="bd">{count}</span>
        <span className="sep" />
        <span className="ptxt">{count ? <>Cobrar · {count} artículo{count > 1 ? 's' : ''}<small>Revisa tu pedido</small></> : 'Agrega productos para cobrar'}</span>
        {count
          ? <span className="tot">{mx(total)}<svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6" /></svg></span>
          : <span className="go">›</span>}
      </div>

      {reports && <Reports pin={pin} onClose={() => setReports(false)} />}
      {staff && <Staff pin={pin} onClose={() => setStaff(false)} onPassed={() => { setStaff(false); setEmp(null); setPin(''); setCart({}); }} />}

      {checkout && <div className="sheet cobro" onClick={e => e.target === e.currentTarget && setCheckout(false)}><div className="panel">
        <div className="grab" />
        <div className="ch">
          <span className="ch-ic">{I.cart}</span>
          <div className="ch-t"><h2>Cobrar <em>{mx(total)}</em></h2><small>{count} artículo{count === 1 ? '' : 's'} en el carrito</small></div>
          <button className="vaciar" onClick={() => { setCart({}); setCheckout(false); }}>{I.trash}Vaciar</button>
        </div>
        {Object.entries(cart).map(([id, v]) => {
          const p = prods.find(x => x.id === +id)!;
          const img = photoOf(p);
          return <div className="li" key={id}>
            <div className="li-ph">{img ? <img src={img} alt="" /> : icon(cats.find(c => c.id === p.category_id)?.name ?? '')}</div>
            <div className="li-m"><b>{p.name}</b><span className="price">{mx(p.price_cents)}</span></div>
            <div className="li-r">
              <div className="step"><button className="mn" aria-label="Quitar uno" onClick={() => add(p.id, -1)}>−</button><span>{v.qty}</span><button className="pl" aria-label="Agregar uno" onClick={() => add(p.id, 1)}>+</button></div>
              <strong>{mx(p.price_cents * v.qty)}</strong>
            </div>
          </div>;
        })}
        <div className="payseg">
          {([['cash', 'Efectivo', I.bill], ['card', 'Tarjeta', I.card], ['spei', 'Transferencia', I.qr]] as const).map(([k, l, ic]) =>
            <button key={k} className={pay === k ? 'on' : ''} onClick={() => setPay(k)}>{ic}{l}</button>)}
        </div>
        {pay === 'cash' && <>
          <div className="recv"><label htmlFor="cash">Recibido $</label>
            <div className="recv-in"><input id="cash" inputMode="decimal" value={cash} onChange={e => setCash(e.target.value.replace(/[^\d.]/g, ''))} />
              {cash && <button aria-label="Borrar" onClick={() => setCash('')}>×</button>}</div></div>
          <div className={'chg' + (cash && cashCents < total ? ' low' : '')}>{I.coins}<b>{cash && cashCents < total ? 'Falta' : 'Cambio'}</b>
            <strong>{cash ? mx(Math.abs(cashCents - total)) : '—'}</strong></div>
        </>}
        <p className="err">{msg}</p>
        <button className="regv" onClick={cobrar}>{I.printer}Registrar venta</button>
      </div></div>}

      {ticket && <div className="sheet" onClick={() => setTicket(null)}><div className="panel center">
        <p>Venta registrada</p><h1>#{ticket.id}</h1><h2>{mx(ticket.total)}</h2>
        <button className="primary" onClick={() => setTicket(null)}>Nueva venta</button>
      </div></div>}
    </div>
  );
}

const ICONS: Record<string, string> = { Esquites: '🥣', Elotes: '🌽', Gorditas: '🫓', Antojitos: '🌮', Panqué: '🍰', Salsa: '🌶️', Bebidas: '🥤' };
const icon = (name: string) => ICONS[name] ?? '🍽️';
const sv = (d: React.ReactNode) => <svg viewBox="0 0 24 24" className="ico">{d}</svg>;
const I = {
  cart: sv(<><path d="M3 4h2l2.4 10.2a1 1 0 0 0 1 .8h8.8a1 1 0 0 0 1-.8L20 8H6.2" /><circle cx="9" cy="19" r="1.3" /><circle cx="17" cy="19" r="1.3" /></>),
  trash: sv(<><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>),
  bill: sv(<><rect x="2.5" y="6" width="19" height="12" rx="2" /><circle cx="12" cy="12" r="2.6" /><path d="M6 9v.01M18 15v.01" /></>),
  card: sv(<><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M2.5 10h19M6 15h4" /></>),
  qr: sv(<><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><rect x="8" y="8" width="3" height="3" /><rect x="13" y="8" width="3" height="3" /><rect x="8" y="13" width="3" height="3" /><path d="M13 13h3v3" /></>),
  coins: sv(<><ellipse cx="9" cy="7" rx="6" ry="3" /><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.300 6-3V7M3 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3" /><path d="M15 10.500c3 0 6 1 6 2.500v5c0 1.500-2.500 2.500-5 2.500" /></>),
  printer: sv(<><path d="M7 9V3h10v6M7 17H4.500A1.500 1.500 0 0 1 3 15.500v-5A1.500 1.500 0 0 1 4.500 9h15a1.500 1.500 0 0 1 1.500 1.500v5a1.500 1.500 0 0 1-1.500 1.500H17" /><rect x="7" y="14" width="10" height="7" rx="1" /></>),
};
const USER_SVG = <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4.2" /><path d="M3.5 21a8.5 8.5 0 0 1 17 0z" /></svg>;
// Fotos y descripciones de respaldo mientras un producto no tiene foto en Supabase Storage
const FOTOS: Record<string, string> = { 'Chico': 'chico', 'Mediano': 'mediano', 'Grande': 'grande', 'Extragrande': 'extragrande', 'Rebanado por pieza': 'rebanado', 'Combinado mediano': 'combinado-mediano', 'Combinado grande': 'combinado-grande', 'Asado grande': 'asado-grande', 'Vaso extra': 'vaso-extra' };
const DESC: Record<string, string> = { 'Chico': 'Clásico y delicioso', 'Mediano': 'El favorito de todos', 'Grande': 'Más sabor, más antojo', 'Extragrande': 'Para los que sí comen', 'Rebanado por pieza': 'Elote en rebanadas', 'Combinado mediano': 'Esquite + Elote', 'Combinado grande': 'Doble antojo', 'Asado grande': 'Al carbón, más sabor', 'Vaso extra': 'Perfecto para compartir' };

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="auth">
    <img className="art-top" src="/auth-top.jpg" alt="Pancho Esquites" />
    <div className="body">{children}</div>
    <img className="art-bot" src="/auth-bottom.jpg" alt="" />
  </div>;
}

const UserIcon = () => <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
const Lock = () => <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;

function DeviceLogin() {
  const [user, setUser] = useState(''); const [pass, setPass] = useState(''); const [err, setErr] = useState('');
  async function go() {
    const { error } = await supabase.auth.signInWithPassword({ email: toEmail(user), password: pass });
    if (error) setErr('Usuario o contraseña incorrectos');
  }
  return <Shell>
    <h2>Activar caja</h2><p>Solo se hace una vez por dispositivo.<br />Lo hace el dueño.</p>
    <div className="field"><UserIcon /><input id="user" type="text" placeholder="Usuario" autoCapitalize="none" autoCorrect="off" autoComplete="username" value={user} onChange={e => setUser(e.target.value)} /></div>
    <div className="field"><Lock /><input id="pass" type="password" placeholder="Contraseña" value={pass} onChange={e => setPass(e.target.value)}
      onKeyDown={e => e.key === 'Enter' && go()} /></div>
    <p className="err">{err}</p>
    <button className="primary" onClick={go}>Activar caja</button>
  </Shell>;
}

function PinScreen({ onOk }: { onOk: (e: Employee, pin: string) => void }) {
  const [pin, setPin] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function press(k: string) {
    setErr('');
    if (busy) return;
    const p = k === '⌫' ? pin.slice(0, -1) : (pin + k).slice(0, PIN_LEN);
    setPin(p);
    if (p.length === PIN_LEN && k !== '⌫') {
      setBusy(true);
      const { data, error } = await supabase.rpc('pin_login', { p_pin: p });
      setBusy(false);
      if (!error && data?.[0]) { onOk(data[0], p); return; }
      setErr(error?.message ?? 'PIN incorrecto'); setPin('');
    }
  }
  return <div className="pin">
    <div className="hero"><img src="/logo.png" alt="Pancho Esquites" /></div>
    <h1 className="ptitle">Ingresa tu <span>PIN</span></h1>
    <p className="psub">para abrir caja</p>
    <div className="circles">{Array.from({ length: PIN_LEN }, (_, i) => <i key={i} className={i < pin.length ? 'f' : ''} />)}</div>
    <p className="err">{err}</p>
    <div className="pad2">{['1','2','3','4','5','6','7','8','9','','0','⌫'].map((k, i) =>
      k ? <button key={i} aria-label={k === '⌫' ? 'Borrar' : k} onClick={() => press(k)}>
        {k === '⌫' ? <svg viewBox="0 0 24 24"><path d="M21 5H9l-6 7 6 7h12z" /><path d="m13 9 4 6m0-6-4 6" /></svg> : k}</button> : <span key={i} />)}</div>
  </div>;
}

type Person = { id: string; name: string; role: 'cajero' | 'admin'; active: boolean };

function Staff({ pin, onClose, onPassed }: { pin: string; onClose: () => void; onPassed: () => void }) {
  const [list, setList] = useState<Person[]>([]);
  const [name, setName] = useState(''); const [np, setNp] = useState('');
  const [role, setRole] = useState<'cajero' | 'admin'>('cajero');
  const [edit, setEdit] = useState<string | null>(null); const [ep, setEp] = useState('');
  const [err, setErr] = useState('');
  const load = async () => {
    const { data, error } = await supabase.rpc('staff_list', { p_admin_pin: pin });
    if (error) setErr(error.message); else setList(data ?? []);
  };
  useEffect(() => { load(); }, []);
  async function save(p: Person | null, patch: { pin?: string; active?: boolean }) {
    setErr('');
    const { error } = await supabase.rpc('staff_upsert', {
      p_admin_pin: pin, p_id: p?.id ?? null, p_name: p?.name ?? name, p_pin: patch.pin ?? null,
      p_role: p?.role ?? (hasAdmin ? 'cajero' : role), p_active: patch.active ?? p?.active ?? true,
    });
    if (error) return setErr(error.message);
    if (!p) { setName(''); setNp(''); }
    setEdit(null); setEp(''); load();
  }
  const hasAdmin = list.some(p => p.role === 'admin' && p.active);
  async function makeAdmin(p: Person) {
    if (!confirm(`¿Pasar el mando a ${p.name}? Tú quedarás como cajero y se cerrará tu turno.`)) return;
    const { error } = await supabase.rpc('staff_make_admin', { p_admin_pin: pin, p_to: p.id });
    if (error) setErr(error.message); else onPassed();
  }
  async function remove(p: Person) {
    if (!confirm(`¿Borrar a ${p.name}? No se puede deshacer.`)) return;
    setErr('');
    const { error } = await supabase.rpc('staff_delete', { p_admin_pin: pin, p_id: p.id });
    if (error) setErr(error.message); else load();
  }
  return <div className="sheet" onClick={e => e.target === e.currentTarget && onClose()}><div className="panel">
    <h2>Empleados</h2>
    {list.map(p => <div key={p.id}>
      <div className="row"><span>{p.name} · {p.role}{p.active ? '' : ' (inactivo)'}</span>
        <span>
          <button onClick={() => { setEdit(edit === p.id ? null : p.id); setEp(''); }}>PIN</button>{' '}
          {p.active && p.role === 'cajero' && <><button onClick={() => makeAdmin(p)}>Hacer admin</button>{' '}</>}
          <button onClick={() => save(p, { active: !p.active })}>{p.active ? 'Desactivar' : 'Activar'}</button>
          {!p.active && <>{' '}<button onClick={() => remove(p)}>Eliminar</button></>}
        </span></div>
      {edit === p.id && <div>
        <input inputMode="numeric" maxLength={PIN_LEN} placeholder="Nuevo PIN (6 números)" value={ep} onChange={e => setEp(e.target.value.replace(/\D/g, ''))} />
        <button className="primary" disabled={ep.length !== PIN_LEN} onClick={() => save(p, { pin: ep })}>Guardar PIN</button>
      </div>}
    </div>)}
    <h3>Nuevo empleado</h3>
    <input placeholder="Nombre" value={name} onChange={e => setName(e.target.value)} />
    <input inputMode="numeric" maxLength={PIN_LEN} placeholder="PIN (6 números)" value={np} onChange={e => setNp(e.target.value.replace(/\D/g, ''))} />
    <div className="cats" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <button className={(hasAdmin || role === 'cajero') ? 'on' : ''} onClick={() => setRole('cajero')}>Cajero</button>
      <button className={!hasAdmin && role === 'admin' ? 'on' : ''} disabled={hasAdmin} onClick={() => setRole('admin')}>Admin</button></div>
    {hasAdmin && <p className="muted">Ya hay un administrador activo. Para cambiarlo usa "Hacer admin" en el empleado.</p>}
    <p className="err">{err}</p>
    <button className="primary" disabled={!name.trim() || np.length !== PIN_LEN} onClick={() => save(null, { pin: np })}>Agregar</button>
    <p><button onClick={onClose}>Cerrar</button></p>
  </div></div>;
}
