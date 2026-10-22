'use client';
import { useEffect, useMemo, useState } from 'react';
import { supabase, mx, Product, Category, Employee } from '@/lib/supabase';

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
    <div className="wrap">
      <div className="top">
        <b>🌽 Pancho Esquites</b>
        <span><small>{emp.name}</small><button onClick={() => { setEmp(null); setPin(''); setCart({}); }}>Salir</button>
          {emp.role === 'admin' && <a href="/admin">Admin</a>}</span>
      </div>
      <div className="tabs">
        {cats.map(c => <button key={c.id} className={c.id === cur ? 'on' : ''} onClick={() => setCur(c.id)}>{icon(c.name)} {c.name}</button>)}
      </div>
      <div className="grid">
        {prods.filter(p => p.category_id === cur).map(p => (
          <button key={p.id} className={'item' + (cart[p.id] ? ' sel' : '')} onClick={() => add(p.id, 1)}>
            {p.photo_path
              ? <img src={supabase.storage.from('products').getPublicUrl(p.photo_path).data.publicUrl} alt="" />
              : <span className="ph">{icon(cats.find(c => c.id === p.category_id)?.name ?? '')}</span>}
            <span className="b"><b>{p.short_name ?? p.name}</b><span className="price">{mx(p.price_cents)}</span></span>
            {cart[p.id] && <span className="q">{cart[p.id].qty}</span>}
          </button>
        ))}
      </div>
      <div className="bar"><button disabled={!count} onClick={() => setCheckout(true)}>
        {count ? `Cobrar · ${count} artículos · ${mx(total)}` : 'Agrega productos para cobrar'}</button></div>

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

const Mail = () => <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>;
const Lock = () => <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;

function DeviceLogin() {
  const [email, setEmail] = useState(''); const [pass, setPass] = useState(''); const [err, setErr] = useState('');
  async function go() {
    const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
    if (error) setErr('Correo o contraseña incorrectos');
  }
  return <Shell>
    <h2>Activar caja</h2><p>Solo se hace una vez por dispositivo.<br />Lo hace el dueño.</p>
    <div className="field"><Mail /><input id="email" type="email" placeholder="Correo de la caja" value={email} onChange={e => setEmail(e.target.value)} /></div>
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
  return <Shell>
    <h2>Ingresa tu <span style={{ color: '#B8860B' }}>PIN</span></h2>
    <p className="dots">{'●'.repeat(pin.length) || <span style={{ fontSize: 16, letterSpacing: 0, color: '#7A6450' }}>para abrir caja</span>}</p>
    <p className="err">{err}</p>
    <div className="pad">{['1','2','3','4','5','6','7','8','9','','0','⌫'].map((k, i) =>
      k ? <button key={i} onClick={() => press(k)}>{k}</button> : <span key={i} />)}</div>
  </Shell>;
}
