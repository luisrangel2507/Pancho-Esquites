// Prueba de punta a punta contra el servidor real y su base: node server/e2e.mjs <url> <código de activación> <PIN admin>
const [base, code, adminPin] = process.argv.slice(2);
const results = [];
const ok = (name, cond, info = '') => results.push([name, !!cond, info]);

const phone = () => {
  let token = null;
  const call = async (path, init = {}) => {
    const r = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) } });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  };
  return {
    async signIn() { const r = await call('/api/auth/anonymous', { method: 'POST' }); token = r.j.token; return r; },
    rpc: async (fn, args = {}) => { const r = await call('/api/rpc/' + fn, { method: 'POST', body: JSON.stringify(args) }); return { status: r.status, data: r.j.data, err: r.j.message }; },
    menu: () => call('/api/menu'),
    raw: call, setToken: t => { token = t; }, get token() { return token; },
  };
};

const a = phone();
let r = await a.signIn();
ok('sesión anónima nueva', r.status === 200 && r.j.token?.includes('.'));
r = await a.menu(); ok('teléfono sin activar no ve el menú', r.status === 200 && r.j.products.length === 0, JSON.stringify(r.j).slice(0, 80));
r = await a.rpc('shift_start', { p_pin: adminPin }); ok('sin activar no entra con PIN', r.status === 400 && /Dispositivo no autorizado/.test(r.err), r.err);
r = await a.rpc('device_status'); ok('device_status false', r.data === false);
r = await a.rpc('device_activate', { p_code: 'ZZZZ-ZZZZ' }); ok('código malo → false', r.data === false);
r = await a.rpc('device_activate', { p_code: code.toLowerCase().replace('-', '') }); ok('código bueno activa', r.data === true, JSON.stringify(r));
r = await a.rpc('device_status'); ok('ahora es caja', r.data === true);
r = await a.menu(); ok('ve el menú completo', r.j.categories?.length === 7 && r.j.products?.length > 20, `${r.j.categories?.length}/${r.j.products?.length}`);
r = await a.rpc('shift_start', { p_pin: '000000' }); ok('PIN malo → sin filas', Array.isArray(r.data) && r.data.length === 0, JSON.stringify(r));
r = await a.rpc('shift_start', { p_pin: adminPin });
const me = r.data?.[0]; ok('admin entra y recibe pase', me?.role === 'admin' && me.token?.startsWith('T:'), JSON.stringify(r).slice(0, 120));
const T = me.token;
ok('trae estado de caja cerrada', me.cash?.open === false);
r = await a.rpc('cash_open', { p_pin: T, p_opening_cents: 50000 }); ok('abre caja con $500', r.data?.open === true, r.err);
const prods = (await a.menu()).j.products; const chico = prods.find(p => p.short_name === 'Chico');
r = await a.rpc('register_sale', { p_pin: T, p_items: [{ product_id: chico.id, qty: 2 }], p_pay: 'cash', p_cash_cents: 10000 });
ok('cobra 2 × Chico = $70 (jsonb y filas)', r.data?.[0]?.total_cents === 7000, JSON.stringify(r));
r = await a.rpc('register_sale', { p_pin: T, p_items: [{ product_id: chico.id, qty: 0 }], p_pay: 'card' }); ok('cantidad 0 rechazada con mensaje', r.status === 400 && /Cantidad/.test(r.err), r.err);
r = await a.rpc('register_sale', { p_pin: T, p_items: [], p_pay: 'card' }); ok('orden vacía rechazada', /vacía/.test(r.err ?? ''), r.err);
const now = new Date();
r = await a.rpc('sales_report', { p_admin_pin: T, p_from: new Date(now - 864e5).toISOString(), p_to: new Date(+now + 864e5).toISOString() });
ok('informe: $70 y 1 ticket', r.data?.totals?.cents === 7000 && r.data.totals.tickets === 1, JSON.stringify(r.data?.totals));
r = await a.rpc('cash_status', { p_pin: T }); ok('cierre: esperado $570', r.data?.expected_cents === 57000 && r.data.change_cents === 3000, JSON.stringify(r.data));
r = await a.rpc('staff_upsert', { p_admin_pin: T, p_id: null, p_name: 'Ana', p_pin: '111111', p_role: 'cajero', p_active: true }); ok('crea empleada (uuid null)', typeof r.data === 'string', JSON.stringify(r));
r = await a.rpc('staff_list', { p_admin_pin: T }); ok('lista empleados (filas)', Array.isArray(r.data) && r.data.length === 2);
r = await a.rpc('support_pin_create', { p_admin_pin: T, p_hours: 24 }); ok('PIN de soporte', /^\d{6}$/.test(r.data?.pin), JSON.stringify(r));
r = await a.rpc('report_settings_get', { p_admin_pin: T }); ok('funciones inexistentes → 404', r.status === 404 && /find the function/.test(r.err), r.err);
r = await a.rpc('check_pin', { p_pin: adminPin }); ok('check_pin no se puede llamar desde la app', r.status === 404 || /permission denied/.test(r.err ?? ''), r.err);
r = await a.rpc('cash_close', { p_pin: T, p_counted_cents: 57000 }); ok('cierra caja y cuadra', r.data?.counted_cents === 57000 && r.data.expected_cents === 57000, r.err);
r = await a.rpc('cash_open', { p_pin: T, p_opening_cents: 0 }); ok('no se reabre el mismo día', /ya se abrió/.test(r.err ?? ''), r.err);

