try { process.loadEnvFile(); } catch {}
const express = require("express"), session = require("express-session");
/* Mga email na awtomatikong nagiging admin (kapag nag-register o nag-restart ang server). Dagdag pa ang ADMIN_EMAIL sa .env (puwedeng marami, paghiwalayin ng kuwit). */
const ADMIN_EMAILS = ["novastudents@gmail.com", ...String(process.env.ADMIN_EMAIL || "").split(",")].map(e => e.trim().toLowerCase()).filter(Boolean);
const bcrypt = require("bcryptjs"), helmet = require("helmet"), rateLimit = require("express-rate-limit");
const path = require("path"), fs = require("fs"), crypto = require("crypto");

const PROD = process.env.NODE_ENV === "production";
if (PROD && (process.env.SESSION_SECRET || "").length < 24) {
  console.error("SESSION_SECRET (hindi bababa sa 24 characters) ang kailangan sa production."); process.exit(1);
}
const app = express(), PORT = process.env.PORT || 3000;
if (PROD) app.set("trust proxy", 1);

/* ---------- database: Turso (libre, permanente) o lokal na SQLite file ---------- */
const REMOTE = process.env.TURSO_DATABASE_URL;
if (PROD && !REMOTE) console.warn("BABALA: walang TURSO_DATABASE_URL. Mawawala ang data sa mga host na ephemeral ang filesystem (hal. Render Free).");
const { createClient } = require(REMOTE ? "@libsql/client/web" : "@libsql/client");
let DB_URL = REMOTE;
if (!DB_URL) { const f = process.env.DB_FILE || path.join(__dirname, "data", "nova.sqlite"); fs.mkdirSync(path.dirname(f), { recursive: true }); DB_URL = "file:" + f; }
const db = createClient({ url: DB_URL, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
const rowsOf = r => r.rows.map(x => Object.fromEntries(r.columns.map(c => [c, x[c]])));
const q = async (sql, args = [], ex = db) => rowsOf(await ex.execute({ sql, args }));
const one = async (sql, args = [], ex = db) => (await q(sql, args, ex))[0];
const run = (sql, args = [], ex = db) => ex.execute({ sql, args });
const A = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function initDb() {
  for (const [t, marker] of [["orders", "data TEXT"], ["menu", "k TEXT PRIMARY KEY"]]) { // ilipat ang lumang schema, hindi buburahin
    const r = await one("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [t]);
    if (r && !String(r.sql).includes(marker)) await run(`ALTER TABLE ${t} RENAME TO ${t}_v1`);
  }
  await db.batch([
    "CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'customer',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS menu(k TEXT PRIMARY KEY,name TEXT NOT NULL,price REAL NOT NULL CHECK(price>=0),stock INTEGER CHECK(stock IS NULL OR stock>=0),hot INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,user_id INTEGER,phone TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Bago',dkey TEXT NOT NULL,slot TEXT NOT NULL,total REAL NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS orders_phone ON orders(phone)",
    "CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY,c INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS loyalty(phone TEXT PRIMARY KEY,c INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS notify(id INTEGER PRIMARY KEY AUTOINCREMENT,k TEXT NOT NULL,item TEXT NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL,at INTEGER NOT NULL,done INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY AUTOINCREMENT,n TEXT NOT NULL,s TEXT NOT NULL,t TEXT NOT NULL,at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY,sess TEXT NOT NULL,exp INTEGER NOT NULL)"
  ], "write");
  const items = [["pandesal","Pandesal",60],["spanish","Spanish Bread",30],["cheese","Keso Bread",45],["bun","Pan de Leche",25],["monay","Monay",12],
    ["ensaymada","Ensaymada",35],["pandecoco","Pan de Coco",15],["hopia","Hopia Ube",15],["empanada","Empanada",35],["mamon","Mamon",20],
    ["brownies","Brownies",35],["eggpie","Egg Pie (hiwa)",40],["kape","Kape",25],["tsokolate","Mainit na Tsokolate",30]];
  const pk = [["box6","Pang-almusal Box",180],["box12","Pamilya Box",340],["box24","Handaan Box",640],["combo1","Pandesal + Kape",75],["combo2","Meryenda Combo",99]];
  await db.batch([...items.map(x => ({ sql: "INSERT OR IGNORE INTO menu(k,name,price,stock) VALUES(?,?,?,99)", args: x })),
    ...pk.map(x => ({ sql: "INSERT OR IGNORE INTO menu(k,name,price,stock) VALUES(?,?,?,NULL)", args: x }))], "write");
  for (const e of ADMIN_EMAILS) await run("UPDATE users SET role='admin' WHERE email=?", [e]);
}

const CFG_DEF = { shop: { cap: 10, sp: "", fb: "", ig: "", tt: "" }, pay: { num: "09054469429", name: "Nova Panaderya", qr: "" } };
const getCfg = async k => { const r = await one("SELECT value FROM config WHERE key=?", [k]); let v = {}; try { v = r ? JSON.parse(r.value) : {}; } catch {} return { ...CFG_DEF[k], ...v }; };
const setCfg = (k, v) => run("INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, JSON.stringify(v)]);

class DbStore extends session.Store { // session store sa parehong database (nananatili kahit mag-restart)
  get(sid, cb) { one("SELECT sess,exp FROM sessions WHERE sid=?", [sid]).then(r => cb(null, r && r.exp > Date.now() ? JSON.parse(r.sess) : null), cb); }
  set(sid, s, cb) { run("INSERT INTO sessions(sid,sess,exp) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,exp=excluded.exp", [sid, JSON.stringify(s), Date.now() + ((s.cookie && s.cookie.maxAge) || 864e5)]).then(() => cb && cb(), e => cb && cb(e)); }
  touch(sid, s, cb) { run("UPDATE sessions SET exp=? WHERE sid=?", [Date.now() + ((s.cookie && s.cookie.maxAge) || 864e5), sid]).then(() => cb && cb(), e => cb && cb(e)); }
  destroy(sid, cb) { run("DELETE FROM sessions WHERE sid=?", [sid]).then(() => cb && cb(), e => cb && cb(e)); }
}

/* ---------- helpers ---------- */
class HttpErr extends Error { constructor(s, m) { super(m); this.s = s; } }
const clean = s => String(s ?? "").trim();
const manila = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
const dkey = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const nextDays = () => Array.from({ length: 7 }, (_, i) => { const d = manila(); d.setDate(d.getDate() + i); return d; });
const SLOTS = []; for (let h = 6; h <= 20; h++) [0, 30].forEach(m => SLOTS.push({ m: h * 60 + m, t: (h > 12 ? h - 12 : h) + ":" + (m ? "30" : "00") + (h >= 12 ? " PM" : " AM") }));
const sid = (k, t) => k + "_" + t.replace(/[^0-9APM]/g, "");
function phone10(p) { const m = String(p || "").replace(/[\s\-().]/g, "").match(/^(?:\+?63|0)(9\d{9})$/); return m ? m[1] : null; }
const STATUSES = ["Bago", "Niluluto", "Handa na", "Tapos", "Kanselado"];
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
async function currentUser(req) { const id = req.session.user && req.session.user.id; return id ? (await one("SELECT id,name,email,role FROM users WHERE id=?", [id])) || null : null; }
const requireAdmin = A(async (req, res, next) => { const u = await currentUser(req); if (!u || u.role !== "admin") return res.status(403).json({ message: "Admin access lang ang puwede rito." }); req.user = u; next(); });
async function sendSms(to, message) {
  if (!process.env.SEMAPHORE_API_KEY) return;
  try { await fetch("https://api.semaphore.co/api/v4/messages", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ apikey: process.env.SEMAPHORE_API_KEY, number: to, message, sendername: process.env.SEMAPHORE_SENDER || "SEMAPHORE" }) }); }
  catch { console.error("Hindi naipadala ang SMS."); }
}

/* ---------- middleware ---------- */
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false })); // may inline scripts pa ang page; i-enable ang CSP kapag nailipat na ang mga ito
app.use(express.json({ limit: "100kb" }));
app.use(session({
  name: "nova.sid", store: new DbStore(),
  secret: process.env.SESSION_SECRET || "dev-only-secret-change-me", resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 864e5 }
}));
app.use("/api", (req, res, next) => { // proteksyon laban sa CSRF: same-origin + JSON lang ang mutating requests
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const o = req.get("origin");
  try { if (o && new URL(o).host !== req.get("host")) return res.status(403).json({ message: "Hindi pinapayagan ang request na ito." }); } catch { return res.status(403).json({ message: "Hindi valid ang origin." }); }
  if (!req.is("application/json")) return res.status(415).json({ message: "JSON lang ang tinatanggap." });
  next();
});
const lim = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: { message: "Masyadong maraming request. Subukan ulit mamaya." } });
const authLimiter = lim(15 * 60e3, 12), orderLimiter = lim(10 * 60e3, 15), writeLimiter = lim(10 * 60e3, 10), readLimiter = lim(60e3, 60);

