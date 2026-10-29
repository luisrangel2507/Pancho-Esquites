'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase, rpc, mx, Product, Category, Employee } from '@/lib/supabase';
import Reports from './reports';
import { askPush, enablePush } from '@/lib/push';
import { OpenCash, CloseCash, CashBlocked, dayTime, type Cash } from './cash';
import { ActivateDevice, Connecting, DevicesSheet } from './devices';

const MAX_ADMINS = 2;
const CLOSE_REMINDER_HOUR = 21; // 9 pm, hora de Ciudad de México

// Aviso del teléfono una vez por noche (solo si el usuario dio permiso y la app sigue abierta o en segundo plano)
async function notifyClose() {
  try {
    const key = 'aviso-cierre-' + new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
    if (localStorage.getItem(key) || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body: 'Ya son las 9 pm: hay que cerrar la caja.', icon: '/icon-192.png', tag: 'cierre' };
    if (reg) await reg.showNotification('Pancho Esquites', opts); else new Notification('Pancho Esquites', opts);
    localStorage.setItem(key, '1');
  } catch { /* sin permiso o sin soporte: queda la barra en pantalla */ }
}

const PIN_LEN = 6; // el PIN es de exactamente 6 dígitos y se verifica una sola vez, al completarlo
const IDLE_MS = 3 * 60 * 60 * 1000; // cierra el turno tras 3 horas sin uso (igual que el pase en la base)

type Cart = Record<number, { qty: number; note: string }>;

