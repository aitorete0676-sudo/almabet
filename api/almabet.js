// AlmaBet · servidor en Vercel. Guarda usuarios, carteras y partidos en Upstash Redis
// (Vercel > Storage > Upstash for Redis). No hace falta tocar nada aquí.
const crypto = require("crypto");
const { buildGroup, upcomingGroup, getJSON } = require("../lib/ffcv.js");

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
  members: "lgm:" + lg });
// Competiciones (grupos de fútbol): "main" = Tercera FFCV G2 (datos dentro de la app). Todas las ligas de amigos apuestan en todas.
const MAIN_GROUP = "905431622";
const CM = c => c === MAIN ? "matches" : "mc:" + c;
async function listComps() {
  if (await redis("SET", "compmig", "1", "NX")) {   // ligas creadas antes con un grupo: su grupo pasa a ser competición
    for (const id of ((await redis("SMEMBERS", "lgall")) || [])) { const l = await getJ("lg:" + id);
      if (l && l.groupId && l.groupId !== MAIN_GROUP && !(await getJ("comp:" + l.groupId))) { await setJ("comp:" + l.groupId, { id: l.groupId, name: l.name, team: l.team, full: [] }); await redis("SADD", "comps", l.groupId); } }
  }
  if (await redis("SET", "compseed1", "1", "NX")) {   // Segona FFCV G1 (Almazora B): mercados completos solo para el Almazora B
    await setJ("comp:905431612", { id: "905431612", name: "Segona FFCV · Grupo 1", team: "C.D. Almazora 'B'", full: ["C.D. Almazora 'B'"], created: Date.now() }); await redis("SADD", "comps", "905431612");
  }
  if (await redis("SET", "compseed2", "1", "NX")) {   // Primera FFCV G1 y Lliga Comunitat Grup Nord (Almazora A): solo mercados de actas
    await setJ("comp:905431607", { id: "905431607", name: "Primera FFCV · Grupo 1", team: "", full: [], created: Date.now() });
    await setJ("comp:905431822", { id: "905431822", name: "Lliga Comunitat · Grup Nord", team: "C.D. Almazora 'A'", full: [], created: Date.now() });
    await redis("SADD", "comps", "905431607", "905431822");
  }
  const out = [{ id: MAIN, name: "Tercera FFCV · Grupo 2", team: "C.D. Almazora 'C'" }];
  for (const id of ((await redis("SMEMBERS", "comps")) || []).sort()) { const c = await getJ("comp:" + id); if (c) out.push({ id, name: c.name, team: c.team, full: c.full || [] }); }
  return out;
}
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
async function allMatches() {   // estados de todos los partidos de todas las competiciones (se ven en la misma página)
  const o = {};
  for (const c of [MAIN].concat((await redis("SMEMBERS", "comps")) || [])) {
    const h = await redis("HGETALL", CM(c)) || [];
    for (let i = 0; i < h.length; i += 2) o[h[i]] = JSON.parse(h[i + 1]);
  }
  return o;
}
async function compData(comp, refresh) {
  const ck = "lgdata3:" + comp; let d = await getJ(ck);
  const stale = !d || Date.now() - d.updated > 6 * 3600e3 || d.pendingActas > 0 || refresh;
  if (stale) { try { d = await buildGroup({ groupId: comp, getJ, setJ, maxActas: 12 }); await setJ(ck, d); } catch (e) { if (!d) throw e; } }
  return d;
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
    let comp = String(b.comp || MAIN).replace(/[^a-z0-9]/gi, "").slice(0, 20) || MAIN;
    if (comp !== MAIN && !(await redis("SISMEMBER", "comps", comp))) comp = MAIN;
    if (L && lg !== MAIN && a === "me") await redis("SADD", "lgall", lg);   // ligas creadas antes de existir la lista
    const realMember = !!L && !!(await redis("SISMEMBER", KK.members, me.name));
    const member = realMember || (!!L && superAdmin);   // el admin de la liga original gestiona todas las ligas
    const admin = member && superAdmin;   // solo el admin de la liga original administra (en todas las ligas)
    async function myLeagues() {
      const ids = superAdmin ? ((await redis("SMEMBERS", "lgall")) || []) : ((await redis("SMEMBERS", "ul:" + me.name)) || []);
      if (await redis("SISMEMBER", "lgm:" + MAIN, me.name)) ids.unshift(MAIN);
      const out = [];
      for (const id of [...new Set(ids)]) { const l = await getJ("lg:" + id); if (l) out.push({ id, name: l.name, code: l.code, admin: superAdmin }); }
      return out;
    }
    // --- Ligas: crear, unirse, ver las mías, datos del grupo ---
    if (a === "leagues") return send(200, { leagues: await myLeagues() });
    if (a === "comps") return send(200, { comps: await listComps() });
    if (a === "groupTeams" || a === "addComp") {   // solo el admin de AlmaBet añade competiciones (él mete los resultados)
      if (!superAdmin) return send(403, { error: "Solo el administrador de AlmaBet puede añadir competiciones." });
      const gid = (String(b.group || "").match(/grupo\/(\d+)/) || String(b.group || "").match(/^\s*(\d{5,})\s*$/) || [])[1];
      if (!gid) return send(400, { error: "Pega el enlace del grupo de El Balón de la Comunitat (el que acaba en /grupo/número)." });
      if (gid === MAIN_GROUP) return send(400, { error: "Esa competición ya está." });
      let st; try { st = await getJSON("/api/ffcv/standings?idGroup=" + gid + "&round=99"); } catch (e) { return send(502, { error: "No se ha podido leer ese grupo. Revisa el enlace." }); }
      const teams = (st.clasificacion || []).map(e => String(e.nombre).replace(/&#x27;/g, "'"));
      if (!teams.length) return send(404, { error: "Ese grupo no tiene clasificación todavía." });
      const liga = (String(st.competicion || "").trim() || "Liga") + (st.grupo ? " · " + String(st.grupo).replace(/^Grup\s*-\s*/i, "Grupo ") : "");
      if (a === "groupTeams") return send(200, { groupId: gid, liga, teams });
      const team = teams.find(t => t === b.team) || teams[0];
      const full = (Array.isArray(b.full) ? b.full : [team]).filter(t => teams.includes(t));
      await setJ("comp:" + gid, { id: gid, name: String(b.name || "").trim().slice(0, 40) || liga, team, full, created: Date.now() });
      await redis("SADD", "comps", gid);
      return send(200, { id: gid, comps: await listComps() });
    }
    if (a === "compsData") {   // todas las competiciones extra (la Tercera G2 va dentro de la app)
      await listComps();
      const ORDER = ["905431612", "905431607", "905431822"];   // Segona, Primera, Lliga Comunitat; las demás detrás
      const ids = ((await redis("SMEMBERS", "comps")) || []).sort((x, y) => ((ORDER.indexOf(x) + 1) || 99) - ((ORDER.indexOf(y) + 1) || 99) || x.localeCompare(y));
      const out = await Promise.all(ids.map(async id => { const C = await getJ("comp:" + id); if (!C) return null;
        try { return { comp: { id, name: C.name, team: C.team || "", full: C.full || [] }, data: await compData(id, b.refresh && superAdmin) }; } catch (e) { return null; } }));
      let main = await getJ("lgnext:" + MAIN_GROUP);   // calendario de las próximas jornadas de la Tercera G2
      if (!main || Date.now() - main.updated > 6 * 3600e3 || (b.refresh && superAdmin)) { try { main = await upcomingGroup(MAIN_GROUP); await setJ("lgnext:" + MAIN_GROUP, main); } catch (e) {} }
      return send(200, { comps: out.filter(Boolean), main: main || null });
    }
    if (a === "createLeague") {   // liga de amigos: solo nombre; se apuesta en todas las competiciones
      const name = String(b.name || "").trim().slice(0, 40);
      if (name.length < 2) return send(400, { error: "Ponle un nombre a la liga." });
      const mine = (await redis("INCR", "lgcount:" + me.name)); if (mine > 5 && !superAdmin) return send(429, { error: "Ya has creado 5 ligas." });
      const id = crypto.randomBytes(5).toString("hex"), code = await newCode(id);
      await setJ("lg:" + id, { id, name, code, owner: me.name, created: Date.now() });
      await redis("SADD", "lgall", id);
      if (!superAdmin) { await redis("SADD", "lgm:" + id, me.name); await redis("SADD", "ul:" + me.name, id); await setJ(K(id).wallet(me.name), { balance: START, bets: [] }); }
      return send(200, { id, code, leagues: await myLeagues() });
    }
    if (a === "deleteLeague") {   // solo el admin de AlmaBet; la liga original no se puede borrar
      if (!superAdmin) return send(403, { error: "Solo el administrador de AlmaBet puede eliminar ligas." });
      const id = String(b.id || "").replace(/[^a-z0-9]/gi, ""); if (!id || id === MAIN) return send(400, { error: "Esa liga no se puede eliminar." });
      const D = await getJ("lg:" + id); if (!D) return send(404, { error: "Esa liga ya no existe." });
      for (const u of ((await redis("SMEMBERS", "lgm:" + id)) || [])) { await redis("SREM", "ul:" + u, id); await redis("DEL", K(id).wallet(u)); await redis("DEL", K(id).bonus(u)); }
      await redis("DEL", "lgm:" + id); await redis("DEL", "lgban:" + id); if (D.code) await redis("DEL", "lgcode:" + D.code);
      await redis("SREM", "lgall", id); await redis("DEL", "lg:" + id);
      return send(200, { ok: true, leagues: await myLeagues() });
    }
    if (a === "joinLeague") {
      const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const id = code && await redis("GET", "lgcode:" + code);
      if (!id) return send(404, { error: "Ese código no existe. Revísalo." });
      if (await redis("SISMEMBER", "lgban:" + id, me.name)) return send(403, { error: "Te han sacado de esta liga." });
      const already = await redis("SISMEMBER", "lgm:" + id, me.name);
      await redis("SADD", "lgm:" + id, me.name); if (id !== MAIN) await redis("SADD", "ul:" + me.name, id);
      if (!already && !(await getJ(K(id).wallet(me.name)))) await setJ(K(id).wallet(me.name), { balance: START, bets: [] });
      return send(200, { id, leagues: await myLeagues() });
    }
    if (!member) {
      if (a === "me") return send(200, { username: me.name, admin: false, noLeague: true, leagues: await myLeagues(), comps: await listComps() });
      return send(403, { error: "No estás en esta liga." });
    }

    if (a === "me") {
      const w = (await getJ(KK.wallet(me.name))) || { balance: START, bets: [] };
      return send(200, { username: me.name, admin, super: superAdmin && !realMember, owner: lg !== MAIN && L.owner === me.name, wallet: w, matches: await allMatches(), leagues: await myLeagues(), comps: await listComps(), comp, league: { id: lg, name: L.name, code: L.code } });
    }
    if (a === "matches") {
      const bonus = ((await redis("LRANGE", KK.bonus(me.name), 0, -1)) || []).map(x => JSON.parse(x));
      return send(200, { matches: await allMatches(), bonus });
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
      if (a === "saveMatch") await redis("HSET", CM(comp), String(b.id), JSON.stringify(b.state));
      else await redis("HDEL", CM(comp), String(b.id));
      return send(200, { ok: true });
    }
    if (a === "kickMember") {   // el creador de la liga (o el admin de AlmaBet) puede sacar a gente
      if (!(superAdmin || (lg !== MAIN && L.owner === me.name))) return send(403, { error: "Solo el creador de la liga puede sacar a gente." });
      const u = norm(b.user); if (!u || u === me.name) return send(400, { error: "No puedes sacarte a ti mismo." });
      await redis("SREM", KK.members, u); await redis("SREM", "ul:" + u, lg); await redis("SADD", "lgban:" + lg, u);
      return send(200, { ok: true });
    }
    if (a === "logout") { await redis("DEL", "sess:" + (req.headers.authorization || "").replace(/^Bearer\s+/i, "")); return send(200, { ok: true }); }
    return send(400, { error: "Acción desconocida." });
  } catch (e) {
    return send(500, { error: "Error del servidor: " + e.message });
  }
};