/* ---------- auth ---------- */
app.get("/api/health", (req, res) => res.json({ ok: true, service: "NOVA Panaderya API" }));
app.post("/api/auth/register", authLimiter, A(async (req, res) => {
  const name = clean(req.body.name), email = clean(req.body.email).toLowerCase(), password = String(req.body.password || "");
  if (name.length < 2 || name.length > 80) return res.status(400).json({ message: "Ilagay ang pangalan (2–80 characters)." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) return res.status(400).json({ message: "Valid na email ang kailangan." });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ message: "Ang password ay dapat 8–128 characters." });
  if (await one("SELECT 1 x FROM users WHERE email=?", [email])) return res.status(409).json({ message: "May account na gamit ang email na ito." });
  const role = ADMIN_EMAILS.includes(email) ? "admin" : "customer";
  const info = await run("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)", [name, email, await bcrypt.hash(password, 12), role]);
  const user = await one("SELECT id,name,email,role FROM users WHERE id=?", [Number(info.lastInsertRowid)]);
  req.session.regenerate(err => { if (err) return res.status(500).json({ message: "Hindi makapagsimula ng session." }); req.session.user = publicUser(user); res.status(201).json({ message: "Matagumpay ang registration at naka-login ka na.", user: req.session.user }); });
}));
app.post("/api/auth/login", authLimiter, A(async (req, res) => {
  const user = await one("SELECT * FROM users WHERE email=?", [clean(req.body.email).toLowerCase()]);
  if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.password_hash))) return res.status(401).json({ message: "Mali ang email o password." });
  req.session.regenerate(err => { if (err) return res.status(500).json({ message: "Hindi makapagsimula ng session." }); req.session.user = publicUser(user); res.json({ message: "Matagumpay ang login.", user: req.session.user }); });
}));
app.get("/api/auth/me", A(async (req, res) => res.json({ user: await currentUser(req) })));
app.post("/api/auth/logout", (req, res) => req.session.destroy(() => { res.clearCookie("nova.sid"); res.json({ message: "Naka-logout ka na." }); }));

