// AlmaBet · servidor en Vercel. Guarda usuarios, carteras y partidos en Upstash Redis
// (Vercel > Storage > Upstash for Redis). No hace falta tocar nada aquí.
const crypto = require("crypto");

// Vale cualquier prefijo que ponga Vercel al conectar la base de datos (KV_, STORAGE_, UPSTASH_REDIS_...)
const envKey = suf => process.env["KV" + suf] ? "KV" + suf : Object.keys(process.env).find(k => k.endsWith(suf) && !k.includes("READ_ONLY"));
const URL_ = process.env[envKey("_REST_API_URL")] || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env[envKey("_REST_API_TOKEN")] || process.env.UPSTASH_REDIS_REST_TOKEN;
const START = 1000;

// Todas las claves llevan "ab:" delante, por si la base de datos se comparte con otra app.
const P = "ab:";
async function redis(...cmd) {
  if (cmd.length > 1) cmd[1] = P + cmd[1];
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const getJ = async k => { const v = await redis("GET", k); return v ? JSON.parse(v) : null; };
const setJ = (k, v) => redis("SET", k, JSON.stringify(v));
const norm = u => String(u || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9._-]/g, "");
const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");

async function newSession(name) {
  const t = crypto.randomBytes(24).toString("hex");
  await redis("SET", "sess:" + t, name, "EX", 60 * 60 * 24 * 180);
  return t;
}
async function whoami(req) {
  const t = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!t) return null;
  const name = await redis("GET", "sess:" + t);
  if (!name) return null;
  const u = await getJ("user:" + name);
  return u ? { name, ...u } : null;
}
async function profit(w) {
  const done = (w.bets || []).filter(b => b.status === "won" || b.status === "lost");
  return +(done.reduce((s, b) => s + (b.ret || 0), 0) - done.reduce((s, b) => s + (+b.stake || 0), 0)).toFixed(2);
}
async function allMatches() {
  const h = await redis("HGETALL", "matches") || [];
  const o = {}; for (let i = 0; i < h.length; i += 2) o[h[i]] = JSON.parse(h[i + 1]);
  return o;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const send = (code, obj) => res.status(code).json(obj);
  if (!URL_ || !TOKEN) return send(500, { error: "Falta conectar la base de datos: en Vercel ve a Storage > Upstash for Redis > Connect y vuelve a desplegar." });
  try {
    let b = req.body || {};
    if (typeof b === "string") b = JSON.parse(b || "{}");
    const a = b.action;

    if (a === "register" || a === "login") {
      const name = norm(b.username), pw = String(b.password || "");
      if (name.length < 2 || name.length > 20 || pw.length < 6) return send(400, { error: "El usuario necesita 2 a 20 letras y la contraseña 6 caracteres o más." });
      if (a === "register") {
        const salt = crypto.randomBytes(16).toString("hex");
        const ok = await redis("SET", "user:" + name, JSON.stringify({ salt, hash: hash(pw, salt), admin: false, created: Date.now() }), "NX");
        if (!ok) return send(409, { error: "Ese usuario ya existe. Prueba a entrar." });
        // El primero que se registra es el administrador (o el que diga ADMIN_USER en Vercel)
        const first = (await redis("SADD", "users", name)) && (await redis("SCARD", "users")) === 1;
        if (first || norm(process.env.ADMIN_USER) === name) { const u = await getJ("user:" + name); u.admin = true; await setJ("user:" + name, u); }
        await setJ("wallet:" + name, { balance: START, bets: [] });
      } else {
        const u = await getJ("user:" + name);
        if (!u || hash(pw, u.salt) !== u.hash) return send(401, { error: "Usuario o contraseña incorrectos." });
      }
      return send(200, { token: await newSession(name) });
    }

    const me = await whoami(req);
    if (!me) return send(401, { error: "Sesión caducada. Vuelve a entrar." });
    const admin = me.admin || norm(process.env.ADMIN_USER) === me.name;

    if (a === "me") {
      const w = (await getJ("wallet:" + me.name)) || { balance: START, bets: [] };
      return send(200, { username: me.name, admin, wallet: w, matches: await allMatches() });
    }
    if (a === "matches") {
      const bonus = ((await redis("LRANGE", "bonus:" + me.name, 0, -1)) || []).map(x => JSON.parse(x));
      return send(200, { matches: await allMatches(), bonus });
    }
    if (a === "ackBonus") { const ids = new Set(b.ids || []);
      const list = (await redis("LRANGE", "bonus:" + me.name, 0, -1)) || [];
      for (const x of list) if (ids.has(JSON.parse(x).id)) await redis("LREM", "bonus:" + me.name, 1, x);
      return send(200, { ok: true }); }
    if (a === "adjust") {
      if (!admin) return send(403, { error: "Solo el administrador puede dar o quitar dinero." });
      const to = norm(b.user), amt = Math.round(+b.amount * 100) / 100;
      if (!to || !(await getJ("user:" + to))) return send(404, { error: "Ese jugador no existe." });
      if (!isFinite(amt) || !amt || Math.abs(amt) > 1e6) return send(400, { error: "Cantidad no válida." });
      await redis("RPUSH", "bonus:" + to, JSON.stringify({ id: crypto.randomBytes(8).toString("hex"), amount: amt, note: String(b.note || "").slice(0, 60), at: Date.now() }));
      return send(200, { ok: true });
    }
    if (a === "wallet") {
      const w = { balance: +b.balance, bets: Array.isArray(b.bets) ? b.bets : [], bonusIds: Array.isArray(b.bonusIds) ? b.bonusIds.slice(-200) : [], moves: Array.isArray(b.moves) ? b.moves.slice(0, 50) : [] };
      if (!isFinite(w.balance)) return send(400, { error: "Saldo no válido." });
      await setJ("wallet:" + me.name, w);
      return send(200, { ok: true });
    }
    if (a === "ranking") {
      const names = (await redis("SMEMBERS", "users")) || [];
      const adminU = norm(process.env.ADMIN_USER);
      const players = [];
      for (const n of names) { const u = await getJ("user:" + n); if (u && !u.admin && n !== adminU) players.push(n); }
      const rows = await Promise.all(players.map(async n => { const w = (await getJ("wallet:" + n)) || { balance: START, bets: [] };
        const pend = ((await redis("LRANGE", "bonus:" + n, 0, -1)) || []).reduce((t, x) => t + JSON.parse(x).amount, 0);
        return { id: n, username: n, balance: Math.max(0, +w.balance + pend), profit: await profit(w), bets: (w.bets || []).length }; }));
      rows.sort((x, y) => y.balance - x.balance);
      return send(200, { ranking: rows });
    }
    if (a === "saveMatch" || a === "deleteMatch") {
      if (!admin) return send(403, { error: "Solo el administrador puede cambiar los partidos." });
      if (!b.id) return send(400, { error: "Falta el partido." });
      if (a === "saveMatch") await redis("HSET", "matches", String(b.id), JSON.stringify(b.state));
      else await redis("HDEL", "matches", String(b.id));
      return send(200, { ok: true });
    }
    if (a === "logout") { await redis("DEL", "sess:" + (req.headers.authorization || "").replace(/^Bearer\s+/i, "")); return send(200, { ok: true }); }
    return send(400, { error: "Acción desconocida." });
  } catch (e) {
    return send(500, { error: "Error del servidor: " + e.message });
  }
};
