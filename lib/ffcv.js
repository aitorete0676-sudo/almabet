// Lee los datos de un grupo de la FFCV desde elbalondelacomunitat.es y los deja en el formato que usa la app.
// Las actas ya leídas se guardan para siempre (no cambian), así cada actualización solo descarga lo nuevo.
const SRC = "https://www.elbalondelacomunitat.es";
const UA = { "User-Agent": "Mozilla/5.0 (AlmaBet; liga entre amigos)" };
async function getJSON(path) { const r = await fetch(SRC + path, { headers: UA }); if (!r.ok) throw new Error("La web de actas respondió " + r.status); return r.json(); }
const dec = s => String(s || "").replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, " ").trim();
const title = s => dec(s).toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

// --- Acta (HTML) ---
function sectionBody(html, h2) {   // trozo de la sección cuyo <h2> es h2, hasta la siguiente sección
  const i = html.search(new RegExp("<h2[^>]*>(?:(?!</h2>)[\\s\\S]){0,3000}?" + h2 + "\\s*</h2>")); if (i < 0) return null;
  const j = html.indexOf("</section>", i); return html.slice(i, j < 0 ? undefined : j);
}
function twoLists(body) {   // primera <ul> = local, segunda = visitante
  if (!body) return [[], []];
  const g = body.indexOf("md:grid-cols-2"); const part = g >= 0 ? body.slice(g) : body;
  const cols = []; const re = /<ul[^>]*>([\s\S]*?)<\/ul>|<p class="text-xs text-ink-soft">—<\/p>/g; let m;
  while ((m = re.exec(part)) && cols.length < 2) cols.push(m[1] || "");
  while (cols.length < 2) cols.push("");
  return cols.map(c => c.split(/<li[ >]/).slice(1));
}
const minOf = li => { const m = /<span class="w-9[^"]*">(\d+)/.exec(li); return m ? +m[1] : null; };
const pidOf = s => { const m = /href="\/jugador\/(\d+)\//.exec(s); return m ? m[1] : null; };
function parseActa(html) {
  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html); let home = null, away = null;
  if (ld) { try { const j = JSON.parse(ld[1]); const ev = Array.isArray(j) ? j.find(x => x["@type"] === "SportsEvent") : j; home = ev && ev.homeTeam && ev.homeTeam.name; away = ev && ev.awayTeam && ev.awayTeam.name; } catch (e) {} }
  const sc = /<span class="text-3xl font-bold tabular-nums[^"]*">([\s\S]*?)<\/span>/.exec(html);
  let score = null; if (sc) { const t = dec(sc[1]).split(/[–-]/).map(x => parseInt(x)); if (t.length === 2 && t.every(n => !isNaN(n))) score = t; }
  // Alineaciones
  const lineups = [];
  const lu = html.split('<div class="frame bg-card p-5">').slice(1, 3);
  lu.forEach(blk => {
    const part = (label) => { const i = blk.indexOf(">" + label + "</p>"); if (i < 0) return []; const u = blk.indexOf("<ul", i), e = blk.indexOf("</ul>", u); return blk.slice(u, e).split(/<li[ >]/).slice(1); };
    const pl = li => { const d = /<span class="w-7[^"]*">(\d*)<\/span>/.exec(li), a = /<a [^>]*href="\/jugador\/(\d+)\/[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(li);
      return a ? { id: a[1], nombre: title(a[2]), dorsal: d && d[1] ? +d[1] : null, gk: />GK</.test(li) } : null; };
    lineups.push({ tit: part("Titulares").map(pl).filter(Boolean), sup: part("Suplentes").map(pl).filter(Boolean) });
  });
  const goals = [], cards = [], subs = [];
  twoLists(sectionBody(html, "Goles")).forEach((lis, s) => lis.forEach(li => { const id = pidOf(li); if (id) goals.push({ s, id, min: minOf(li), n: /\(gol\)/.test(dec(li.replace(/<[^>]+>/g, ""))) ? 1 : 0 }); }));
  twoLists(sectionBody(html, "Tarjetas")).forEach((lis, s) => lis.forEach(li => { const id = pidOf(li); if (!id) return;
    const red = /aria-label="roja"/.test(li), y2 = /aria-label="2ª amarilla"/.test(li);
    cards.push({ s, id, min: minOf(li), t: y2 ? "y2" : red ? "red" : "yel" }); }));
  twoLists(sectionBody(html, "Sustituciones")).forEach((lis, s) => lis.forEach(li => { const ids = [...li.matchAll(/href="\/jugador\/(\d+)\//g)].map(m => m[1]);
    if (ids.length >= 2) subs.push({ s, out: ids[0], in: ids[1], min: minOf(li) }); }));
  return { home: home ? dec(home) : null, away: away ? dec(away) : null, score, lineups, goals, cards, subs };
}

// --- Próximas jornadas (la siguiente y 3 más) ---
const AHEAD = 4;
const toISO = (f, h) => { const m = /(\d+)\/(\d+)\/(\d+)/.exec(f || ""); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${/^\d+:\d+$/.test(h || "") ? h.padStart(5, "0") : "12:00"}` : ""; };
const slug = t => String(t || "").normalize("NFD").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
// Resultado de un acta en el formato de la app: marcador y eventos con nombre y dorsal (la app los pasa a sus jugadores)
function resOf(a, p) {
  if (!a || !a.score || !a.lineups || !a.lineups.length) return null;
  const sc = a.score, gl = parseInt(p.gl), gv = parseInt(p.gv);
  if (!isNaN(gl) && !isNaN(gv) && (gl !== sc[0] || gv !== sc[1])) return null;   // el acta aún no cuadra con el resultado oficial
  const who = {}; a.lineups.forEach(lu => lu.tit.concat(lu.sup).forEach(x => who[x.id] = { n: x.nombre, d: x.dorsal }));
  const pl = id => who[id] || {};
  const og = new Set(); [0, 1].forEach(s => { const gs = a.goals.filter(g => g.s === s); let extra = gs.length - sc[s];
    for (let i = gs.length - 1; i >= 0 && extra > 0; i--) if (gs[i].n) { og.add(gs[i]); extra--; } });
  const ev = [];
  a.goals.forEach(g => { if (!og.has(g)) ev.push({ t: "goal", s: g.s, min: g.min, ...pl(g.id) }); });   // las anotaciones "(gol)" que sobran no cuentan (igual que en las plantillas)
  if ([0, 1].some(s => ev.filter(e => e.s === s).length !== sc[s])) return { sc, ev: null };   // goles sin cuadrar: lo mete el admin
  a.cards.forEach(c => ev.push({ t: c.t === "red" ? "red" : "yel", s: c.s, min: c.min, ...pl(c.id) }));
  a.subs.forEach(x => ev.push({ t: "sub", s: x.s, min: x.min, ...pl(x.out), in: pl(x.in) }));
  ev.forEach(e => { if (e.min == null) e.min = 0; });
  ev.sort((x, y) => x.min - y.min);
  return { sc, ev };
}
const noScore = p => p.gl === "" || p.gl == null;
const daysAgo = f => { const m = /(\d+)\/(\d+)\/(\d+)/.exec(f || ""); return m ? (Date.now() - Date.UTC(+m[3], m[2] - 1, +m[1])) / 86400e3 : 0; };
// Partidos para la app: los de los últimos 10 días (con su resultado del acta, para liquidar) y las próximas jornadas
function upcomingFrom(rounds, played, groupId, liga, actas) {
  const out = [];
  for (let r = Math.max(1, played - 2); r <= played + AHEAD; r++) (rounds[r] || []).filter(p => p.local && p.visitante && (r > played || daysAgo(p.fecha) < 10)).forEach(p => {
    const q = { id: p.acta ? "a" + p.acta : "g" + groupId + "r" + r + slug(p.local) + slug(p.visitante), jornada: r, liga, local: p.local, visitante: p.visitante, fecha: toISO(p.fecha, p.hora) };
    const res = !noScore(p) && actas ? resOf(actas[p.acta], p) : null; if (res) q.res = res;
    out.push(q); });
  return out;
}
// Descarga (y guarda para siempre) las actas que falten de partidos ya jugados
async function loadActas(list, getJ, setJ, max) {
  const actas = {}, todo = [];
  await Promise.all(list.map(async p => { const a = await getJ("acta:" + p.acta); if (a && (a.score || noScore(p))) actas[p.acta] = a; else if (!noScore(p)) todo.push(p); }));
  const now = todo.slice(0, max);
  for (let i = 0; i < now.length; i += 4) await Promise.all(now.slice(i, i + 4).map(async p => {   // de 4 en 4 para no saturar la web
    try { const r = await fetch(SRC + "/acta/" + p.acta, { headers: UA }); if (!r.ok) return;
      const a = parseActa(await r.text()); a.r = p.r; if (a.lineups.length && a.score) { await setJ("acta:" + p.acta, a); actas[p.acta] = a; } } catch (e) {} }));
  return { actas, pending: todo.length - Object.keys(actas).filter(k => todo.some(p => p.acta === k)).length };
}
// Solo el calendario de las próximas jornadas (para la Tercera G2, cuyos datos van dentro de la app)
async function upcomingGroup(groupId, getJ, setJ) {
  const st = await getJSON("/api/ffcv/standings?idGroup=" + groupId + "&round=99");
  const played = +st.jornada || 0, rounds = {};
  await Promise.all(Array.from({ length: AHEAD + 3 }, (_, i) => played - 2 + i).filter(r => r >= 1).map(async r => {
    try { const j = await getJSON("/api/ffcv/results?idGroup=" + groupId + "&round=" + r);
      rounds[r] = (j.partidos || []).map(p => ({ acta: p.codacta, fecha: p.fecha, hora: p.hora, local: dec(p.Nombre_equipo_local), visitante: dec(p.Nombre_equipo_visitante), gl: p.Goles_casa, gv: p.Goles_visitante })); } catch (e) { rounds[r] = []; } }));
  const done = []; for (let r = Math.max(1, played - 2); r <= played + 1; r++) (rounds[r] || []).forEach(p => p.acta && !noScore(p) && daysAgo(p.fecha) < 10 && done.push({ r, ...p }));
  const { actas, pending } = getJ ? await loadActas(done, getJ, setJ, 16) : { actas: {}, pending: 0 };
  return { jornada: played, partidos: upcomingFrom(rounds, played, groupId, "", actas), pendingActas: pending, updated: Date.now() };
}

// --- Grupo completo ---
// redis: funciones get/set del servidor. maxActas: cuántas actas nuevas descargar en esta llamada.
async function buildGroup({ groupId, getJ, setJ, maxActas = 12 }) {
  const st = await getJSON("/api/ffcv/standings?idGroup=" + groupId + "&round=99");
  const played = +st.jornada || 0;
  const equipos = (st.clasificacion || []).map(e => ({ nombre: dec(e.nombre), pj: +e.jugados || 0, pts: +e.puntos || 0, gf: +e.goles_a_favor || 0, gc: +e.goles_en_contra || 0,
    racha: (e.racha_partidos || []).map(x => x.tipo === "G" ? "G" : x.tipo === "E" ? "E" : "P").join("") }));
  // La FFCV escribe a veces distinto el mismo equipo en clasificación, calendario y actas: todo se pasa al nombre de la clasificación
  const nk = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/futbol club/g, "fc").replace(/club de futbol/g, "cf").replace(/[^a-z0-9]/g, "");
  const byK = {}; equipos.forEach(e => byK[nk(e.nombre)] = e.nombre); const fix = t => byK[nk(t)] || t;
  const liga = (dec(st.competicion || "").trim() || "Liga") + (st.grupo ? " · " + dec(st.grupo).replace(/^Grup\s*-\s*/i, "Grupo ") : "");
  // Jornadas: las jugadas (para actas) y la siguiente (para apostar)
  const rounds = {};
  await Promise.all(Array.from({ length: played + AHEAD }, (_, i) => i + 1).map(async r => { const k = "res:" + groupId + ":" + r, cached = r < played ? await getJ(k) : null;
    if (cached) { rounds[r] = cached.map(p => ({ ...p, local: fix(p.local), visitante: fix(p.visitante) })); return; }
    try { const j = await getJSON("/api/ffcv/results?idGroup=" + groupId + "&round=" + r);
      rounds[r] = (j.partidos || []).map(p => ({ acta: p.codacta, fecha: p.fecha, hora: p.hora, local: fix(dec(p.Nombre_equipo_local)), visitante: fix(dec(p.Nombre_equipo_visitante)), gl: p.Goles_casa, gv: p.Goles_visitante, estado: p.estado }));
      if (r < played) await setJ(k, rounds[r]); } catch (e) { rounds[r] = []; } }));
  // Actas de lo ya jugado
  const all = []; for (let r = 1; r <= played; r++) (rounds[r] || []).forEach(p => p.acta && all.push({ r, ...p }));
  const { actas, pending } = await loadActas(all, getJ, setJ, maxActas);
  // Plantillas: [nombre, dorsal, pj, titular, goles, amarillas, rojas, portero]
  const T = {};
  for (const p of all) { const a = actas[p.acta]; if (!a) continue; const names = [fix(a.home || p.local), fix(a.away || p.visitante)];
    a.lineups.forEach((lu, s) => { const team = names[s]; const tt = (T[team] ??= {});
      const on = new Set(lu.tit.map(x => x.id).concat(a.subs.filter(x => x.s === s).map(x => x.in)));
      lu.tit.concat(lu.sup).forEach(x => { const q = (tt[x.id] ??= { nombre: x.nombre, dorsal: x.dorsal, pj: 0, tit: 0, g: 0, y: 0, r: 0, gk: 0, d: {} });
        if (x.dorsal != null) q.d[x.dorsal] = (q.d[x.dorsal] || 0) + 1; if (x.gk) q.gk++;
        if (on.has(x.id)) q.pj++; if (lu.tit.some(z => z.id === x.id)) q.tit++; }); });
    // Goles anotados "(gol)": a veces son en propia puerta. Si una columna tiene más goles que el marcador, esos no cuentan al jugador.
    const drop = new Set();
    if (a.score) [0, 1].forEach(s => { const gs = a.goals.filter(g => g.s === s); let extra = gs.length - a.score[s];
      for (let i = gs.length - 1; i >= 0 && extra > 0; i--) if (gs[i].n) { drop.add(gs[i]); extra--; } });
    a.goals.forEach(g => { if (drop.has(g)) return; const q = (T[names[g.s]] || {})[g.id]; if (q) q.g++; });
    a.cards.forEach(c => { const q = (T[names[c.s]] || {})[c.id]; if (!q) return; if (c.t === "yel") q.y++; else if (c.t === "y2") { q.y++; q.r++; } else q.r++; }); }
  const plantillas = {};
  Object.entries(T).forEach(([team, ps]) => { plantillas[team] = Object.values(ps).filter(q => q.pj > 0).map(q => {
    const dor = Object.entries(q.d).sort((a, b) => b[1] - a[1])[0]; return [q.nombre, dor ? +dor[0] : q.dorsal, q.pj, q.tit, q.g, q.y, q.r, q.gk * 2 > q.pj ? 1 : 0]; }); });
  const partidos = upcomingFrom(rounds, played, groupId, liga, actas);
  return { liga, jornada: played, equipos, plantillas, partidos, pendingActas: pending, updated: Date.now() };
}
module.exports = { buildGroup, upcomingGroup, parseActa, getJSON };