/* ---------- public: menu, slots, shop, reviews, loyalty, tracking ---------- */
app.get("/api/state", readLimiter, A(async (req, res) => {
  const slots = {}; (await q("SELECT id,c FROM slots WHERE id>=?", [dkey(manila())])).forEach(r => slots[r.id] = r.c);
  const [pay, shop, menu, reviews] = await Promise.all([getCfg("pay"), getCfg("shop"), q("SELECT k,price AS p,stock AS s,hot FROM menu"), q("SELECT n,s,t,at FROM reviews ORDER BY id DESC LIMIT 12")]);
  res.json({ menu, slots, shop, pay: { num: pay.num, name: pay.name, qr: "" }, reviews });
}));
app.get("/api/menu", readLimiter, A(async (req, res) => res.json({ items: await q("SELECT k,name,price,stock,hot FROM menu") })));
app.get("/api/loyalty/:phone", readLimiter, A(async (req, res) => {
  if (!/^9\d{9}$/.test(req.params.phone)) return res.status(400).json({ message: "Hindi valid ang numero." });
  const r = await one("SELECT c FROM loyalty WHERE phone=?", [req.params.phone]); res.json({ c: r ? r.c : 0 });
}));
app.get("/api/orders/:id/status", readLimiter, A(async (req, res) => {
  const r = await one("SELECT status FROM orders WHERE id=?", [String(req.params.id).toUpperCase().slice(0, 40)]);
  if (!r) return res.status(404).json({ message: "Walang nakitang order." }); res.json({ status: r.status });
}));
app.post("/api/reviews", writeLimiter, A(async (req, res) => {
  const n = clean(req.body.n).slice(0, 60), t = clean(req.body.t).slice(0, 300), s = clean(req.body.s);
  if (n.length < 2 || t.length < 3 || !["★★★★★", "★★★★", "★★★"].includes(s)) return res.status(400).json({ message: "Ilagay ang pangalan at review." });
  await run("INSERT INTO reviews(n,s,t,at) VALUES(?,?,?,?)", [n, s, t, Date.now()]); res.status(201).json({ message: "Salamat sa review!" });
}));
app.post("/api/notify", writeLimiter, A(async (req, res) => {
  const item = await one("SELECT k,name FROM menu WHERE k=?", [clean(req.body.k)]), name = clean(req.body.n).slice(0, 80), ph = phone10(req.body.p);
  if (!item || name.length < 2 || !ph) return res.status(400).json({ message: "Ilagay ang pangalan at valid na PH cellphone number." });
  await run("INSERT INTO notify(k,item,name,phone,at) VALUES(?,?,?,?,?)", [item.k, item.name, name, "0" + ph, Date.now()]); res.status(201).json({ message: "Sige! Ite-text ka namin." });
}));