export default function Caja() {
  // Teléfono: 'loading' → 'ready' (activado) | 'activate' (pide código) | 'error' (reintenta solo)
  const [dev, setDev] = useState<'loading' | 'ready' | 'activate' | 'error'>('loading');
  const [devErr, setDevErr] = useState('');
  const devRef = useRef(dev); devRef.current = dev;
  const retryRef = useRef<() => void>(() => {});
  const session = dev === 'ready';
  const [phones, setPhones] = useState(false);
  const [emp, setEmp] = useState<Employee | null>(null);
  const [pin, setPin] = useState(''); // pase de turno (o PIN si la base es vieja); solo en memoria mientras dura el turno
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
  const [caja, setCaja] = useState<Cash | 'na' | null>(null);
  const [closing, setClosing] = useState(false);
  const loginCash = useRef<Cash | null>(null);
  const [lateHour, setLateHour] = useState(false);

  // Recordatorio de cierre: de 9 pm a 5 am (hora de Ciudad de México) con la caja abierta
  useEffect(() => {
    const open = !!caja && caja !== 'na' && caja.open && !caja.stale;
    const tick = () => {
      const h = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', hour: 'numeric', hourCycle: 'h23' }).format(new Date());
      const late = h >= CLOSE_REMINDER_HOUR || h < 5;
      setLateHour(late);
      if (open && late) notifyClose();
    };
    tick();
    const t = setInterval(tick, 60 * 1000);
    return () => clearInterval(t);
  }, [caja]);

  function logout() {
    if (pin.startsWith('T:')) rpc('shift_end', { p_token: pin });
    setEmp(null); setPin(''); setCart({}); setCheckout(false); setTicket(null); setClosing(false); setMenu(false);
  }
  useEffect(() => {
    const h = () => { setEmp(null); setPin(''); setCart({}); setCheckout(false); setTicket(null); setClosing(false); };
    window.addEventListener('turno-vencido', h);
    return () => window.removeEventListener('turno-vencido', h);
  }, []);
  const [ticket, setTicket] = useState<{ id: number; total: number } | null>(null);

  // Cada teléfono tiene su propia sesión (anónima de Supabase) y se activa una vez con un código del dueño.
  // No hay contraseña dentro de la app.
  useEffect(() => {
    let alive = true;
    // cada paso con límite de 10 s: nunca se queda colgado en "Conectando"
    const limit = <T,>(pr: PromiseLike<T>, step: string) => Promise.race([
      Promise.resolve(pr),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${step}: no respondió en 10 s`)), 10000)),
    ]);
    let busy = false;
    const check = async () => {
      if (busy) return; busy = true;
      try {
        const { data } = await limit(supabase.auth.getSession(), 'Sesión');
        const had = !!data.session;
        if (!had) {
          const r = await limit(supabase.auth.signInAnonymously(), 'Inicio anónimo');
          if (r.error) {
            if (!alive) return;
            setDevErr(/anonymous|not allowed|disabled/i.test(r.error.message) ? 'Falta activar los inicios anónimos en Supabase.' : 'Inicio anónimo: ' + r.error.message);
            setDev('error'); return;
          }
        }
        const { data: ok, error } = await limit(supabase.rpc('device_status'), 'Revisar teléfono');
        if (!alive) return;
        if (error) {
          // base sin la activación nueva: un teléfono que ya tenía sesión sigue funcionando como antes
          if (/find the function/i.test(error.message)) { if (had) { setDev('ready'); return; } setDevErr('Falta correr el SQL de activación en Supabase.'); }
          else setDevErr('Revisar teléfono: ' + error.message);
          setDev('error'); return;
        }
        setDevErr(''); setDev(ok ? 'ready' : 'activate');
      } catch (e) {
        if (alive) { setDevErr((e as Error).message || 'Sin conexión'); setDev('error'); }
      } finally { busy = false; }
    };
    retryRef.current = check;
    check();
    const retry = setInterval(() => { if (devRef.current === 'error') check(); }, 10000);
    const removed = () => { setEmp(null); setPin(''); check(); };
    window.addEventListener('dispositivo-quitado', removed);
    return () => { alive = false; clearInterval(retry); window.removeEventListener('dispositivo-quitado', removed); };
  }, []);

  useEffect(() => {
    if (!emp) { setCaja(null); setClosing(false); return; }
    if (pin.startsWith('T:')) enablePush(pin);
    if (loginCash.current) { setCaja(loginCash.current); loginCash.current = null; return; }
    rpc('cash_status', { p_pin: pin }).then(({ data, error }) => {
      // si la base aún no tiene las funciones de caja, la app sigue funcionando sin ellas
      if (error) setCaja(/find the function/i.test(error.message) ? 'na' : { open: false });
      else setCaja(data as Cash);
    });
  }, [emp]);

  useEffect(() => {
    if (!emp) return;
    let t: ReturnType<typeof setTimeout>;
    const out = () => logout();
    const reset = () => { clearTimeout(t); t = setTimeout(out, IDLE_MS); };
    const evs = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;
    evs.forEach(e => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => { clearTimeout(t); evs.forEach(e => window.removeEventListener(e, reset)); };
  }, [emp]);

  useEffect(() => {
    if (!session) return;
    (async () => {
      const [c, p] = await Promise.all([
        supabase.from('categories').select('id,name').order('sort'),
        supabase.from('products').select('*').eq('active', true).order('sort'),
      ]);
      setCats(c.data ?? []); setProds(p.data ?? []);
      setCur(cur => cur ?? c.data?.[0]?.id ?? null);
    })();
  }, [session]);

  const total = useMemo(() => Object.entries(cart).reduce((s, [id, v]) =>
    s + (prods.find(p => p.id === +id)?.price_cents ?? 0) * v.qty, 0), [cart, prods]);
  const count = Object.values(cart).reduce((s, v) => s + v.qty, 0);

  if (dev === 'loading' || dev === 'error') return <Connecting err={devErr} onRetry={dev === 'error' ? () => { setDev('loading'); setDevErr(''); retryRef.current(); } : undefined} />;
  if (dev === 'activate') return <ActivateDevice onDone={() => setDev('ready')} />;

  if (!emp) return <PinScreen onOk={(e, p, c) => { loginCash.current = c ?? null; setEmp(e); setPin(p); }} />;

  const add = (id: number, d: number) => setCart(c => {
    const q = (c[id]?.qty ?? 0) + d; const n = { ...c };
    if (q <= 0) delete n[id]; else n[id] = { qty: q, note: c[id]?.note ?? '' };
    return n;
  });

  async function cobrar() {
    setMsg('');
    const items = Object.entries(cart).map(([id, v]) => ({ product_id: +id, qty: v.qty, note: v.note }));
    const cashCents = pay === 'cash' ? Math.round(parseFloat(cash || '0') * 100) : null;
    const { data, error } = await rpc('register_sale', { p_pin: pin, p_items: items, p_pay: pay, p_cash_cents: cashCents });
    if (error) return setMsg(error.message);
    setTicket({ id: data[0].sale_id, total: data[0].total_cents });
    setCart({}); setCash(''); setCheckout(false);
  }

  const cashCents = Math.round(parseFloat(cash || '0') * 100);
  const photoOf = (p: Product): string | null => {
    if (p.photo_path) return supabase.storage.from('products').getPublicUrl(p.photo_path).data.publicUrl;
    const f = cats.find(c => c.id === p.category_id)?.name === 'Esquites' ? FOTOS[p.short_name ?? p.name] : undefined;
    return f ? `/fotos/${f}.webp` : null;
  };

  return (
    <div className="app">
      <header className="hdr">
        <button className="burger" aria-label="Menú" onClick={() => setMenu(m => !m)}>
          <svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
        <img className="logo" src="/logo.webp" alt="Pancho Esquites" />
        <div className="tag">Esquites,<br />Elotes<br /><em>y más…</em></div>
        {emp.role === 'admin'
          ? <button className="pill" onClick={() => setMenu(m => !m)}>{USER_SVG}Admin ⌄</button>
          : <span className="pill">{USER_SVG}{emp.name}</span>}
        {menu && <div className="menu-bg" onClick={() => setMenu(false)} />}
        {menu && <div className="menu">
          <button onClick={() => { setMenu(false); logout(); }}>Cerrar turno ({emp.name})</button>
          {caja && caja !== 'na' && caja.open && <button onClick={() => { setClosing(true); setMenu(false); }}>Cerrar caja</button>}
          {emp.role === 'admin' && <button onClick={() => { setReports(true); setMenu(false); }}>Ventas e informes</button>}
          {emp.role === 'admin' && <button onClick={() => { setStaff(true); setMenu(false); }}>Empleados</button>}
          {emp.role === 'admin' && <button onClick={() => { setPhones(true); setMenu(false); }}>Teléfonos</button>}
          {emp.role === 'admin' && <a href="/admin">Administración</a>}
          {typeof Notification !== 'undefined' && Notification.permission === 'default' &&
            <button onClick={() => { setMenu(false); askPush(pin); }}>Activar avisos de cierre</button>}
          <button className="mx" onClick={() => setMenu(false)}>Cerrar menú</button>
        </div>}
      </header>
      <main className="sheetbody">
        {caja && caja !== 'na' && caja.open && !caja.stale && lateHour && <button className="remind" onClick={() => setClosing(true)}>
          <span>🌙</span><b>Ya son las 9 pm: no olvides cerrar la caja</b><em>Cerrar caja ›</em></button>}
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
                  : local ? <img src={`/fotos/${local}.webp`} alt="" /> : icon(cat)}
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

      {emp && caja === null && <div className="sheet cobro cashs"><div className="panel center">Cargando caja…</div></div>}
      {emp && caja && caja !== 'na' && !caja.open && (emp.role === 'admin' && !caja.today_closed
        ? <OpenCash pin={pin} name={emp.name} onOpened={c => setCaja(c)} onLogout={logout} />
        : <CashBlocked name={emp.name} todayClosed={!!caja.today_closed} onLogout={logout} />)}
      {emp && caja && caja !== 'na' && caja.open && caja.stale && <CloseCash pending pin={pin} onClose={() => {}}
        onDone={() => rpc('cash_status', { p_pin: pin }).then(({ data, error }) => setCaja(error ? { open: false } : data as Cash))} />}
      {closing && <CloseCash pin={pin} onClose={() => setClosing(false)}
        onDone={logout} />}
      {phones && <DevicesSheet pin={pin} onClose={() => setPhones(false)} />}
      {reports && <Reports pin={pin} onClose={() => setReports(false)} />}
      {staff && <Staff pin={pin} meId={emp.employee_id} onClose={() => setStaff(false)} />}

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

      {ticket && <div className="sheet cobro done" onClick={() => setTicket(null)}><div className="panel" onClick={e => e.stopPropagation()}>
        <i className="kn k1" /><i className="kn k2" /><i className="kn k3" /><i className="kn k4" />
        <div className="ok">
          <svg className="sp" viewBox="0 0 120 80"><path d="M10 40H2M20 12 14 6M100 12l6-6M110 40h8M20 68l-6 6M100 68l6 6" /></svg>
          <span className="ok-c"><svg viewBox="0 0 24 24"><path d="m5 12.500 4.500 4.500L19 7.500" /></svg></span>
        </div>
        <h1 className="ok-t">¡Venta registrada!</h1>
        <span className="ok-n">#{ticket.id}</span>
        <div className="ok-m"><b>{mx(ticket.total)}</b></div>
        <button className="regv" onClick={() => setTicket(null)}>Nueva venta</button>
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
    <img className="art-top" src="/auth-top.webp" alt="Pancho Esquites" />
    <div className="body">{children}</div>
    <img className="art-bot" src="/auth-bottom.webp" alt="" />
  </div>;
}

const UserIcon = () => <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
const Lock = () => <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;

function PinScreen({ onOk }: { onOk: (e: Employee, pin: string, cash?: Cash) => void }) {
  const [pin, setPin] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function press(k: string) {
    setErr('');
    if (busy) return;
    const p = k === '⌫' ? pin.slice(0, -1) : (pin + k).slice(0, PIN_LEN);
    setPin(p);
    if (p.length === PIN_LEN && k !== '⌫') {
      setBusy(true);
      let { data, error } = await rpc('shift_start', { p_pin: p });
      let pass = data?.[0]?.token as string | undefined;
      if (error && /find the function/i.test(error.message)) {
        ({ data, error } = await rpc('pin_login', { p_pin: p }));
        pass = p;
      }
      setBusy(false);
      if (!error && data?.[0] && pass) { onOk(data[0], pass, data[0].cash ?? undefined); return; }
      setErr(error?.message ?? 'PIN incorrecto'); setPin('');
    }
  }
  return <div className="pin">
    <div className="hero"><img src="/logo.webp" alt="Pancho Esquites" /></div>
    <h1 className="ptitle">Ingresa tu <span>PIN</span></h1>
    <p className="psub">para abrir caja</p>
    <div className="circles">{Array.from({ length: PIN_LEN }, (_, i) => <i key={i} className={i < pin.length ? 'f' : ''} />)}</div>
    <p className="err">{err}</p>
    <div className="pad2">{['1','2','3','4','5','6','7','8','9','','0','⌫'].map((k, i) =>
      k ? <button key={i} aria-label={k === '⌫' ? 'Borrar' : k} onClick={() => press(k)}>
        {k === '⌫' ? <svg viewBox="0 0 24 24"><path d="M21 5H9l-6 7 6 7h12z" /><path d="m13 9 4 6m0-6-4 6" /></svg> : k}</button> : <span key={i} />)}</div>
  </div>;
}

const sx = (d: React.ReactNode, c = 'ico') => <svg viewBox="0 0 24 24" className={c}>{d}</svg>;
const S = {
  people: sx(<><circle cx="9" cy="8" r="3.600" fill="currentColor" stroke="none" /><path d="M2.500 20a6.500 6.500 0 0 1 13 0z" fill="currentColor" stroke="none" /><circle cx="17" cy="9" r="2.800" fill="#F7CC3E" stroke="none" /><path d="M13.500 20a5.500 5.500 0 0 1 8.500-4.500V20z" fill="#F7CC3E" stroke="none" /></>, 'ico big'),
  user: sx(<><circle cx="12" cy="8.500" r="4" fill="currentColor" stroke="none" /><path d="M4.500 21a7.500 7.500 0 0 1 15 0z" fill="currentColor" stroke="none" /></>),
  userG: sx(<><circle cx="12" cy="8.500" r="4" fill="currentColor" stroke="none" /><path d="M4.500 21a7.500 7.500 0 0 1 15 0z" fill="currentColor" stroke="none" /></>, 'ico fld'),
  lock: sx(<><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" stroke="none" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>),
  lockG: sx(<><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" stroke="none" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>, 'ico fld'),
  power: sx(<><path d="M12 3v8M6.500 6.500a8 8 0 1 0 11 0" /></>),
  crown: sx(<path d="M3 8l4.500 4L12 5l4.500 7L21 8l-2 11H5z" fill="currentColor" stroke="none" />, 'ico sm'),
  userPlus: sx(<><circle cx="10" cy="8.500" r="4" fill="currentColor" stroke="none" /><path d="M2.500 21a7.500 7.500 0 0 1 15 0z" fill="currentColor" stroke="none" /><path d="M19 8v6M16 11h6" strokeWidth="2.400" /></>, 'ico'),
  userPlusW: sx(<><circle cx="10" cy="8.500" r="4" fill="currentColor" stroke="none" /><path d="M2.500 21a7.500 7.500 0 0 1 15 0z" fill="currentColor" stroke="none" /><path d="M19 8v6M16 11h6" strokeWidth="2.400" /></>, 'ico'),
  eye: sx(<><path d="M2 12s3.600-7 10-7 10 7 10 7-3.600 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>),
  eyeOff: sx(<><path d="M3 3l18 18M10.600 6.200A9.800 9.800 0 0 1 12 6c6.400 0 10 6 10 6a17 17 0 0 1-3.200 3.800M6.500 7.600A17 17 0 0 0 2 12s3.600 7 10 7a9.700 9.700 0 0 0 4-.9" /></>),
  till: sx(<><rect x="3" y="11" width="18" height="9" rx="2" fill="currentColor" stroke="none" /><path d="M6 11V8h8l2 3M8 5h6" /></>, 'ico big'),
  gear: sx(<><circle cx="12" cy="12" r="3" /><path d="M12 2.500l1.600 2.300 2.800-.5.8 2.700 2.600 1.200-.9 2.700 1.700 2.200-2.200 1.800.1 2.800-2.800.5-1.500 2.400-2.600-1.200-2.600 1.200-1.500-2.400-2.800-.5.1-2.800L2.200 13.500 3.900 11.300 3 8.600l2.600-1.200.8-2.700 2.800.5z" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="3" fill="#fff" stroke="none" /></>, 'ico big'),
};

type Person = { id: string; name: string; role: 'cajero' | 'admin'; active: boolean; is_support?: boolean; expires_at?: string | null };

function Staff({ pin, meId, onClose }: { pin: string; meId: string; onClose: () => void }) {
  const [list, setList] = useState<Person[]>([]);
  const [name, setName] = useState(''); const [np, setNp] = useState('');
  const [role, setRole] = useState<'cajero' | 'admin'>('cajero');
  const [edit, setEdit] = useState<string | null>(null); const [ep, setEp] = useState('');
  const [err, setErr] = useState('');
  const load = async () => {
    const { data, error } = await rpc('staff_list', { p_admin_pin: pin });
    if (error) setErr(error.message); else setList(data ?? []);
  };
  useEffect(() => { load(); }, []);
  async function save(p: Person | null, patch: { pin?: string; active?: boolean }) {
    setErr('');
    const { error } = await rpc('staff_upsert', {
      p_admin_pin: pin, p_id: p?.id ?? null, p_name: p?.name ?? name, p_pin: patch.pin ?? null,
      p_role: p?.role ?? (hasAdmin ? 'cajero' : role), p_active: patch.active ?? p?.active ?? true,
    });
    if (error) return setErr(error.message);
    if (!p) { setName(''); setNp(''); }
    setEdit(null); setEp(''); load();
  }
  const hasAdmin = list.filter(p => p.role === 'admin' && p.active && !p.is_support).length >= MAX_ADMINS;
  const meSupport = list.some(p => p.id === meId && p.is_support);
  const sup = list.find(p => p.is_support && p.active);
  const supLive = !!sup && (!sup.expires_at || new Date(sup.expires_at) > new Date());
  const [hours, setHours] = useState(24);
  const [newPin, setNewPin] = useState<{ pin: string; expires_at: string } | null>(null);
  async function genSupport() {
    if (supLive && !confirm('Esto anula el PIN de soporte actual. ¿Continuar?')) return;
    setErr('');
    const { data, error } = await rpc('support_pin_create', { p_admin_pin: pin, p_hours: hours });
    if (error) return setErr(error.message);
    setNewPin(data); load();
  }
  async function revoke() {
    if (!confirm('¿Revocar el PIN de soporte? El acceso se corta al momento.')) return;
    setErr('');
    const { error } = await rpc('support_pin_revoke', { p_admin_pin: pin });
    if (error) setErr(error.message); else { setNewPin(null); load(); }
  }
  async function makeAdmin(p: Person) {
    if (!confirm(`¿Dar permisos de administrador a ${p.name}?`)) return;
    setErr('');
    const { error } = await rpc('staff_make_admin', { p_admin_pin: pin, p_to: p.id });
    if (error) setErr(error.message); else load();
  }
  async function demote(p: Person) {
    if (!confirm(`¿Quitar permisos de administrador a ${p.name}? Quedará como cajero.`)) return;
    setErr('');
    const { error } = await rpc('staff_upsert', { p_admin_pin: pin, p_id: p.id, p_name: p.name, p_pin: null, p_role: 'cajero', p_active: true });
    if (error) setErr(error.message); else load();
  }
  async function remove(p: Person) {
    if (!confirm(`¿Borrar a ${p.name}? No se puede deshacer.`)) return;
    setErr('');
    const { error } = await rpc('staff_delete', { p_admin_pin: pin, p_id: p.id });
    if (error) setErr(error.message); else load();
  }
  const [showPin, setShowPin] = useState(false);
  const adminRole = !hasAdmin && role === 'admin';
  return <div className="sheet cobro staff" onClick={e => e.target === e.currentTarget && onClose()}><div className="panel">
    <div className="grab" />
    <div className="st-h">
      <span className="st-ic">{S.people}</span>
      <div className="st-t"><h2>Empleados</h2><small>Gestiona los empleados que pueden acceder al punto de venta.</small></div>
      <button className="st-x" aria-label="Cerrar" onClick={onClose}>×</button>
    </div>
    <div className="st-list">
      {list.filter(p => !p.is_support).map(p => <div key={p.id}>
        <div className={'st-row' + (p.active ? '' : ' off')}>
          <span className={'av ' + (p.role === 'admin' ? 'gold' : 'green')}>{S.user}</span>
          <div className="st-n">
            <div className="st-nm"><b>{p.name}</b>{p.role === 'admin' && <span className="crown">{S.crown}</span>}
              <em className={p.role === 'admin' ? 'bd-a' : 'bd-e'}>{p.role === 'admin' ? 'Admin' : 'Empleado'}</em></div>
            <small>{!p.active ? 'Inactivo' : p.role === 'admin' ? 'Administrador del sistema' : 'Cajero'}</small>
          </div>
          <div className="st-b">
            <button className="b-pin" onClick={() => { setEdit(edit === p.id ? null : p.id); setEp(''); }}>{S.lock}PIN</button>
            {p.active
              ? <button className="b-off" onClick={() => save(p, { active: false })}>{S.power}Desactivar</button>
              : <button className="b-on" onClick={() => save(p, { active: true })}>{S.power}Activar</button>}
          </div>
        </div>
        {(p.active && p.role === 'cajero' && !hasAdmin) && <button className="st-mk" onClick={() => makeAdmin(p)}>Hacer admin a {p.name}</button>}
        {(p.active && p.role === 'admin' && p.id !== meId) && <button className="st-mk" onClick={() => demote(p)}>Quitar admin a {p.name}</button>}
        {!p.active && <button className="st-del" onClick={() => remove(p)}>Eliminar a {p.name}</button>}
        {edit === p.id && <div className="st-pin">
          <input inputMode="numeric" maxLength={PIN_LEN} placeholder="Nuevo PIN (6 números)" value={ep} onChange={e => setEp(e.target.value.replace(/\D/g, ''))} />
          <button className="regv sm" disabled={ep.length !== PIN_LEN} onClick={() => save(p, { pin: ep })}>Guardar PIN</button>
        </div>}
      </div>)}
    </div>

    {meSupport ? <p className="muted sup-me">Entraste con el PIN de soporte: puedes consultar, pero no administrar empleados.</p> : <>
    <div className="sup">
      <div className="sup-h"><span className="sup-ic">{S.lock}</span>
        <div><h3>PIN de soporte</h3><small>Acceso temporal para el desarrollador. Vence solo y puedes revocarlo cuando quieras.</small></div></div>
      {newPin && <div className="sup-new"><small>PIN de soporte · se muestra una sola vez</small><b>{newPin.pin}</b>
        <small>Vence {dayTime(newPin.expires_at)} · Compártelo solo por mensaje privado.</small></div>}
      {supLive && sup
        ? <div className="sup-row"><span>Activo hasta <b>{dayTime(sup.expires_at!)}</b></span>
            <button className="b-off" onClick={revoke}>{S.power}Revocar</button></div>
        : !newPin && <p className="muted">No hay PIN de soporte activo.</p>}
      <div className="quick">{([[24, '24 horas'], [72, '3 días'], [168, '7 días']] as const).map(([h, l]) =>
        <button key={h} className={hours === h ? 'on' : ''} onClick={() => setHours(h)}>{l}</button>)}</div>
      <button className="regv sm" onClick={genSupport}>{supLive ? 'Generar uno nuevo' : 'Generar PIN de soporte'}</button>
    </div>

    <div className="st-new">
      <span className="st-ic2">{S.userPlus}</span>
      <div><h3>Nuevo empleado</h3><small>Agrega un nuevo empleado y asigna su rol en el sistema.</small></div>
    </div>
    <label className="st-l" htmlFor="st-name">Nombre completo</label>
    <div className="st-f">{S.userG}<input id="st-name" placeholder="Ej. Juan Pérez" value={name} onChange={e => setName(e.target.value)} /></div>
    <label className="st-l" htmlFor="st-pin">PIN de acceso</label>
    <div className="st-f">{S.lockG}<input id="st-pin" type={showPin ? 'text' : 'password'} inputMode="numeric" maxLength={PIN_LEN} placeholder="6 números"
      value={np} onChange={e => setNp(e.target.value.replace(/\D/g, ''))} />
      <button type="button" className="eye" aria-label="Ver PIN" onClick={() => setShowPin(v => !v)}>{showPin ? S.eye : S.eyeOff}</button></div>
    <div className="st-l">Tipo de empleado</div>
    <div className="st-roles">
      <button className={'rl' + (!adminRole ? ' on' : '')} onClick={() => setRole('cajero')}>
        <span className="rl-ic gold">{S.till}</span><div><b>Cajero</b><small>Puede realizar ventas y operaciones básicas.</small></div>
        <i className={'rd' + (!adminRole ? ' ck' : '')}>{!adminRole && '✓'}</i></button>
      <button className={'rl' + (adminRole ? ' on' : '')} disabled={hasAdmin} onClick={() => setRole('admin')}>
        <span className="rl-ic gray">{S.gear}</span><div><b>Admin</b><small>Acceso completo a todas las funciones.</small></div>
        <i className={'rd' + (adminRole ? ' ck' : '')}>{adminRole && '✓'}</i></button>
    </div>
    {hasAdmin && <p className="muted">Ya hay {MAX_ADMINS} administradores activos. Para dar de alta otro, quita o desactiva uno.</p>}
    <p className="err">{err}</p>
    <button className="regv" disabled={!name.trim() || np.length !== PIN_LEN} onClick={() => save(null, { pin: np })}>{S.userPlusW}Agregar empleado</button>
    </>}
    {meSupport && <p className="err">{err}</p>}
    <button className="st-close" onClick={onClose}>Cerrar</button>
  </div></div>;
}
