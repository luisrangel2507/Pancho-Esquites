'use client';
import { useEffect, useMemo, useState } from 'react';
import { supabase, mx, Product, Category, Employee } from '@/lib/supabase';

// Supabase exige un correo: al usuario "caja1" se le agrega este dominio interno
const USER_DOMAIN = 'esquites.com';
const AUTO_USER = process.env.NEXT_PUBLIC_CAJA_USER;
const AUTO_PASS = process.env.NEXT_PUBLIC_CAJA_PASS;
const toEmail = (u: string) => u.includes('@') ? u.trim() : `${u.trim().toLowerCase()}@${USER_DOMAIN}`;
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

  return (
    <div className="app">
      <header className="hdr">
        <button className="burger" aria-label="Menú" onClick={() => setMenu(m => !m)}>
          <svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
        <img className="logo" src="/logo.png" alt="Pancho Esquites" />
        <div className="tag">Esquites,<br />Elotes<br /><em>y más…</em></div>
        {emp.role === 'admin'
          ? <a className="pill" href="/admin">{USER_SVG}Admin ⌄</a>
          : <span className="pill">{USER_SVG}{emp.name}</span>}
        {menu && <div className="menu">
          <button onClick={() => { setEmp(null); setPin(''); setCart({}); setMenu(false); }}>Cerrar turno ({emp.name})</button>
          {emp.role === 'admin' && <button onClick={() => { setStaff(true); setMenu(false); }}>Empleados</button>}
          {emp.role === 'admin' && <a href="/admin">Administración</a>}
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

      {staff && <Staff pin={pin} onClose={() => setStaff(false)} />}

      {checkout && <div className="sheet" onClick={e => e.target === e.currentTarget && setCheckout(false)}><div className="panel">
        <h2>Cobrar {mx(total)}</h2>
        {Object.entries(cart).map(([id, v]) => {
          const p = prods.find(x => x.id === +id)!;
          return <div key={id}>
            <div className="row"><span>{v.qty} × {p.name}</span>
              <span><button onClick={() => add(p.id, -1)}>−</button> <button onClick={() => add(p.id, 1)}>+</button></span></div>
          </div>;
        })}
        <div className="cats" style={{ gridTemplateColumns: 'repeat(3,1fr)', margin: '10px 0' }}>
          {(['cash', 'card', 'spei'] as const).map(k => <button key={k} className={pay === k ? 'on' : ''} onClick={() => setPay(k)}>
            {k === 'cash' ? 'Efectivo' : k === 'card' ? 'Tarjeta' : 'Transferencia'}</button>)}
        </div>
        {pay === 'cash' && <>
          <input id="cash" inputMode="decimal" placeholder="Recibido $" value={cash} onChange={e => setCash(e.target.value.replace(/[^\d.]/g, ''))} />
          <div className="row"><b>Cambio</b><b>{cash ? (cashCents >= total ? mx(cashCents - total) : 'Falta ' + mx(total - cashCents)) : '—'}</b></div>
        </>}
        <p className="err">{msg}</p>
        <button className="primary" onClick={cobrar}>Registrar venta</button>
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
  const [pin, setPin] = useState(''); const [err, setErr] = useState('');
  async function press(k: string) {
    setErr('');
    const p = k === '⌫' ? pin.slice(0, -1) : (pin + k).slice(0, 6);
    setPin(p);
    if (p.length >= 4 && k !== '⌫') {
      const { data, error } = await supabase.rpc('pin_login', { p_pin: p });
      if (!error && data?.[0]) { onOk(data[0], p); return; }
      if (p.length === 6 || error?.message.includes('intentos')) { setErr(error?.message ?? 'PIN incorrecto'); setPin(''); }
    }
  }
  return <div className="pin">
    <div className="hero"><img src="/logo.png" alt="Pancho Esquites" /></div>
    <h1 className="ptitle">Ingresa tu <span>PIN</span></h1>
    <p className="psub">para abrir caja</p>
    <div className="circles">{Array.from({ length: Math.max(4, pin.length) }, (_, i) => <i key={i} className={i < pin.length ? 'f' : ''} />)}</div>
    <p className="err">{err}</p>
    <div className="pad2">{['1','2','3','4','5','6','7','8','9','','0','⌫'].map((k, i) =>
      k ? <button key={i} aria-label={k === '⌫' ? 'Borrar' : k} onClick={() => press(k)}>
        {k === '⌫' ? <svg viewBox="0 0 24 24"><path d="M21 5H9l-6 7 6 7h12z" /><path d="m13 9 4 6m0-6-4 6" /></svg> : k}</button> : <span key={i} />)}</div>
  </div>;
}

type Person = { id: string; name: string; role: 'cajero' | 'admin'; active: boolean };

function Staff({ pin, onClose }: { pin: string; onClose: () => void }) {
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
      p_role: p?.role ?? role, p_active: patch.active ?? p?.active ?? true,
    });
    if (error) return setErr(error.message);
    if (!p) { setName(''); setNp(''); }
    setEdit(null); setEp(''); load();
  }
  return <div className="sheet" onClick={e => e.target === e.currentTarget && onClose()}><div className="panel">
    <h2>Empleados</h2>
    {list.map(p => <div key={p.id}>
      <div className="row"><span>{p.name} · {p.role}{p.active ? '' : ' (inactivo)'}</span>
        <span>
          <button onClick={() => { setEdit(edit === p.id ? null : p.id); setEp(''); }}>PIN</button>{' '}
          <button onClick={() => save(p, { active: !p.active })}>{p.active ? 'Desactivar' : 'Activar'}</button>
        </span></div>
      {edit === p.id && <div>
        <input inputMode="numeric" maxLength={6} placeholder="Nuevo PIN (4 a 6 números)" value={ep} onChange={e => setEp(e.target.value.replace(/\D/g, ''))} />
        <button className="primary" onClick={() => save(p, { pin: ep })}>Guardar PIN</button>
      </div>}
    </div>)}
    <h3>Nuevo empleado</h3>
    <input placeholder="Nombre" value={name} onChange={e => setName(e.target.value)} />
    <input inputMode="numeric" maxLength={6} placeholder="PIN (4 a 6 números)" value={np} onChange={e => setNp(e.target.value.replace(/\D/g, ''))} />
    <div className="cats" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <button className={role === 'cajero' ? 'on' : ''} onClick={() => setRole('cajero')}>Cajero</button>
      <button className={role === 'admin' ? 'on' : ''} onClick={() => setRole('admin')}>Admin</button></div>
    <p className="err">{err}</p>
    <button className="primary" disabled={!name.trim() || np.length < 4} onClick={() => save(null, { pin: np })}>Agregar</button>
    <p><button onClick={onClose}>Cerrar</button></p>
  </div></div>;
}