/* ---------- orders (server ang nagkakalkula ng presyo, promo, loyalty, stock, slot) ---------- */
async function tx(fn) { // write transaction na may rollback
  const t = await db.transaction("write");
  try { const r = await fn(t); await t.commit(); return r; } catch (e) { try { await t.rollback(); } catch {} throw e; } finally { t.close(); }
}
app.post("/api/orders", orderLimiter, A(async (req, res) => {
  const b = req.body || {}, name = clean(b.name).slice(0, 80), addr = clean(b.addr).slice(0, 250), ref = clean(b.ref).slice(0, 60);
  const mode = b.mode === "Delivery" ? "Delivery" : "Pickup", ph = phone10(b.phone), code = clean(b.promo).toUpperCase().slice(0, 20), dl = mode === "Delivery";
  if (name.length < 2) throw new HttpErr(400, "Ilagay ang pangalan.");
  if (!ph) throw new HttpErr(400, "Valid na PH cellphone number ang kailangan (09XXXXXXXXX).");
  if (dl && addr.length < 5) throw new HttpErr(400, "Ilagay ang kumpletong address.");
  if (!["Cash pagdating", "GCash", "Maya"].includes(b.pay)) throw new HttpErr(400, "Hindi valid ang paraan ng bayad.");
  const days = nextDays(), di = days.findIndex(d => dkey(d) === b.dkey), slot = SLOTS.find(s => s.t === b.time);
  if (di < 0 || !slot) throw new HttpErr(400, "Hindi valid ang petsa o oras.");
  if (di === 0 && slot.m < days[0].getHours() * 60 + days[0].getMinutes() + 20) throw new HttpErr(400, "Lampas na ang oras na ito. Pumili ng ibang oras.");
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) throw new HttpErr(400, "Maglagay ng 1–30 menu items.");
  const want = new Map();
  for (const e of b.items) { const n = Number(e.q), k = clean(e.k); if (!Number.isInteger(n) || n < 1 || n > 100) throw new HttpErr(400, "Hindi valid ang quantity."); want.set(k, (want.get(k) || 0) + n); }
  const u = await currentUser(req), cfg = await getCfg("shop"), sk = sid(b.dkey, slot.t);

  const result = await tx(async t => {
    if (((await one("SELECT c FROM slots WHERE id=?", [sk], t)) || { c: 0 }).c >= cfg.cap) throw new HttpErr(409, "Puno na ang oras na ito. Pumili ng iba.");
    const rows = []; let sub = 0;
    for (const [k, n] of want) {
      const m = await one("SELECT k,name,price,stock FROM menu WHERE k=?", [k], t);
      if (!m) throw new HttpErr(400, "May item na hindi available.");
      if (m.stock !== null && m.stock < n) throw new HttpErr(409, "Kulang ang stock ng " + m.name + ".");
      rows.push({ k, n: m.name, q: n, p: m.price, stock: m.stock }); sub += m.price * n;
    }
    const lc = ((await one("SELECT c FROM loyalty WHERE phone=?", [ph], t)) || { c: 0 }).c;
    let fee = dl ? (sub >= 300 ? 0 : 40) : 0, disc = 0;
    if (code === "NOVA10") {
      if (lc > 0 || (await one("SELECT COUNT(*) n FROM orders WHERE phone=? AND status!='Kanselado'", [ph], t)).n > 0) throw new HttpErr(400, "Para sa unang order lang ang NOVA10.");
      disc = Math.round(sub * .1);
    } else if (code === "BIYERNES") {
      if (!dl) throw new HttpErr(400, "Para sa delivery lang ang BIYERNES.");
      if (new Date(b.dkey + "T00:00:00").getDay() !== 5) throw new HttpErr(400, "Valid lang ang BIYERNES tuwing Biyernes.");
      fee = 0;
    } else if (code) throw new HttpErr(400, "Hindi valid ang promo code.");
    let free = 0;
    if (lc >= 9) { const c = rows.filter(r => r.k === "bun" || r.k === "pandesal").map(r => r.p); if (c.length) free = Math.min(...c); }
    const total = Math.max(0, sub + fee - disc - free), nc = lc >= 9 ? (free ? 0 : 9) : lc + 1;
    for (const r of rows) if (r.stock !== null && !(await run("UPDATE menu SET stock=stock-? WHERE k=? AND stock>=?", [r.q, r.k, r.q], t)).rowsAffected) throw new HttpErr(409, "Kulang ang stock ng " + r.n + ".");
    await run("INSERT INTO slots(id,c) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET c=c+1", [sk], t);
    await run("INSERT INTO loyalty(phone,c) VALUES(?,?) ON CONFLICT(phone) DO UPDATE SET c=excluded.c", [ph, nc], t);
    const label = di === 0 ? "Ngayon" : di === 1 ? "Bukas" : days[di].toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" });
    const o = { id: "O" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase(), n: name, p: "0" + ph, mode, time: slot.t, day: label, dkey: b.dkey,
      addr: dl ? addr : "", pay: b.pay, ref, promo: disc || code === "BIYERNES" ? code : "", disc: disc + free, sub, fee, total, status: "Bago", at: Date.now(),
      items: rows.map(r => r.q + "× " + r.n + " (₱" + r.p * r.q + ")"), rows: rows.map(({ k, n, q, p }) => ({ k, n, q, p })) };
    await run("INSERT INTO orders(id,user_id,phone,status,dkey,slot,total,data,created_at) VALUES(?,?,?,?,?,?,?,?,?)", [o.id, u ? u.id : null, ph, o.status, o.dkey, o.time, o.total, JSON.stringify(o), o.at], t);
    return { order: o, loyalty: nc, free };
  });
  res.status(201).json({ message: "Na-save ang order.", ...result });
}));
const readOrder = r => ({ ...JSON.parse(r.data), status: r.status });
app.get("/api/orders", A(async (req, res) => {
  const u = await currentUser(req); if (!u) return res.status(401).json({ message: "Mag-login muna para magpatuloy." });
  res.json({ orders: (await q("SELECT data,status FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 30", [u.id])).map(readOrder) });
}));

