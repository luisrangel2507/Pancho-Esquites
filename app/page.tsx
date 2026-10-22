'use client';
import { useEffect, useMemo, useState } from 'react';
import { supabase, mx, Product, Category, Employee } from '@/lib/supabase';

// Supabase exige un correo: al usuario "caja1" se le agrega este dominio interno
const USER_DOMAIN = 'esquites.com';
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
  const [ticket, setTicket] = useState<{ id: number; total: number } | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(!!data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(!!s));
    return () => sub.subscription.unsubscribe();
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
          ? <a className="pill" href="/admin">👤 Admin ⌄</a>
          : <span className="pill">👤 {emp.name}</span>}
        {menu && <div className="menu">
          <button onClick={() => { setEmp(null); setPin(''); setCart({}); setMenu(false); }}>Cerrar turno ({emp.name})</button>
          {emp.role === 'admin' && <a href="/admin">Administración</a>}
        </div>}
      </header>
      <div className="chips">
        {cats.map(c => {
          const n = prods.filter(p => p.category_id === c.id).reduce((a, p) => a + (cart[p.id]?.qty ?? 0), 0);
          return <button key={c.id} className={'chip' + (c.id === cur ? ' on' : '')} onClick={() => setCur(c.id)}>
            <i>{icon(c.name)}</i>{c.name}{n > 0 && <span className="n">{n}</span>}
          </button>;
        })}
      </div>
      <div className="grid3">
        {prods.filter(p => p.category_id === cur).map(p => (
          <div key={p.id} role="button" className={'card' + (cart[p.id] ? ' sel' : '')} onClick={() => add(p.id, 1)}>
            <div className="ph">
              {p.photo_path
                ? <img src={supabase.storage.from('products').getPublicUrl(p.photo_path).data.publicUrl} alt="" />
                : icon(cats.find(c => c.id === p.category_id)?.name ?? '')}
            </div>
            <div className="info">
              <b>{p.short_name ?? p.name}</b>
              <div className="prow"><span className="price">{mx(p.price_cents)}</span><span className="plus">+</span></div>
            </div>
            {cart[p.id] && <>
              <span className="cnt">{cart[p.id].qty}</span>
              <button className="minus" aria-label="Quitar uno" onClick={e => { e.stopPropagation(); add(p.id, -1); }}>−</button>
            </>}
          </div>
        ))}
      </div>
      <button className="pay" disabled={!count} onClick={() => setCheckout(true)}>
        <span className="cartic">
          <svg viewBox="0 0 24 24"><path d="M3 4h2l2.4 10.2a1 1 0 0 0 1 .8h8.8a1 1 0 0 0 1-.8L20 8H6.2" /><circle cx="9" cy="19" r="1.3" /><circle cx="17" cy="19" r="1.3" /></svg>
        </span>
        <span className="bd">{count}</span>
        <span className="sep" />
        <span className="ptxt">{count ? `Cobrar · ${count} artículo${count > 1 ? 's' : ''}` : 'Agrega productos para cobrar'}</span>
        {count ? <span className="tot">{mx(total)}</span> : <span>›</span>}
      </button>

      {checkout && <div className="sheet" onClick={e => e.target === e.currentTarget && setCheckout(false)}><div className="panel">
        <h2>Cobrar {mx(total)}</h2>
        {Object.entries(cart).map(([id, v]) => {
          const p = prods.find(x => x.id === +id)!;
          return <div key={id}>
            <div className="row"><span>{v.qty} × {p.name}</span>
              <span><button onClick={() => add(p.id, -1)}>−</button> <button onClick={() => add(p.id, 1)}>+</button></span></div>
            <input id={`note-${id}`} placeholder="Nota (sin mayonesa, extra chile…)" value={v.note} maxLength={120}
              onChange={e => setCart(c => ({ ...c, [id]: { ...c[+id], note: e.target.value } }))} />
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
    const { error } = await supabase.auth.signInWithPassword({ email: user.includes('@') ? user.trim() : `${user.trim().toLowerCase()}@${USER_DOMAIN}`, password: pass });
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