// otro teléfono (sin activar) y ataques
const b = phone(); await b.signIn();
r = await b.rpc('staff_list', { p_admin_pin: T }); ok('otro teléfono no puede usar mi pase', r.status === 400, r.err);
r = await b.rpc('sales_report', { p_admin_pin: adminPin, p_from: now.toISOString(), p_to: now.toISOString() }); ok('otro teléfono no ve informes', r.status === 400, r.err);
const evil = phone(); evil.setToken(a.token.replace(/.$/, c => (c === 'A' ? 'B' : 'A')));
r = await evil.rpc('device_status'); ok('token alterado rechazado (401)', r.status === 401);
evil.setToken('no-es-un-token'); r = await evil.menu(); ok('token basura rechazado', r.status === 401);
r = await a.rpc('shift_start', { p_pin: adminPin, p_extra: 1 }); ok('argumento desconocido rechazado', r.status === 400 && /desconocido/.test(r.err), r.err);
r = await a.rpc('shift_start; drop table sales'); ok('nombre de función con SQL rechazado', r.status === 404 || r.status === 400);
r = await a.raw('/api/rpc/shift_start', { method: 'GET' }); ok('GET en rpc rechazado', r.status === 404);
const big = await fetch(base + '/api/rpc/shift_start', { method: 'POST', headers: { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' }, body: JSON.stringify({ p_pin: 'x'.repeat(200000) }) });
ok('cuerpo gigante rechazado', big.status === 413, String(big.status));
r = await a.rpc('device_list', { p_admin_pin: T }); ok('lista de teléfonos', r.data?.length === 1 && r.data[0].this_one === true);
// bloqueo por intentos: 5 fallos
const c2 = phone(); await c2.signIn();
// activar un segundo teléfono con código creado por el dueño
const cc = (await a.rpc('device_code_create', { p_admin_pin: T, p_label: 'Caja 2' })).data?.code; ok('el dueño genera código', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(cc), cc);
await c2.rpc('device_activate', { p_code: cc });
for (let i = 0; i < 5; i++) await c2.rpc('shift_start', { p_pin: '99999' + i });
r = await c2.rpc('shift_start', { p_pin: adminPin }); ok('6.º intento bloqueado aunque el PIN sea bueno', /Demasiados intentos/.test(r.err ?? ''), r.err);
r = await a.rpc('device_remove', { p_admin_pin: T, p_user: (await a.rpc('device_list', { p_admin_pin: T })).data.find(d => !d.this_one).user_id }); ok('el dueño quita el segundo teléfono', r.status === 200);
r = await c2.rpc('device_status'); ok('teléfono quitado ya no es caja', r.data === false);
r = await a.rpc('shift_end', { p_token: T }); r = await a.rpc('cash_status', { p_pin: T }); ok('cerrar turno invalida el pase', /Turno vencido/.test(r.err ?? ''), r.err);

// archivos y cabeceras
const home = await fetch(base + '/'); ok('la app carga', home.status === 200 && /text\/html/.test(home.headers.get('content-type')));
ok('cabecera CSP sin Supabase', /connect-src 'self'/.test(home.headers.get('content-security-policy')) && !/supabase/.test(home.headers.get('content-security-policy')));
ok('/admin ya no existe', (await fetch(base + '/admin')).status === 404);
ok('/../ no sale de la carpeta', (await fetch(base + '/%2e%2e/package.json')).status === 404);
ok('push-key da una llave', ((await (await fetch(base + '/api/push-key')).json()).publicKey ?? '').length > 60);
const pk1 = (await (await fetch(base + '/api/push-key')).json()).publicKey, pk2 = (await (await fetch(base + '/api/push-key')).json()).publicKey; ok('la llave push no cambia', pk1 === pk2);

for (const [n, c, i] of results) console.log(c ? 'OK   ' : 'FALLA', n, c ? '' : '→ ' + i);
const bad = results.filter(x => !x[1]).length;
console.log(bad ? `HAY ${bad} FALLAS` : `Todo OK (${results.length} pruebas)`);
process.exit(bad ? 1 : 0);
