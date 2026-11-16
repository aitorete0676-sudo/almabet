// AlmaBet · servidor en Vercel. Guarda usuarios, carteras y partidos en Upstash Redis
// (Vercel > Storage > Upstash for Redis). No hace falta tocar nada aquí.
const crypto = require("crypto");
const { buildGroup, getJSON } = require("../lib/ffcv.js");

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
const ymMadrid = t => { const d = new Date(new Date(t).toLocaleString("en-US", { timeZone: "Europe/Madrid" })); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
const betJ = b => b.j || (+(String(((b.legs || [])[0] || {}).mid || "").match(/^j(\d+)-/) || [])[1] || 0);
function periods(w) {
  const done = (w.bets || []).filter(b => ["won", "lost", "cashout"].includes(b.status)), cur = ymMadrid(Date.now());
  const pj = {}, nj = {}; let pm = 0, nm = 0;
  done.forEach(b => { const pl = (b.ret || 0) - (+b.stake || 0), j = betJ(b);
    if (j) { pj[j] = +((pj[j] || 0) + pl).toFixed(2); nj[j] = (nj[j] || 0) + 1; }
    if (ymMadrid(b.closedAt || b.at) === cur) { pm += pl; nm++; } });
  (w.bets || []).filter(b => b.status === "pending").forEach(b => { const j = betJ(b); if (j) nj[j] = (nj[j] || 0) + 1; });
  return { pj, nj, pm: +pm.toFixed(2), nm, month: cur };
}
async function profit(w) {
  const done = (w.bets || []).filter(b => ["won", "lost", "cashout"].includes(b.status));
  return +(done.reduce((s, b) => s + (b.ret || 0), 0) - done.reduce((s, b) => s + (+b.stake || 0), 0)).toFixed(2);
}
// Ligas: "main" es la liga original (sus claves no cambian). Las demás guardan todo con su id.
const MAIN = "main";
const K = lg => ({ wallet: u => lg === MAIN ? "wallet:" + u : "w:" + lg + ":" + u, bonus: u => lg === MAIN ? "bonus:" + u : "bn:" + lg + ":" + u,
  matches: lg === MAIN ? "matches" : "m:" + lg, members: "lgm:" + lg });
const CODE_CH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
async function newCode(id) { for (let n = 0; n < 20; n++) { let c = ""; for (let i = 0; i < 6; i++) c += CODE_CH[crypto.randomInt(CODE_CH.length)];
  if (await redis("SET", "lgcode:" + c, id, "NX")) return c; } throw new Error("No se ha podido crear el código."); }
// La primera vez: la liga original pasa a ser privada con código y todos los que ya tenían cuenta siguen dentro
async function ensureMain() {
  if (await redis("EXISTS", "lg:" + MAIN)) return;
  if (!(await redis("SET", "lgmig", "1", "NX", "EX", 60))) return;
  const users = (await redis("SMEMBERS", "users")) || [];
  if (users.length) await redis("SADD", "lgm:" + MAIN, ...users);
  const code = await newCode(MAIN);
  await setJ("lg:" + MAIN, { id: MAIN, name: "Almazora C · Tercera FFCV G2", code, groupId: "905431622", team: "C.D. Almazora 'C'", owner: null, created: Date.now() });
}
async function allMatches(lg = MAIN) {
  const h = await redis("HGETALL", K(lg).matches) || [];
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
    await ensureMain();

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
    const superAdmin = me.admin || norm(process.env.ADMIN_USER) === me.name;
    const lg = String(b.lg || MAIN).replace(/[^a-z0-9]/gi, "").slice(0, 20) || MAIN, KK = K(lg);
    const L = await getJ("lg:" + lg);
    if (L && lg !== MAIN && a === "me") await redis("SADD", "lgall", lg);   // ligas creadas antes de existir la lista
    const realMember = !!L && !!(await redis("SISMEMBER", KK.members, me.name));
    const member = realMember || (!!L && superAdmin);   // el admin de la liga original gestiona todas las ligas
    const admin = member && (superAdmin || L.owner === me.name);
    async function myLeagues() {
      const ids = superAdmin ? ((await redis("SMEMBERS", "lgall")) || []) : ((await redis("SMEMBERS", "ul:" + me.name)) || []);
      if (await redis("SISMEMBER", "lgm:" + MAIN, me.name)) ids.unshift(MAIN);
      const out = [];
      for (const id of [...new Set(ids)]) { const l = await getJ("lg:" + id); if (l) out.push({ id, name: l.name, code: l.code, team: l.team, groupId: l.groupId, admin: superAdmin || l.owner === me.name }); }
      return out;
    }
    // --- Ligas: crear, unirse, ver las mías, datos del grupo ---
    if (a === "leagues") return send(200, { leagues: await myLeagues() });
    if (a === "groupTeams" || a === "createLeague") {
      const gid = (String(b.group || "").match(/grupo\/(\d+)/) || String(b.group || "").match(/^\s*(\d{5,})\s*$/) || [])[1];
      if (!gid) return send(400, { error: "Pega el enlace del grupo de El Balón de la Comunitat (el que acaba en /grupo/número)." });
      let st; try { st = await getJSON("/api/ffcv/standings?idGroup=" + gid + "&round=99"); } catch (e) { return send(502, { error: "No se ha podido leer ese grupo. Revisa el enlace." }); }
      const teams = (st.clasificacion || []).map(e => String(e.nombre).replace(/&#x27;/g, "'"));
      if (!teams.length) return send(404, { error: "Ese grupo no tiene clasificación todavía." });
      const liga = (st.competicion || "Liga") + (st.grupo ? " · " + String(st.grupo).replace(/^Grup\s*-\s*/i, "Grupo ") : "");
      if (a === "groupTeams") return send(200, { groupId: gid, liga, teams });
      const team = teams.find(t => t === b.team); if (!team) return send(400, { error: "Elige tu equipo de la lista." });
      const mine = (await redis("INCR", "lgcount:" + me.name)); if (mine > 5) return send(429, { error: "Ya has creado 5 ligas." });
      const id = crypto.randomBytes(5).toString("hex"), code = await newCode(id);
      const name = String(b.name || "").trim().slice(0, 40) || team + " · " + liga;
      await setJ("lg:" + id, { id, name, code, groupId: gid, team, owner: me.name, created: Date.now() });
      await redis("SADD", "lgm:" + id, me.name); await redis("SADD", "ul:" + me.name, id); await redis("SADD", "lgall", id);
      await setJ(K(id).wallet(me.name), { balance: START, bets: [] });
      return send(200, { id, code, leagues: await myLeagues() });
    }
    if (a === "joinLeague") {
      const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const id = code && await redis("GET", "lgcode:" + code);
      if (!id) return send(404, { error: "Ese código no existe. Revísalo." });
      const already = await redis("SISMEMBER", "lgm:" + id, me.name);
      await redis("SADD", "lgm:" + id, me.name); if (id !== MAIN) await redis("SADD", "ul:" + me.name, id);
      if (!already && !(await getJ(K(id).wallet(me.name)))) await setJ(K(id).wallet(me.name), { balance: START, bets: [] });
      return send(200, { id, leagues: await myLeagues() });
    }
    if (!member) {
      if (a === "me") return send(200, { username: me.name, admin: false, noLeague: true, leagues: await myLeagues() });
      return send(403, { error: "No estás en esta liga." });
    }
    if (a === "leagueData") {
      if (lg === MAIN) return send(200, { main: true });
      const ck = "lgdata:" + L.groupId; let d = await getJ(ck);
      const stale = !d || Date.now() - d.updated > 6 * 3600e3 || d.pendingActas > 0 || (b.refresh && admin);
      if (stale) { try { d = await buildGroup({ groupId: L.groupId, getJ, setJ, maxActas: 12 }); await setJ(ck, d); } catch (e) { if (!d) return send(502, { error: "No se han podido leer los datos del grupo: " + e.message }); } }
      return send(200, { data: d, league: { id: lg, name: L.name, team: L.team, code: L.code } });
    }

    if (a === "me") {
      const w = (await getJ(KK.wallet(me.name))) || { balance: START, bets: [] };
      return send(200, { username: me.name, admin, super: superAdmin && !realMember, wallet: w, matches: await allMatches(lg), leagues: await myLeagues(), league: { id: lg, name: L.name, code: L.code, team: L.team } });
    }
    if (a === "matches") {
      const bonus = ((await redis("LRANGE", KK.bonus(me.name), 0, -1)) || []).map(x => JSON.parse(x));
      return send(200, { matches: await allMatches(lg), bonus });
    }
    if (a === "ackBonus") { const ids = new Set(b.ids || []);
      const list = (await redis("LRANGE", KK.bonus(me.name), 0, -1)) || [];
      for (const x of list) if (ids.has(JSON.parse(x).id)) await redis("LREM", KK.bonus(me.name), 1, x);
      return send(200, { ok: true }); }
    if (a === "adjust") {
      if (!admin) return send(403, { error: "Solo el administrador puede dar o quitar dinero." });
      const to = norm(b.user), amt = Math.round(+b.amount * 100) / 100;
      if (!to || !(await redis("SISMEMBER", KK.members, to))) return send(404, { error: "Ese jugador no está en la liga." });
      if (!isFinite(amt) || !amt || Math.abs(amt) > 1e6) return send(400, { error: "Cantidad no válida." });
      await redis("RPUSH", KK.bonus(to), JSON.stringify({ id: crypto.randomBytes(8).toString("hex"), amount: amt, note: String(b.note || "").slice(0, 60), at: Date.now() }));
      return send(200, { ok: true });
    }
    if (a === "wallet") {
      if (!realMember) return send(403, { error: "Gestionas esta liga, pero no juegas en ella." });
      const w = { balance: +b.balance, bets: Array.isArray(b.bets) ? b.bets : [], bonusIds: Array.isArray(b.bonusIds) ? b.bonusIds.slice(-200) : [], moves: Array.isArray(b.moves) ? b.moves.slice(0, 50) : [], lastPay: String(b.lastPay || "").slice(0, 7) };
      if (!isFinite(w.balance)) return send(400, { error: "Saldo no válido." });
      await setJ(KK.wallet(me.name), w);
      return send(200, { ok: true });
    }
    if (a === "playerBets") {
      if (!admin || (lg !== MAIN && !superAdmin)) return send(403, { error: "Solo el administrador de la liga original puede ver las apuestas de otros." });
      if (!(await redis("SISMEMBER", KK.members, norm(b.user)))) return send(404, { error: "Ese jugador no está en la liga." });
      const w = (await getJ(KK.wallet(norm(b.user)))) || { bets: [] };
      return send(200, { bets: (w.bets || []).slice(-150) });
    }
    if (a === "ranking") {
      const names = (await redis("SMEMBERS", KK.members)) || [];
      const adminU = norm(process.env.ADMIN_USER);
      const players = [];
      for (const n of names) { if (lg !== MAIN) { players.push(n); continue; } const u = await getJ("user:" + n); if (u && !u.admin && n !== adminU) players.push(n); }
      const rows = await Promise.all(players.map(async n => { const w = (await getJ(KK.wallet(n))) || { balance: START, bets: [] };
        const pend = ((await redis("LRANGE", KK.bonus(n), 0, -1)) || []).reduce((t, x) => t + JSON.parse(x).amount, 0);
        return { id: n, username: n, balance: Math.max(0, +w.balance + pend), profit: await profit(w), bets: (w.bets || []).length, ...periods(w) }; }));
      rows.sort((x, y) => y.balance - x.balance);
      return send(200, { ranking: rows });
    }
    if (a === "saveMatch" || a === "deleteMatch") {
      if (!admin) return send(403, { error: "Solo el administrador puede cambiar los partidos." });
      if (!b.id) return send(400, { error: "Falta el partido." });
      if (a === "saveMatch") await redis("HSET", KK.matches, String(b.id), JSON.stringify(b.state));
      else await redis("HDEL", KK.matches, String(b.id));
      return send(200, { ok: true });
    }
    if (a === "logout") { await redis("DEL", "sess:" + (req.headers.authorization || "").replace(/^Bearer\s+/i, "")); return send(200, { ok: true }); }
    return send(400, { error: "Acción desconocida." });
  } catch (e) {
    return send(500, { error: "Error del servidor: " + e.message });
  }
};