/* ---------- admin ---------- */
app.get("/api/admin/orders", requireAdmin, A(async (req, res) => res.json({ orders: (await q("SELECT data,status FROM orders ORDER BY created_at DESC LIMIT 300")).map(readOrder) })));
app.get("/api/admin/orders.csv", requireAdmin, A(async (req, res) => {
  const cell = v => { v = String(v ?? ""); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }; // iwas CSV/Excel formula injection
  const lines = [["Order No.", "Petsa", "Customer", "Cellphone", "Paraan", "Iskedyul", "Address", "Items", "Diskwento", "Kabuuan", "Bayad", "Ref", "Status"].join(",")];
  (await q("SELECT data,status FROM orders ORDER BY created_at DESC")).map(readOrder).forEach(o =>
    lines.push([o.id, new Date(o.at).toISOString(), o.n, o.p, o.mode, o.day + " " + o.time, o.addr, o.items.join("; "), o.disc, o.total, o.pay, o.ref, o.status].map(cell).join(",")));
  res.type("text/csv").set("Content-Disposition", 'attachment; filename="nova-orders.csv"').send("\ufeff" + lines.join("\r\n"));
}));
app.patch("/api/admin/orders/:id", requireAdmin, A(async (req, res) => {
  const st = req.body.status; if (!STATUSES.includes(st)) return res.status(400).json({ message: "Hindi valid ang order status." });
  const r = await one("SELECT * FROM orders WHERE id=?", [req.params.id]); if (!r) return res.status(404).json({ message: "Hindi makita ang order." });
  if (r.status === "Kanselado" && st !== "Kanselado") return res.status(409).json({ message: "Hindi na maibabalik ang kanseladong order. Gumawa ng bagong order." });
  await tx(async t => {
    if (st === "Kanselado" && r.status !== "Kanselado") { // ibalik ang stock at slot
      for (const x of JSON.parse(r.data).rows) await run("UPDATE menu SET stock=stock+? WHERE k=? AND stock IS NOT NULL", [x.q, x.k], t);
      await run("UPDATE slots SET c=MAX(0,c-1) WHERE id=?", [sid(r.dkey, r.slot)], t);
    }
    await run("UPDATE orders SET status=? WHERE id=?", [st, r.id], t);
  });
  const o = JSON.parse(r.data);
  if (st === "Handa na") sendSms("0" + r.phone, `NOVA: Hi ${o.n}! Handa na ang order mo ${o.id}. Salamat!`);
  if (st === "Kanselado") sendSms("0" + r.phone, `NOVA: Kinansela ang order mo ${o.id}. Makipag-ugnayan sa tindahan para sa tanong.`);
  res.json({ message: "Na-update ang status." });
}));
app.put("/api/admin/menu", requireAdmin, A(async (req, res) => {
  const list = req.body.items; if (!Array.isArray(list) || list.length > 100) return res.status(400).json({ message: "Hindi valid ang menu data." });
  const restocked = [];
  await tx(async t => { for (const x of list) {
    const k = clean(x.k), p = Number(x.p), s = x.s === null ? null : Number(x.s), old = await one("SELECT stock FROM menu WHERE k=?", [k], t);
    if (!old) throw new HttpErr(404, "Hindi makita ang menu item.");
    if (!Number.isFinite(p) || p < 0 || (s !== null && (!Number.isInteger(s) || s < 0))) throw new HttpErr(400, "Hindi valid ang presyo o stock.");
    await run("UPDATE menu SET price=?,stock=?,hot=? WHERE k=?", [p, s, x.hot ? 1 : 0, k], t);
    if (old.stock === 0 && s > 0) restocked.push(k);
  } });
  for (const k of restocked) for (const n of await q("SELECT * FROM notify WHERE k=? AND done=0", [k])) { // awtomatikong abiso kapag may stock na ulit
    sendSms(n.phone, `NOVA: Hi ${n.name}! May ${n.item} na ulit. Order na!`); await run("UPDATE notify SET done=1 WHERE id=?", [n.id]); }
  res.json({ message: "Na-update ang menu." });
}));
app.put("/api/admin/config/:key", requireAdmin, A(async (req, res) => {
  const b = req.body, https = v => (/^https:\/\/\S{3,300}$/.test(clean(v)) ? clean(v) : "");
  if (req.params.key === "shop") {
    const sp = clean(b.sp), cap = Number(b.cap);
    if (sp && !(await one("SELECT 1 x FROM menu WHERE k=?", [sp]))) return res.status(400).json({ message: "Hindi valid ang special." });
    await setCfg("shop", { cap: Number.isInteger(cap) && cap >= 1 && cap <= 200 ? cap : 10, sp, fb: https(b.fb), ig: https(b.ig), tt: https(b.tt) });
  } else if (req.params.key === "pay") await setCfg("pay", { num: clean(b.num).slice(0, 40), name: clean(b.name).slice(0, 80), qr: "" });
  else return res.status(404).json({ message: "Hindi makita ang setting." });
  res.json({ message: "Na-save." });
}));
app.get("/api/admin/notify", requireAdmin, A(async (req, res) => res.json({ items: (await q("SELECT id,k,item,name AS n,phone AS p,at,done FROM notify ORDER BY id DESC LIMIT 100")).map(x => ({ ...x, done: !!x.done })) })));
app.patch("/api/admin/notify/:id", requireAdmin, A(async (req, res) => { await run("UPDATE notify SET done=1 WHERE id=?", [Number(req.params.id) || 0]); res.json({ message: "OK" }); }));

/* ---------- static / errors ---------- */
app.use("/api", (req, res) => res.status(404).json({ message: "Hindi makita ang API route." }));
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => {
  const s = err.s || err.status || 500; if (s >= 500) console.error(err);
  res.status(s).json({ message: s >= 500 ? "May problema sa server. Subukan ulit mamaya." : err.message });
});
initDb().then(() => {
  setInterval(() => run("DELETE FROM sessions WHERE exp<?", [Date.now()]).catch(() => {}), 36e5).unref();
  app.listen(PORT, () => console.log(`NOVA Panaderya running at http://localhost:${PORT} (${REMOTE ? "Turso" : "lokal na SQLite"})`));
}).catch(e => { console.error("Hindi makakonekta sa database:", e.message); process.exit(1); });
