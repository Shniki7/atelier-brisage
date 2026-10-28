/* Atelier de brisage — application
   Données : Firebase (connexion Google + Firestore)
     profiles/{uid}                 pseudo, serveur, code, createdAt
     profiles/{uid}/data/prix       { p: {idRessource: prix}, m: {idRessource: "AAAA-MM-JJ"} }
     profiles/{uid}/data/suivi      { items: [{ id, brk, r? }] }
     profiles/{uid}/journal/{id}    une série : item, nom, qte, cout, achat, brisage, runes, vente, encaisse
*/
"use strict";
const $ = s => document.querySelector(s);
const fmt = n => n == null || isNaN(n) ? "–" : Math.round(n).toLocaleString("fr-FR");
const isoD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => isoD(new Date());
const fdate = d => d ? d.split("-").reverse().join("/") : "–";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const pD = s => { const [y, m, d] = (s || "").split("-").map(Number); return y ? new Date(y, m - 1, d) : null; };
let t0; function toast(m) { const e = $("#toast"); e.textContent = m; e.classList.add("show"); clearTimeout(t0); t0 = setTimeout(() => e.classList.remove("show"), 2200); }
const timers = {}; function later(k, fn, ms = 600) { clearTimeout(timers[k]); timers[k] = setTimeout(fn, ms); }
const LS = "atelier-brisage";
const lsGet = k => { try { return localStorage.getItem(LS + "-" + k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(LS + "-" + k, v); } catch (e) { } };

// ---------------------------------------------------------------- état
let D = null; const ITEMS = new Map();     // recettes
let ME = null, MYPROFILE = null;            // utilisateur connecté
const MEMBERS = new Map();                  // uid -> { p, prix, maj, suivi, journal, loaded }
let VIEW = null;                            // uid du profil affiché
let S = blank();                            // données du profil affiché
let open = new Set(), tab = lsGet("tab") || "dash", rfilter = "";
let gran = lsGet("gran") || "semaine", ggran = lsGet("ggran") || "semaine", demoOn = true, charts = {};
const pendingPrix = new Set();
const pendingJ = new Map();                 // saisies du journal pas encore confirmées par le serveur : id -> {champ: valeur}

function blank() { return { p: {}, prix: {}, maj: {}, rp: {}, rm: {}, rpt: {}, rec: {}, cfg: { taxe: 2, recolte: "hdv" }, suivi: [], journal: [], loaded: false }; }
function member(uid) { if (!MEMBERS.has(uid)) MEMBERS.set(uid, blank()); return MEMBERS.get(uid); }
const isMe = () => VIEW === ME;
const ro = () => !isMe();
function membersSorted() {
  return [...MEMBERS.entries()].filter(([, m]) => m.p && m.p.pseudo)
    .sort((a, b) => (a[1].p.createdAt?.seconds ?? 9e12) - (b[1].p.createdAt?.seconds ?? 9e12));
}
function colorOf(uid) { const i = membersSorted().findIndex(([u]) => u === uid); return `var(--s${(Math.max(0, i) % 8) + 1})`; }
function colorHex(uid) { const i = membersSorted().findIndex(([u]) => u === uid); return css(`--s${(Math.max(0, i) % 8) + 1}`); }
const initials = s => (s || "?").trim().slice(0, 2).toUpperCase();

// ---------------------------------------------------------------- calculs
function recipeOf(s) { if (s.r) return s.r.map(o => [o.i, o.q]); const it = ITEMS.get(s.id); return it ? it.ing : []; }
const taxe = (M = S) => Math.min(50, Math.max(0, +(M.cfg?.taxe ?? 2))) / 100;
const GROUP_DAYS = 14;
const ageDays = d => { const x = pD(d); return x ? Math.floor((Date.now() - x) / 864e5) : 1e9; };
function median(a) { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
// Prix proposé par le groupe : médiane des prix saisis par les autres membres du même serveur ces 14 derniers jours
function groupPrice(field, dateField, id, M = S) {
  const srv = norm(M.p?.serveur || ""); const vals = [];
  for (const [, m] of MEMBERS) {
    if (m === M) continue;
    if (srv && m.p?.serveur && norm(m.p.serveur) !== srv) continue;
    const v = +m[field]?.[id]; if (v > 0 && ageDays(m[dateField]?.[id]) <= GROUP_DAYS) vals.push(v);
  }
  return vals.length ? { v: Math.round(median(vals)), n: vals.length } : null;
}
function priceInfo(rid, M = S) {
  if (M.rec?.[rid] && M.cfg?.recolte === "gratuit") return { v: 0, src: "récolte" };
  const p = +M.prix[rid]; if (p > 0) return { v: p, src: "moi" };
  const g = groupPrice("prix", "maj", rid, M); return g ? { v: g.v, src: "groupe", n: g.n } : { v: null, src: null };
}
function runePriceInfo(a, M = S) {
  const p = +M.rp?.[a]; if (p > 0) return { v: p, src: "moi" };
  const g = groupPrice("rp", "rm", a, M); return g ? { v: g.v, src: "groupe", n: g.n } : { v: null, src: null };
}
function unitPrice(rid, M = S) { return priceInfo(rid, M).v; }
function costOf(s, M = S) {
  const r = recipeOf(s); let c = 0, miss = 0;
  for (const [id, q] of r) { const p = unitPrice(id, M); if (p == null) miss++; else c += p * q; }
  return { cost: c, miss };
}
// Estimation du brisage (formule communautaire) :
// runes de base = (jet moyen × poids de la carac × niveau × 0,015 + 1) × coefficient ÷ poids d'une rune de base
// poids d'une rune de base = points apportés par la rune × poids de la carac
function runeLines(s, M = S) {
  const it = ITEMS.get(s.id), fx = D.fx?.[s.id]; if (!it || !fx) return [];
  const coef = Math.max(0, +(s.coef ?? 100) || 0) / 100;
  return fx.map(([a, lo, hi]) => {
    const st = D.stats[a]; if (!st) return null;
    const [nom, poids, ptsDef] = st; const pts = +M.rpt?.[a] || ptsDef;
    const jet = (lo + hi) / 2;
    const runes = (jet * poids * it.l * 0.015 + 1) * coef / (pts * poids);
    const pi = runePriceInfo(a, M), prix = pi.v;
    return { a, nom, lo, hi, jet, pts, runes, prix, psrc: pi.src, pn: pi.n, val: prix != null ? runes * prix : null };
  }).filter(Boolean);
}
function estBrk(s, M = S) {
  const L = runeLines(s, M); if (!L.length) return { val: null, miss: 0, none: true, lines: L };
  const miss = L.filter(l => l.prix == null).length; const part = L.reduce((a, l) => a + (l.val || 0), 0);
  // trier les runes : d'abord celles qui pèsent le plus (valeur connue, sinon nombre de runes × poids)
  L.sort((x, y) => (y.val ?? -1) - (x.val ?? -1) || (y.runes * y.pts) - (x.runes * x.pts));
  return { val: miss ? null : part, part, miss, lines: L };
}
function statsOf(s, M = S) {
  const { cost, miss } = costOf(s, M); const est = estBrk(s, M);
  const manual = +s.brk || 0; const gross = manual > 0 ? manual : (est.val || 0);
  const brk = gross * (1 - taxe(M)); const src = manual > 0 ? "manuel" : est.val ? "estimé" : null;
  const ok = !miss && cost > 0 && brk > 0;
  return { cost, miss, brk, gross, src, est, ok, benef: ok ? brk - cost : null, roi: ok ? (brk - cost) / cost : null };
}
const pillCls = r => r == null ? "p-na" : r < 0 ? "p-neg" : r >= 1.5 ? "p-great" : r >= .6 ? "p-ok" : "p-low";
const pillTxt = r => (r >= 0 ? "+" : "") + Math.round(r * 100) + " %";
function realize(e) {
  const enc = +e.encaisse || 0, rn = +e.runes || 0;
  if (enc > 0) return { date: e.vente || e.brisage || e.achat, ventes: enc };
  if (rn > 0) return { date: e.brisage || e.achat, ventes: rn };
  return null;
}
function byItem(list) {
  const by = new Map();
  for (const e of list) {
    const R = realize(e); if (!R) continue;
    const o = by.get(e.nom) || { k: e.nom, item: e.item, n: 0, inv: 0, rn: 0, rows: [] };
    o.n++; o.inv += +e.cout || 0; o.rn += R.ventes; o.rows.push({ d: R.date, roi: e.cout > 0 ? (R.ventes - e.cout) / e.cout : 0 }); by.set(e.nom, o);
  }
  return [...by.values()].map(o => ({ ...o, roi: o.inv ? (o.rn - o.inv) / o.inv : null })).sort((a, b) => (b.roi ?? -9) - (a.roi ?? -9));
}

// ---------------------------------------------------------------- Firebase
let fb = null, auth = null, db = null; const unsubs = [];
function configOk() { const c = window.FIREBASE_CONFIG; return c && c.apiKey && !/A_REMPLIR/.test(JSON.stringify(c)); }
function show(id) { ["screen-setup", "screen-login", "screen-onboard", "app"].forEach(x => $("#" + x).hidden = x !== id); }

function boot() {
  if (!window.firebase || !configOk()) { show("screen-setup"); return; }
  fb = firebase.initializeApp(window.FIREBASE_CONFIG);
  auth = firebase.auth(); db = firebase.firestore();
  try { db.enablePersistence({ synchronizeTabs: true }).catch(() => { }); } catch (e) { }
  auth.getRedirectResult().catch(e => loginError(e));
  auth.onAuthStateChanged(async u => {
    unsubs.splice(0).forEach(f => f()); MEMBERS.clear();
    if (!u) { ME = null; show("screen-login"); return; }
    ME = u.uid;
    try {
      const snap = await db.doc(`profiles/${ME}`).get();
      if (!snap.exists) { $("#oPseudo").value = (u.displayName || "").split(" ")[0].slice(0, 24); show("screen-onboard"); return; }
      startApp(snap.data());
    } catch (e) { console.error(e); show("screen-login"); loginError(e); }
  });
}
function loginError(e) {
  if (!e || e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
  const msg = {
    "auth/unauthorized-domain": "Ce site n'est pas autorisé dans Firebase. Ajoute son adresse dans Authentication > Paramètres > Domaines autorisés.",
    "auth/operation-not-allowed": "La connexion Google n'est pas activée dans Firebase (Authentication > Méthode de connexion).",
    "permission-denied": "Accès refusé par les règles Firestore. Vérifie que les règles du README sont publiées."
  }[e.code] || ("Connexion impossible : " + (e.message || e.code));
  const el = $("#loginErr"); el.textContent = msg; el.hidden = false;
}
$("#btnLogin").addEventListener("click", async () => {
  $("#loginErr").hidden = true;
  const prov = new firebase.auth.GoogleAuthProvider();
  try { await auth.signInWithPopup(prov); }
  catch (e) { if (e.code === "auth/popup-blocked") auth.signInWithRedirect(prov); else loginError(e); }
});
$("#btnLogout").addEventListener("click", () => auth.signOut());
$("#btnLogout2").addEventListener("click", () => auth.signOut());
$("#fOnboard").addEventListener("submit", async e => {
  e.preventDefault(); const err = $("#onbErr"); err.hidden = true;
  const pseudo = $("#oPseudo").value.trim(), serveur = $("#oServeur").value.trim(), code = $("#oCode").value.trim();
  if (!pseudo) { err.textContent = "Choisis un pseudo."; err.hidden = false; return; }
  if (!code) { err.textContent = "Saisis le code du groupe."; err.hidden = false; return; }
  const p = { pseudo, serveur, code, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
  try { await db.doc(`profiles/${ME}`).set(p); startApp({ ...p, createdAt: { seconds: Date.now() / 1000 } }); }
  catch (x) { err.textContent = x.code === "permission-denied" ? "Code du groupe incorrect. Demande-le à la personne qui t'a invité." : "Impossible de créer le profil : " + (x.message || x.code); err.hidden = false; }
});

function startApp(profile) {
  MYPROFILE = profile; show("app");
  member(ME).p = profile;
  VIEW = ME; S = member(ME);
  $("#meName").textContent = profile.pseudo; $("#meAv").textContent = initials(profile.pseudo);
  // tous les membres du groupe
  unsubs.push(db.collection("profiles").onSnapshot(snap => {
    const seen = new Set();
    snap.docs.forEach(d => { seen.add(d.id); const m = member(d.id); const first = !m.p.pseudo; m.p = d.data(); if (first || !m.subscribed) subscribeMember(d.id); });
    for (const uid of [...MEMBERS.keys()]) if (!seen.has(uid) && uid !== ME) MEMBERS.delete(uid);
    if (!MEMBERS.has(VIEW)) setView(ME);
    $("#meAv").style.background = colorOf(ME);
    renderHeader(); render();
  }, e => { console.error(e); toast("Lecture du groupe impossible : vérifie les règles Firestore"); }));
  subscribeMember(ME);
  loadRecipes();
}
function subscribeMember(uid) {
  const m = member(uid); if (m.subscribed) return; m.subscribed = true;
  const base = db.doc(`profiles/${uid}`);
  unsubs.push(base.collection("data").doc("prix").onSnapshot(snap => {
    const d = snap.data() || {};
    const nx = { prix: { ...(d.p || {}) }, maj: { ...(d.m || {}) }, rp: { ...(d.rp || {}) }, rm: { ...(d.rm || {}) }, rpt: { ...(d.rpt || {}) }, rec: { ...(d.r || {}) }, cfg: { taxe: 2, recolte: "hdv", ...(d.cfg || {}) } };
    if (uid === ME) for (const k of pendingPrix) {           // garder les saisies pas encore enregistrées
      const [f, id] = k.split(":");
      if (f === "cfg") { nx.cfg = { ...m.cfg }; continue; }
      const date = f === "prix" ? "maj" : f === "rp" ? "rm" : null;
      if (m[f][id] != null && m[f][id] !== false && m[f][id] !== 0) nx[f][id] = m[f][id]; else delete nx[f][id];
      if (date) nx[date][id] = m[date][id];
    }
    Object.assign(m, nx); m.loaded = true; render();
  }, onErr));
  unsubs.push(base.collection("data").doc("suivi").onSnapshot(snap => {
    if (uid === ME && timers.suivi) return; // modification locale en attente d'enregistrement
    const d = snap.data() || {}; m.suivi = (d.items || []).map(x => ({ ...x })); render();
  }, onErr));
  unsubs.push(base.collection("journal").onSnapshot(snap => {
    m.journal = snap.docs.map(d => ({ _id: d.id, ...d.data(), ...(uid === ME ? pendingJ.get(d.id) || {} : {}) }));
    render();
  }, onErr));
}
function onErr(e) { console.error(e); showError(e.code === "permission-denied" ? "Lecture refusée par Firebase : vérifie que les règles Firestore sont bien publiées." : "Lecture impossible : " + (e.code || e.message)); }
function fail(e) {
  console.error(e);
  const msg = e?.code === "permission-denied" ? "Enregistrement refusé par Firebase : vérifie que les règles Firestore sont bien publiées."
    : e?.code === "not-found" ? "La base Firestore n'existe pas encore : crée-la dans la console Firebase."
    : "Enregistrement impossible : " + (e?.code || e?.message || "erreur inconnue");
  showError(msg);
}
function showError(msg) {
  let b = $("#errBar");
  if (!b) { b = document.createElement("div"); b.id = "errBar"; b.className = "err"; b.setAttribute("role", "alert"); b.style.cssText = "display:flex;gap:10px;justify-content:space-between;align-items:center"; $(".content").prepend(b); }
  b.innerHTML = `<span>${esc(msg)}</span><button class="ghost x" type="button" aria-label="Fermer">×</button>`;
  b.querySelector("button").onclick = () => b.remove();
}
const Store = {
  savePrix() { if (!isMe()) return; pendingPrix.clear(); db.doc(`profiles/${ME}/data/prix`).set({ p: { ...S.prix }, m: { ...S.maj }, rp: { ...S.rp }, rm: { ...S.rm }, rpt: { ...S.rpt }, r: { ...S.rec }, cfg: { ...S.cfg } }).catch(fail); },
  saveSuivi() { if (!isMe()) return; timers.suivi = null; db.doc(`profiles/${ME}/data/suivi`).set({ items: S.suivi.map(x => ({ ...x })) }).catch(fail); },
  addJr(e) { if (!isMe()) return; db.collection(`profiles/${ME}/journal`).add(e).catch(fail); },
  updJr(id, patch) {
    if (!isMe()) return;
    pendingJ.set(id, { ...(pendingJ.get(id) || {}), ...patch });
    db.doc(`profiles/${ME}/journal/${id}`).update(patch).then(() => {
      const p = pendingJ.get(id); if (!p) return;
      for (const k of Object.keys(patch)) if (p[k] === patch[k]) delete p[k];
      if (!Object.keys(p).length) pendingJ.delete(id);
    }).catch(fail);
  },
  delJr(id) { if (!isMe()) return; db.doc(`profiles/${ME}/journal/${id}`).delete().catch(fail); }
};
function saveSuiviLater() { clearTimeout(timers.suivi); timers.suivi = setTimeout(() => Store.saveSuivi(), 600); }

function loadRecipes() {
  if (D) { afterLoad(); return; }
  fetch("data/recettes.json").then(r => r.json()).then(d => {
    d.items = d.items.map(([id, n, l, t, j, ing]) => ({ id, n, l, t, j, ing, nn: norm(n) }));
    D = d; d.items.forEach(it => ITEMS.set(it.id, it));
    afterLoad();
  }).catch(() => { $("#loading").textContent = "Impossible de charger data/recettes.json. Ouvre l'outil depuis GitHub Pages ou un petit serveur local (voir le README)."; });
}
function afterLoad() { $("#loading").hidden = true; setTab(tab); }

// ---------------------------------------------------------------- navigation
function setView(uid) {
  VIEW = uid; S = member(uid); open.clear(); demoOn = true;
  renderHeader(); render();
}
function weekBen(m) {
  const from = GR.semaine.start(new Date()); let b = 0;
  for (const e of m.journal) { const R = realize(e); const d = R && pD(R.date); if (d && d >= from) b += R.ventes - (+e.cout || 0); }
  return b;
}
function renderHeader() {
  $("#members").innerHTML = membersSorted().map(([uid, m]) => { const b = weekBen(m);
    return `<button class="mem" type="button" data-view="${uid}" aria-current="${uid === VIEW}"><span class="avatar sm" style="background:${colorOf(uid)}">${esc(initials(m.p.pseudo))}</span><span class="nm">${esc(m.p.pseudo)}${uid === ME ? " (moi)" : ""}</span><span class="v ${b > 0 ? "up" : b < 0 ? "dn" : ""}">${b ? (b > 0 ? "+" : "") + kfmt(b) : "–"}</span></button>`; }).join("");
  $("#meSrv").textContent = MYPROFILE?.serveur || "";
  $("#roBanner").hidden = isMe();
  $("#roName").textContent = S.p?.pseudo || "";
  document.body.classList.toggle("ro", ro());
  $("#cGrp").textContent = membersSorted().length;
}
$("#members").addEventListener("click", e => { const b = e.target.closest("[data-view]"); if (b) setView(b.dataset.view); });
$("#btnBackMe").addEventListener("click", () => setView(ME));
const TITLES = {
  dash: ["Tableau de bord", "Bénéfices, ventes et rendement réel"],
  grp: ["Le groupe", "Bilans et classement des membres"],
  crafts: ["Crafts suivis", "Coût de craft, valeur de brisage et plan d'achat"],
  res: ["Ressources", "Prix unitaires utilisés pour calculer les coûts"],
  jr: ["Journal", "Achats, brisages et ventes, série par série"]
};
function setTab(t) {
  tab = t; lsSet("tab", t);
  $("#pageTitle").textContent = TITLES[t][0]; $("#pageSub").textContent = TITLES[t][1];
  document.querySelectorAll("nav [data-tab]").forEach(x => x.setAttribute("aria-selected", x.dataset.tab === t));
  ["dash", "grp", "crafts", "res", "jr"].forEach(x => $("#v-" + x).hidden = x !== t);
  render();
}
document.querySelector("nav").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });

// ---------------------------------------------------------------- rendu
function render() {
  if (!D || !VIEW) return;
  renderHeader();
  $("#cCrafts").textContent = S.suivi.length;
  $("#cRes").textContent = neededRes().length;
  $("#cJr").textContent = S.journal.length;
  if (tab === "dash") renderDash();
  if (tab === "grp") renderGroup();
  if (tab === "crafts") renderCrafts();
  if (tab === "res") renderRes();
  if (tab === "jr") renderJr();
  applyRO();
}
function applyRO() {
  const r = ro();
  document.querySelectorAll("#v-crafts input, #v-crafts select, #v-res input, #v-res select, #v-jr input, #v-jr select").forEach(x => { if (!x.classList.contains("keep")) x.disabled = r; });
  document.querySelectorAll("#v-crafts .x, #v-jr .x, [data-rreset]").forEach(x => x.hidden = r);
}
function keepFocus(fn) {
  const a = document.activeElement, id = a?.id, ss = a?.selectionStart; fn();
  if (id) { const el = document.getElementById(id); if (el && el !== a) { el.focus(); try { if (ss != null && el.type !== "number") el.setSelectionRange(ss, ss); } catch (e) { } } }
}

// ----- ordre des lignes figé pendant la saisie (sinon Tab sauterait de ligne en ligne au gré du tri)
const frozen = {};
function stableOrder(key, rows, idOf, cmp) {
  const editing = document.activeElement && document.activeElement.closest?.(`[data-freeze="${key}"]`) && document.activeElement.matches("input,select");
  if (editing && frozen[key]) {
    const pos = new Map(frozen[key].map((id, i) => [id, i]));
    rows.sort((a, b) => (pos.get(idOf(a)) ?? 1e9) - (pos.get(idOf(b)) ?? 1e9));
  } else rows.sort(cmp);
  frozen[key] = rows.map(idOf);
  return rows;
}

// ----- cases de prix : mon prix, prix du groupe (gris, à confirmer), récolte, ou manquant (orange)
const phCls = (pi, own) => own > 0 ? "" : pi.src === "groupe" ? "grp" : pi.src === "récolte" ? "" : "miss";
const phTxt = pi => pi.src === "groupe" ? fmt(pi.v) : pi.src === "récolte" ? "0 (récoltée)" : "prix";
const phTitle = pi => pi.src === "groupe" ? `Prix proposé par le groupe : médiane de ${pi.n || "plusieurs"} membre(s) de ton serveur, saisi(s) ces ${GROUP_DAYS} derniers jours. Tape ton propre prix pour le remplacer.` : pi.src === "moi" ? "Ton prix" : "";

// ----- Crafts suivis
function renderCrafts() {
  const rows = stableOrder("crafts", S.suivi.map(s => ({ s, it: ITEMS.get(s.id), ...statsOf(s) })), r => r.s.id, (a, b) => (b.roi ?? -1e9) - (a.roi ?? -1e9));
  const tx = taxe();
  keepFocus(() => {
    $("#crafts").innerHTML = rows.length ? rows.map(r => {
      const nm = r.it ? r.it.n : "Item retiré du jeu", isOpen = open.has(r.s.id);
      const why = r.miss ? `${r.miss} prix de ressource${r.miss > 1 ? "s" : ""}` : !r.brk ? (r.est.none ? "brisage à saisir" : `${r.est.miss} prix de rune${r.est.miss > 1 ? "s" : ""}`) : "";
      const roiCell = r.ok ? `<span class="pill ${pillCls(r.roi)}">${pillTxt(r.roi)}</span>` : `<span class="pill p-na" title="Il manque : ${why}">${why}</span>`;
      const ph = r.est.val ? "≈ " + fmt(r.est.val) : r.est.part ? "≥ " + kfmt(r.est.part) : "kamas";
      let html = `<tr class="item ${isOpen ? "open" : ""}" data-id="${r.s.id}">
        <td class="l"><div class="iname"><span class="chev">›</span><span>${esc(nm)}<small>${r.it ? `Niv. ${r.it.l} · ${esc(D.types[r.it.t] || "")} · ${esc(r.it.j)}` : ""}${r.s.r ? " · recette modifiée" : ""}</small></span></div></td>
        <td class="m">${r.miss ? (r.cost ? `<span class="neg" title="Coût partiel : prix manquants">≥ ${fmt(r.cost)}</span>` : `<span class="note">–</span>`) : fmt(r.cost)}</td>
        <td><input class="num coef-in" id="coef-${r.s.id}" data-coef="${r.s.id}" data-col="coef" type="number" min="0" max="4000" value="${r.s.coef ?? 100}" aria-label="Coefficient de brisage de ${esc(nm)} en %"></td>
        <td><input class="num brk-in" id="brk-${r.s.id}" data-brk="${r.s.id}" data-col="brk" type="number" min="0" value="${r.s.brk || ""}" placeholder="${ph}" aria-label="Valeur de brisage de ${esc(nm)}" title="${r.src === "estimé" ? "Estimé à partir des prix des runes. Saisis une valeur pour la remplacer." : r.src === "manuel" ? "Valeur saisie à la main. Efface-la pour revenir à l'estimation." : "Renseigne les prix des runes ou saisis une valeur."}">
          <small class="note src">${r.src ? r.src + (tx ? ` · net ${fmt(r.brk)}` : "") : ""}</small></td>
        <td class="m ${r.benef < 0 ? "neg" : r.benef > 0 ? "pos" : ""}">${r.ok ? fmt(r.benef) : "–"}</td>
        <td>${roiCell}</td>
        <td class="acts"><button class="ghost own-only" data-serie="${r.s.id}" title="Ajouter une série de cet item au journal">+&nbsp;Série</button><button class="ghost x" data-del="${r.s.id}" title="Retirer de la liste" aria-label="Retirer ${esc(nm)}">×</button></td></tr>`;
      if (isOpen) {
        const rec = recipeOf(r.s);
        const costTxt = r.miss ? (r.cost ? "≥ " + fmt(r.cost) : "inconnu") : fmt(r.cost);
        const brkTxt = r.est.val ? fmt(r.est.val) : r.est.part ? "≥ " + fmt(r.est.part) : "inconnu";
        html += `<tr class="detail"><td colspan="7"><div class="detail-grid">
          <section class="dcard d-in">
          <header><span class="dc-t"><span class="dc-ic">−</span>Recette · ce que tu dépenses</span><span class="dc-v">${costTxt}</span></header>
          <div class="recipe">
          <div class="rrow rhead"><span>Ressource</span><span style="text-align:right">Qté</span><span style="text-align:right">Prix unitaire</span><span style="text-align:right">Sous-total</span><span></span></div>
          ${rec.map(([rid, q], k) => { const p = S.prix[rid], pi = priceInfo(rid), u = pi.v; const free = pi.src === "récolte"; return `<div class="rrow">
            <span class="rn">${esc(D.res[rid] || "Ressource " + rid)}${S.rec[rid] ? ' <span class="tag">récoltée</span>' : ""}</span>
            <input class="num" id="q-${r.s.id}-${rid}" data-rq="${r.s.id}" data-k="${k}" data-col="rq-${r.s.id}" type="number" min="1" value="${q}" aria-label="Quantité">
            <input class="num ${phCls(pi, p)}" id="p-${r.s.id}-${rid}" data-price="${rid}" data-col="pp-${r.s.id}" type="number" min="0" value="${p || ""}" placeholder="${phTxt(pi)}" title="${phTitle(pi)}" aria-label="Prix de ${esc(D.res[rid] || "")}">
            <span class="st">${u != null ? fmt(u * q) : "–"}</span>
            <button class="ghost x" data-rdel="${r.s.id}" data-k="${k}" aria-label="Retirer l'ingrédient" title="Retirer l'ingrédient">×</button></div>`; }).join("")}
          <div class="rfoot"><span class="note">Coût : ${r.miss ? (r.cost ? `au moins <b class="mono">${fmt(r.cost)}</b>` : "inconnu") + ` · ${r.miss} prix manquant${r.miss > 1 ? "s" : ""}` : `<b class="mono">${fmt(r.cost)}</b>`}</span>
            ${r.s.r ? `<button class="ghost" data-rreset="${r.s.id}">Revenir à la recette du jeu</button>` : ""}</div></div></section>
          <section class="dcard d-out">
          <header><span class="dc-t"><span class="dc-ic">+</span>Brisage · ce que tu récupères</span><span class="dc-v">${brkTxt}</span></header>
          ${r.est.lines.length ? `<div class="recipe">
            <div class="rrow runes rhead"><span>Rune obtenue (jet moyen)</span><span style="text-align:right">Runes</span><span style="text-align:right">Prix rune</span><span style="text-align:right">Valeur</span></div>
            ${r.est.lines.map(l => `<div class="rrow runes"><span class="rn">${esc(l.nom)} <span class="note">${l.lo === l.hi ? l.lo : l.lo + "–" + l.hi}${l.pts > 1 ? ` · ${l.pts} pts/rune` : ""}</span></span>
              <span class="st">${l.runes.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}</span>
              <input class="num ${phCls({ v: l.prix, src: l.psrc }, S.rp[l.a])}" id="rup-${r.s.id}-${l.a}" data-runep="${l.a}" data-col="rup-${r.s.id}" type="number" min="0" value="${S.rp[l.a] || ""}" placeholder="${phTxt({ v: l.prix, src: l.psrc })}" title="${phTitle({ v: l.prix, src: l.psrc, n: l.pn })}" aria-label="Prix de la rune ${esc(l.nom)}">
              <span class="st">${l.val != null ? fmt(l.val) : "–"}</span></div>`).join("")}
            <div class="rfoot"><span class="note">${r.est.val
              ? `Brisage estimé : <b class="mono">${fmt(r.est.val)}</b> au coefficient ${r.s.coef ?? 100} %${tx ? `, soit <b class="mono">${fmt(r.est.val * (1 - tx))}</b> après ${Math.round(tx * 1000) / 10} % de taxe` : ""}.`
              : `Brisage estimé : au moins <b class="mono">${fmt(r.est.part)}</b> · ${r.est.miss} prix de rune${r.est.miss > 1 ? "s" : ""} manquant${r.est.miss > 1 ? "s" : ""}. Les runes sont triées de la plus importante à la moins importante : commence par le haut.`}</span></div>
          </div>` : `<p class="note">Pas d'effets connus pour cet item : saisis sa valeur de brisage à la main.</p>`}
          </section></div></td></tr>`;
      }
      return html;
    }).join("") : `<tr><td colspan="7" class="empty">${isMe() ? "Aucun item suivi. Cherche un item ci-dessus pour l'ajouter (raccourci : /)." : "Ce membre ne suit encore aucun item."}</td></tr>`;
  });
  renderPlan(rows);
}
// ----- Plan optimal : quels crafts faire, et combien, pour le plus gros bénéfice avec un budget donné
// Problème du sac à dos borné : chaque exemplaire est un « objet » (coût, gain). Avec une baisse de coefficient,
// chaque exemplaire supplémentaire du même item rapporte un peu moins, ce que le calcul prend en compte.
function optimizePlan(cands, budget, maxq, drop) {
  const units = [];
  for (const c of cands) for (let k = 0; k < maxq; k++) {
    const gain = c.brk * Math.pow(1 - drop, k) - c.cost; if (gain <= 0) break;
    units.push({ c, cost: c.cost, gain });
  }
  if (!units.length || budget <= 0) return { picks: [], inv: 0, ben: 0 };
  units.sort((x, y) => y.gain / y.cost - x.gain / x.cost); units.splice(3000);
  const step = Math.max(1, Math.ceil(budget / 2000)), W = Math.floor(budget / step);
  const dp = new Float64Array(W + 1), keep = new Uint8Array(units.length * (W + 1));
  units.forEach((u, i) => {
    const w = Math.ceil(u.cost / step); if (w > W) return;
    for (let cap = W; cap >= w; cap--) { const v = dp[cap - w] + u.gain; if (v > dp[cap]) { dp[cap] = v; keep[i * (W + 1) + cap] = 1; } }
  });
  const count = new Map(); let cap = W;
  for (let i = units.length - 1; i >= 0; i--) if (keep[i * (W + 1) + cap]) { const u = units[i]; count.set(u.c, (count.get(u.c) || 0) + 1); cap -= Math.ceil(u.cost / step); }
  const picks = [...count].map(([c, q]) => { let g = 0; for (let k = 0; k < q; k++) g += c.brk * Math.pow(1 - drop, k) - c.cost; return { ...c, q, gain: g }; }).sort((a, b) => b.gain - a.gain);
  return { picks, inv: picks.reduce((a, p) => a + p.q * p.cost, 0), ben: picks.reduce((a, p) => a + p.gain, 0) };
}
function greedyPlan(cands, budget, maxq, drop) {
  let left = budget, ben = 0;
  for (const c of [...cands].sort((a, b) => b.roi - a.roi)) for (let k = 0; k < maxq; k++) {
    const g = c.brk * Math.pow(1 - drop, k) - c.cost; if (g <= 0 || c.cost > left) break; left -= c.cost; ben += g;
  }
  return ben;
}
let allCache = null;
function allKnownItems() {
  // tous les items du jeu dont les prix (ressources + runes) sont connus, au coefficient 100 %
  const key = JSON.stringify([S.prix, S.rp, S.rec, S.cfg, S.rpt, MEMBERS.size, S.suivi.length]);
  if (allCache && allCache.key === key) return allCache.list;
  const tracked = new Set(S.suivi.map(x => x.id)); const list = [];
  for (const it of D.items) {
    if (tracked.has(it.id) || !D.fx?.[it.id]) continue;
    const s = { id: it.id, coef: 100, brk: 0 }; const st = statsOf(s);
    if (st.ok && st.benef > 0) list.push({ s, it, ...st, untracked: true });
  }
  allCache = { key, list }; return list;
}
function renderPlan(rows) {
  const budget = Math.max(0, +$("#budget").value || 0), maxq = Math.max(1, Math.min(50, Math.floor(+$("#maxq").value || 1)));
  const drop = Math.min(50, Math.max(0, +$("#dropPct").value || 0)) / 100, all = $("#planAll").checked;
  let cands = rows.filter(r => r.ok && r.benef > 0);
  if (all) cands = cands.concat(allKnownItems());
  const { picks, inv, ben } = optimizePlan(cands, budget, maxq, drop);
  const simple = greedyPlan(cands, budget, maxq, drop);
  $("#plan").innerHTML = picks.length ? picks.map(p => `<li><span class="qty">${p.q}×</span><span>${esc(p.it.n)}${p.untracked ? ` <span class="grp-tag">non suivi</span> <button class="ghost own-only follow" data-follow="${p.it.id}" type="button">Suivre</button>` : ""}<br><small class="note">${fmt(p.cost)} pièce · ${pillTxt(p.roi)}${p.untracked ? " · coef. 100 %" : ""}</small></span><span class="pf">+${fmt(p.gain)}</span></li>`).join("")
    : `<li class="empty">${cands.length ? `Ton budget (${fmt(budget)}) ne suffit pas : le craft rentable le moins cher coûte ${fmt(Math.min(...cands.map(c => c.cost)))}. Augmente le budget.` : "Renseigne les prix des ressources et des runes pour obtenir un plan."}</li>`;
  $("#tInv").textContent = fmt(inv); $("#tBen").textContent = fmt(ben); $("#tLeft").textContent = fmt(budget - inv);
  $("#tRoi").textContent = inv ? pillTxt(ben / inv) : "–";
  $("#planGain").hidden = !(picks.length && ben - simple > Math.max(1, ben * 0.005));
  $("#planGain").innerHTML = `Ce plan rapporte <b>${fmt(ben - simple)}</b> de plus que de prendre simplement les items par ordre de rendement.`;
  $("#planInfo").textContent = `${cands.length} item${cands.length > 1 ? "s" : ""} rentable${cands.length > 1 ? "s" : ""} pris en compte${all ? ` (dont ${allKnownItems().length} non suivis)` : ""}.`;
}

// ----- Ressources et runes
function neededRes() {
  const m = new Map();
  for (const s of S.suivi) { const it = ITEMS.get(s.id); for (const [rid] of recipeOf(s)) { if (!m.has(rid)) m.set(rid, []); m.get(rid).push(it ? it.n : "?"); } }
  return [...m.entries()];
}
function neededRunes() {
  const m = new Map();
  for (const s of S.suivi) { const it = ITEMS.get(s.id); for (const [a] of D.fx?.[s.id] || []) { if (!D.stats[a]) continue; if (!m.has(a)) m.set(a, []); m.get(a).push(it ? it.n : "?"); } }
  return [...m.entries()];
}
function renderRes() {
  const f = norm(rfilter);
  $("#cfgTaxe").value = S.cfg.taxe ?? 2; $("#cfgRecolte").value = S.cfg.recolte || "hdv";
  const runes = stableOrder("runes", neededRunes().map(([a, its]) => ({ a, its, st: D.stats[a] })).filter(x => !f || norm(x.st[0]).includes(f)), x => x.a,
    (x, y) => ((S.rp[x.a] > 0) - (S.rp[y.a] > 0)) || x.st[0].localeCompare(y.st[0], "fr"));
  const list = stableOrder("res", neededRes().map(([rid, its]) => ({ rid, its, n: D.res[rid] || "Ressource " + rid })).filter(x => !f || norm(x.n).includes(f)), x => x.rid,
    (a, b) => ((unitPrice(a.rid) != null) - (unitPrice(b.rid) != null)) || a.n.localeCompare(b.n, "fr"));
  keepFocus(() => {
    $("#runes").innerHTML = runes.length ? runes.map(x => { const p = S.rp[x.a], pi = runePriceInfo(x.a); return `<tr>
      <td class="l"><b>Rune ${esc(x.st[0])}</b><small class="note adv" style="display:block">poids ${x.st[1]}</small></td>
      <td class="l note">${esc([...new Set(x.its)].slice(0, 4).join(", "))}${new Set(x.its).size > 4 ? "…" : ""}</td>
      <td class="adv"><input class="num" id="rpt-${x.a}" data-runepts="${x.a}" data-col="rpt" type="number" min="1" value="${S.rpt[x.a] || x.st[2]}" aria-label="Points apportés par une rune ${esc(x.st[0])}" style="width:80px"></td>
      <td><input class="num ${phCls(pi, p)}" id="rup-${x.a}" data-runep="${x.a}" data-col="rup" type="number" min="0" value="${p || ""}" placeholder="${phTxt(pi)}" title="${phTitle(pi)}" aria-label="Prix de la rune ${esc(x.st[0])}"></td>
      <td class="m note">${p > 0 ? fdate(S.rm[x.a]) : pi.src === "groupe" ? `<span class="grp-tag">groupe</span>` : "–"}</td></tr>`; }).join("")
      : `<tr><td colspan="5" class="empty">${S.suivi.length ? "Aucune rune ne correspond au filtre." : "Ajoute des items dans « Crafts suivis » pour voir les runes qu'ils donnent."}</td></tr>`;
    $("#res").innerHTML = list.length ? list.map(x => { const p = S.prix[x.rid], rc = !!S.rec[x.rid], pi = priceInfo(x.rid); return `<tr>
      <td class="l"><b>${esc(x.n)}</b></td><td class="l note">${esc([...new Set(x.its)].join(", "))}</td>
      <td><label class="chk"><input type="checkbox" id="rec-${x.rid}" data-rec="${x.rid}" ${rc ? "checked" : ""} aria-label="Je récolte ${esc(x.n)}"><span>récoltée</span></label></td>
      <td><input class="num ${phCls(pi, p)}" id="rp-${x.rid}" data-price="${x.rid}" data-col="rp" type="number" min="0" value="${p || ""}" placeholder="${phTxt(pi)}" title="${phTitle(pi)}" aria-label="Prix de ${esc(x.n)}"></td>
      <td class="m note">${p > 0 ? fdate(S.maj[x.rid]) : pi.src === "groupe" ? `<span class="grp-tag">groupe</span>` : "–"}</td></tr>`; }).join("")
      : `<tr><td colspan="5" class="empty">${S.suivi.length ? "Aucune ressource ne correspond au filtre." : "Ajoute des items dans « Crafts suivis » pour voir les ressources à acheter."}</td></tr>`;
  });
  $("#cRunes").textContent = runes.length;
}

// ----- Journal
function renderJr() {
  const sel = $("#jItem"), cur = sel.value;
  sel.innerHTML = S.suivi.length ? S.suivi.map(s => { const it = ITEMS.get(s.id); return `<option value="${s.id}">${esc(it ? it.n : s.id)}</option>`; }).join("") : `<option value="">Ajoute d'abord un item suivi</option>`;
  if (cur && S.suivi.some(s => String(s.id) === cur)) sel.value = cur;
  if (!$("#jBuy").value) $("#jBuy").value = today();
  if (!$("#jCost").dataset.touched) prefillCost();
  const J = [...S.journal].sort((a, b) => (b.achat || "").localeCompare(a.achat || ""));
  keepFocus(() => {
    $("#jr").innerHTML = J.length ? J.map(e => {
      const R = realize(e), ben = R ? R.ventes - (+e.cout || 0) : null, roi = R && e.cout > 0 ? ben / e.cout : null;
      const st = +e.encaisse > 0 ? ["s-done", "Vendu"] : +e.runes > 0 ? ["s-brk", "Brisé"] : ["s-run", "En stock"];
      const inp = (f, type, w, extra = "") => `<td style="width:${w}px"><input ${type === "date" ? "" : 'class="num"'} id="j${f}-${e._id}" data-j="${e._id}" data-f="${f}" data-col="j-${f}" type="${type}" ${type === "number" ? 'min="0"' : ""} value="${esc(e[f] || "")}" ${extra}></td>`;
      return `<tr><td class="l"><b>${esc(e.nom)}</b></td>
        ${inp("qte", "number", 64, 'aria-label="Quantité"')}${inp("achat", "date", 138, 'aria-label="Date d\'achat"')}${inp("cout", "number", 104, 'aria-label="Coût total"')}
        ${inp("brisage", "date", 138, 'aria-label="Date de brisage"')}${inp("runes", "number", 104, 'placeholder="kamas" aria-label="Valeur des runes"')}
        ${inp("vente", "date", 138, 'aria-label="Date de vente"')}${inp("encaisse", "number", 104, 'placeholder="kamas" aria-label="Kamas encaissés"')}
        <td class="m ${ben < 0 ? "neg" : ben > 0 ? "pos" : ""}">${R ? fmt(ben) : "–"}</td>
        <td>${roi != null ? `<span class="pill ${pillCls(roi)}">${pillTxt(roi)}</span>` : ""}</td>
        <td class="l"><span class="status ${st[0]}">${st[1]}</span>${!(+e.encaisse > 0) ? ` <button class="quick own-only" data-quick="${+e.runes > 0 ? "vendu" : "brise"}" data-jid="${e._id}" title="${+e.runes > 0 ? "Marquer vendu aujourd'hui (raccourci : V)" : "Marquer brisé aujourd'hui (raccourci : B)"}">${+e.runes > 0 ? "Vendu" : "Brisé"}</button>` : ""}</td>
        <td><button class="ghost x" data-jdel="${e._id}" aria-label="Supprimer la ligne" title="Supprimer">×</button></td></tr>`;
    }).join("") : `<tr><td colspan="12" class="empty">${isMe() ? "Aucune série enregistrée. Ajoute ton premier achat ci-dessus." : "Ce membre n'a encore enregistré aucune série."}</td></tr>`;
  });
  const done = J.filter(e => realize(e)), run = J.filter(e => !realize(e));
  const inv = done.reduce((a, e) => a + (+e.cout || 0), 0), rn = done.reduce((a, e) => a + realize(e).ventes, 0);
  const stock = run.reduce((a, e) => a + (+e.cout || 0), 0);
  $("#jtot").innerHTML = `<div class="tot"><span>Investi au total</span><b>${fmt(inv + stock)}</b></div>
    <div class="tot"><span>En attente de brisage</span><b>${fmt(stock)}</b><small class="note">${run.length} série(s)</small></div>
    <div class="tot"><span>Ventes / runes</span><b>${fmt(rn)}</b><small class="note">${done.length} série(s) brisée(s) ou vendue(s)</small></div>
    <div class="tot big"><span>Bénéfice réalisé</span><b>${done.length ? fmt(rn - inv) : "–"}</b></div>
    <div class="tot"><span>Rendement réalisé</span><b>${inv ? pillTxt((rn - inv) / inv) : "–"}</b></div>`;
  $("#jHint").hidden = !(run.length && isMe());
  $("#jHint").innerHTML = `<b>${run.length} série${run.length > 1 ? "s" : ""} en stock.</b> Une série ne compte dans le bénéfice qu'une fois brisée : clique <b>Brisé</b> (ou saisis la date et la valeur des runes), puis <b>Vendu</b> quand tu as encaissé.`;
  const arr = byItem(done);
  $("#realPanel").hidden = !arr.length;
  $("#real").innerHTML = arr.map(o => `<tr><td class="l"><b>${esc(o.k)}</b></td><td class="m">${o.n}</td><td class="m">${fmt(o.inv)}</td><td class="m">${fmt(o.rn)}</td><td class="m ${o.rn - o.inv < 0 ? "neg" : "pos"}">${fmt(o.rn - o.inv)}</td><td>${o.roi != null ? `<span class="pill ${pillCls(o.roi)}">${pillTxt(o.roi)}</span>` : ""}</td></tr>`).join("");
}
function prefillCost() {
  const s = S.suivi.find(x => String(x.id) === $("#jItem").value); const q = Math.max(1, +$("#jQty").value || 1);
  if (!s) { $("#jCost").value = ""; return; } const c = costOf(s); $("#jCost").value = c.cost ? Math.round(c.cost * q) : "";
}

// ---------------------------------------------------------------- tableau de bord
const GR = {
  jour: { n: 30, start: d => new Date(d.getFullYear(), d.getMonth(), d.getDate()), add: (d, k) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + k),
    lab: d => d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }), full: d => d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }), prev: "hier", cur: "Aujourd'hui", unit: "jour" },
  semaine: { n: 12, start: d => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)), add: (d, k) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 * k),
    lab: d => d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }), full: d => "Semaine du " + d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" }), prev: "la semaine dernière", cur: "Cette semaine", unit: "semaine" },
  mois: { n: 12, start: d => new Date(d.getFullYear(), d.getMonth(), 1), add: (d, k) => new Date(d.getFullYear(), d.getMonth() + k, 1),
    lab: d => d.toLocaleDateString("fr-FR", { month: "short", year: "2-digit" }), full: d => d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }), prev: "le mois dernier", cur: "Ce mois-ci", unit: "mois" },
  annee: { n: 5, start: d => new Date(d.getFullYear(), 0, 1), add: (d, k) => new Date(d.getFullYear() + k, 0, 1),
    lab: d => String(d.getFullYear()), full: d => String(d.getFullYear()), prev: "l'an dernier", cur: "Cette année", unit: "année" }
};
if (!GR[gran]) gran = "semaine";

function demoData() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pool = S.suivi.length ? S.suivi.map(s => ({ id: s.id, n: ITEMS.get(s.id)?.n || "Item" })) : [{ id: 11042, n: "Cordon Père au gnon" }, { id: 1504, n: "Dagues O'Bert" }, { id: 11375, n: "Slipapier" }];
  const base = pool.map((p, i) => ({ ...p, cost: [1800, 3400, 6500, 11000, 2600, 38000, 9000, 32000, 10500, 6100, 6500, 3300, 600][i % 13], mu: [1.6, 1.9, .7, .6, 1.1, .55, .4, .3, .65, .8, .35, 2.1, 2.4][i % 13] }));
  const out = []; const now = new Date(); const day = k => isoD(new Date(now.getFullYear(), now.getMonth(), now.getDate() - k));
  for (let k = 150; k >= 0; k--) {
    const n = rnd() < .35 ? 0 : 1 + Math.floor(rnd() * 2.4);
    for (let j = 0; j < n; j++) {
      const it = base[Math.floor(rnd() * Math.min(base.length, 8))], q = 1 + Math.floor(rnd() * 5);
      const cout = Math.round(it.cost * q * (.9 + rnd() * .25));
      const decay = 1 - Math.max(0, (150 - k) / 150) * .35 * (it.mu > 1.2 ? 1 : 0);
      const roi = it.mu * decay * (.6 + rnd() * .8) - (rnd() < .08 ? .9 : 0);
      const bk = k - Math.floor(rnd() * 3), vk = bk - Math.floor(rnd() * 4);
      const e = { _id: "d" + k + "-" + j, item: it.id, nom: it.n, qte: q, cout, achat: day(k), brisage: "", runes: 0, vente: "", encaisse: 0 };
      if (bk >= 0) { e.brisage = day(bk); e.runes = Math.round(cout * (1 + roi)); if (vk >= 0 && rnd() < .85) { e.vente = day(vk); e.encaisse = Math.round(e.runes * (.93 + rnd() * .07)); } }
      out.push(e);
    }
  }
  return out;
}
function hexA(h, a) { h = (h || "").trim(); if (h.startsWith("#")) { let x = h.slice(1); if (x.length === 3) x = x.split("").map(c => c + c).join(""); const n = parseInt(x, 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; } return h; }
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const kfmt = n => { const a = Math.abs(n); return a >= 1e6 ? (n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " M" : a >= 1e4 ? Math.round(n / 1e3).toLocaleString("fr-FR") + " k" : fmt(n); };
function chartBase() {
  const fg = css("--fg"), bg = css("--surface"), line = css("--line");
  Chart.defaults.font.family = css("--body") || "system-ui"; Chart.defaults.color = css("--muted");
  return { tip: { backgroundColor: fg, titleColor: bg, bodyColor: bg, padding: 10, cornerRadius: 6, displayColors: false, titleFont: { weight: "700" } }, grid: { color: hexA(line, .7), drawTicks: false }, anim: matchMedia("(prefers-reduced-motion: reduce)").matches ? false : { duration: 300 } };
}
function killChart(k) { if (charts[k]) { charts[k].destroy(); delete charts[k]; } }

function renderDash() {
  const real = S.journal.length > 0;
  const J = real ? S.journal : (isMe() && demoOn ? demoData() : []);
  $("#demoBanner").hidden = real || !demoOn || !isMe();
  document.querySelectorAll("[data-g]").forEach(b => b.setAttribute("aria-pressed", b.dataset.g === gran));
  const G = GR[gran], now = new Date(), cur = G.start(now);
  const keys = []; for (let k = G.n - 1; k >= 0; k--) keys.push(G.add(cur, -k));
  if (gran === "annee") { const first = J.reduce((m, e) => { const d = pD(e.achat); return d && d < m ? d : m; }, now); while (keys.length > 1 && keys[0] < G.start(first)) keys.shift(); }
  const idx = new Map(keys.map((d, i) => [isoD(d), i]));
  const B = keys.map(d => ({ d, ventes: 0, cout: 0, ben: 0, n: 0 }));
  const prevKey = isoD(G.add(cur, -1)); const prev = { ventes: 0, ben: 0, cout: 0 };
  for (const e of J) {
    const R = realize(e); if (!R) continue; const rd = pD(R.date); if (!rd) continue;
    const k = isoD(G.start(rd)), i = idx.get(k), b = R.ventes - (+e.cout || 0);
    if (i != null) { B[i].ventes += R.ventes; B[i].cout += +e.cout || 0; B[i].ben += b; B[i].n++; }
    if (k === prevKey) { prev.ventes += R.ventes; prev.ben += b; prev.cout += +e.cout || 0; }
  }
  const C = B[B.length - 1];
  const pend = J.filter(e => !realize(e)), stock = pend.reduce((a, e) => a + (+e.cout || 0), 0);
  const totalBen = J.reduce((a, e) => { const R = realize(e); return R ? a + R.ventes - (+e.cout || 0) : a; }, 0);
  $("#dashRange").textContent = `${G.full(keys[0])} → ${G.full(keys[keys.length - 1])}`;
  $("#hBen").textContent = "Bénéfice par " + G.unit;
  const delta = (a, b) => { if (!b) return a ? `<span>Rien ${G.prev}</span>` : "–"; const r = (a - b) / Math.abs(b); return `<span class="delta ${r >= 0 ? "d-up" : "d-down"}">${r >= 0 ? "▲ +" : "▼ "}${Math.round(r * 100)} %</span>vs ${G.prev}`; };
  const marge = C.cout ? C.ben / C.cout : null, margeP = prev.cout ? prev.ben / prev.cout : null;
  $("#kpis").innerHTML = `
    <div class="kpi hero"><span class="k-l">Bénéfice · ${G.cur.toLowerCase()}</span><span class="k-v ${C.ben < 0 ? "neg" : ""}">${C.ben > 0 ? "+" : ""}${fmt(C.ben)}<small>kamas</small></span><span class="k-d">${delta(C.ben, prev.ben)}</span></div>
    <div class="kpi"><span class="k-l">Ventes encaissées</span><span class="k-v">${fmt(C.ventes)}</span><span class="k-d">${delta(C.ventes, prev.ventes)}</span></div>
    <div class="kpi"><span class="k-l">Marge sur coût</span><span class="k-v">${marge != null ? pillTxt(marge) : "–"}</span><span class="k-d">${margeP != null ? `${pillTxt(margeP)} ${G.prev}` : "&nbsp;"}</span></div>
    <div class="kpi"><span class="k-l">Capital en stock</span><span class="k-v">${fmt(stock)}</span><span class="k-d">${pend.length} série(s) à briser ou vendre</span></div>
    <div class="kpi"><span class="k-l">Bénéfice total</span><span class="k-v ${totalBen < 0 ? "neg" : ""}">${fmt(totalBen)}</span><span class="k-d">${J.length - pend.length} séries réalisées</span></div>`;
  $("#tPer").innerHTML = [...B].reverse().map(b => `<tr><td class="l">${G.full(b.d)}</td><td class="m">${fmt(b.ventes)}</td><td class="m">${fmt(b.cout)}</td><td class="m ${b.ben < 0 ? "neg" : b.ben > 0 ? "pos" : ""}">${fmt(b.ben)}</td><td class="m">${b.cout ? pillTxt(b.ben / b.cout) : "–"}</td><td class="m">${b.n}</td></tr>`).join("");
  drawDashCharts(B, G, J); renderItemBars(J); renderHeat(J); renderAlerts(J);
}
function drawDashCharts(B, G, J) {
  killChart("ben"); killChart("cum");
  if (!window.Chart) return;
  const { tip, grid, anim } = chartBase(); const acc = css("--accent"), good = css("--good"), bad = css("--bad"), bg = css("--surface");
  charts.ben = new Chart($("#chBen"), { type: "bar",
    data: { labels: B.map(b => G.lab(b.d)), datasets: [{ data: B.map(b => Math.round(b.ben)), backgroundColor: B.map(b => b.ben < 0 ? bad : good), hoverBackgroundColor: B.map(b => b.ben < 0 ? bad : good), borderRadius: 5, borderSkipped: "start", maxBarThickness: 30, categoryPercentage: .8, barPercentage: .85 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: anim,
      plugins: { legend: { display: false }, tooltip: { ...tip, callbacks: { title: it => G.full(B[it[0].dataIndex].d), label: it => { const b = B[it.dataIndex]; return [`Bénéfice : ${fmt(b.ben)}`, `Ventes : ${fmt(b.ventes)}`, `Coût : ${fmt(b.cout)}`, `${b.n} série(s)`]; } } } },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 10 } }, y: { grid, border: { display: false }, ticks: { padding: 8, callback: v => kfmt(v) } } } } });
  const ev = J.map(e => { const R = realize(e); return R ? { d: R.date, b: R.ventes - (+e.cout || 0) } : null; }).filter(Boolean).sort((a, b) => a.d.localeCompare(b.d));
  const pts = []; let s = 0; for (const x of ev) { s += x.b; if (pts.length && pts[pts.length - 1].d === x.d) pts[pts.length - 1].v = s; else pts.push({ d: x.d, v: s }); }
  charts.cum = new Chart($("#chCum"), { type: "line",
    data: { labels: pts.map(p => pD(p.d).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" })), datasets: [{ data: pts.map(p => Math.round(p.v)), borderColor: acc, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: acc, pointHoverBorderColor: bg, pointHoverBorderWidth: 2, tension: .25, fill: { target: "origin", above: hexA(acc, .14), below: hexA(bad, .14) } }] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, animation: false,
      plugins: { legend: { display: false }, tooltip: { ...tip, callbacks: { title: it => pD(pts[it[0].dataIndex].d).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }), label: it => "Cumul : " + fmt(it.raw) } } },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 24 } }, y: { grid, border: { display: false }, ticks: { padding: 8, callback: v => kfmt(v) } } } } });
}
function renderItemBars(J) {
  const arr = byItem(J).slice(0, 8);
  if (!arr.length) { $("#itemBars").innerHTML = '<p class="empty">Aucune série brisée ou vendue pour l\'instant.</p>'; return; }
  const est = new Map(S.suivi.map(s => [s.id, statsOf(s).roi]));
  const mx = Math.max(.5, ...arr.map(o => Math.abs(o.roi || 0)), ...arr.map(o => Math.abs(est.get(o.item) ?? 0)));
  $("#itemBars").innerHTML = arr.map(o => { const e = est.get(o.item); const w = Math.min(100, Math.abs(o.roi) / mx * 100);
    return `<div class="ibar" title="${esc(o.k)} : ${o.n} série(s), ${fmt(o.rn - o.inv)} de bénéfice${e != null ? `, estimé ${pillTxt(e)}` : ""}">
      <span class="nm">${esc(o.k)}</span>
      <span class="track"><span class="fill ${o.roi < 0 ? "neg" : ""}" style="width:${w}%"></span>${e != null && e > 0 ? `<span class="est" style="left:calc(${Math.min(100, e / mx * 100)}% - 1px)"></span>` : ""}</span>
      <span class="v ${o.roi < 0 ? "neg" : ""}">${pillTxt(o.roi)}</span></div>`; }).join("");
}
function renderHeat(J) {
  const day = new Map();
  for (const e of J) { const R = realize(e); if (!R) continue; day.set(R.date, (day.get(R.date) || 0) + R.ventes - (+e.cout || 0)); }
  const now = new Date(), end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = GR.semaine.add(GR.semaine.start(end), -25);
  const vals = [...day.values()].filter(v => v > 0).sort((a, b) => a - b);
  const q = p => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 1;
  const th = [q(.25), q(.5), q(.75)]; const acc = css("--good"), bad = css("--bad");
  const shade = v => v < 0 ? hexA(bad, .75) : v > 0 ? hexA(acc, v <= th[0] ? .25 : v <= th[1] ? .5 : v <= th[2] ? .75 : 1) : "";
  let h = ""; const stop = GR.semaine.add(GR.semaine.start(end), 1);
  for (let d = new Date(start); d < stop; d = GR.jour.add(d, 1)) {
    if (d > end) { h += `<span class="c out"></span>`; continue; }
    const k = isoD(d), v = day.get(k);
    h += `<span class="c" data-tip="${d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })} : ${v != null ? fmt(v) + " de bénéfice" : "aucune vente"}" ${v != null ? `style="background:${shade(v)}"` : ""}></span>`;
  }
  $("#heat").innerHTML = h;
  $("#heatLegend").innerHTML = `<span><i style="background:${hexA(bad, .75)}"></i>Perte</span><span>Moins</span>${[.25, .5, .75, 1].map(a => `<i style="background:${hexA(acc, a)};margin:0"></i>`).join("")}<span>Plus</span>`;
}
function renderAlerts(J) {
  const A = []; const now = new Date(); const days = s => { const d = pD(s); return d ? Math.floor((now - d) / 864e5) : 0; };
  const pl = (n, s, p) => n > 1 ? p : s;
  const dorm = J.filter(e => !realize(e) && days(e.achat) > 7);
  if (dorm.length) A.push(["c-warn", "Stock", `${dorm.length} ${pl(dorm.length, "série achetée", "séries achetées")} il y a plus de 7 jours ${pl(dorm.length, "attend", "attendent")} d'être ${pl(dorm.length, "brisée", "brisées")} : ${fmt(dorm.reduce((a, e) => a + (+e.cout || 0), 0))} kamas immobilisés.`]);
  const unsold = J.filter(e => !(+e.encaisse > 0) && +e.runes > 0 && days(e.brisage) > 5);
  if (unsold.length) A.push(["c-info", "Runes", `${unsold.length} ${pl(unsold.length, "brisage", "brisages")} de plus de 5 jours sans vente saisie : leurs runes sont comptées à leur valeur estimée.`]);
  const est = new Map(S.suivi.map(s => [s.id, statsOf(s).roi]));
  for (const o of byItem(J)) {
    const r = o.rows.sort((a, b) => a.d.localeCompare(b.d));
    if (r.length >= 3) { const last = r[r.length - 1].roi, avg = r.slice(0, -1).reduce((a, x) => a + x.roi, 0) / (r.length - 1);
      if (avg - last > .3) { A.push(["c-bad", "Coefficient", `${o.k} : dernière série à ${pillTxt(last)} contre ${pillTxt(avg)} en moyenne. Le coefficient de brisage baisse peut-être, vérifie-le avant de relancer.`]); continue; } }
    const e = est.get(o.item); if (e != null && o.n >= 2 && e - o.roi > .4) A.push(["c-warn", "Écart", `${o.k} rapporte ${pillTxt(o.roi)} en réel contre ${pillTxt(e)} estimé. Mets à jour sa valeur de brisage.`]);
  }
  const old = new Set(); for (const s of S.suivi) for (const [rid] of recipeOf(s)) { const m = S.maj[rid]; if (!(S.prix[rid] > 0) || !m || days(m) > 7) old.add(rid); }
  const oldR = new Set(); for (const s of S.suivi) for (const [a] of D.fx?.[s.id] || []) { const m = S.rm[a]; if (!(S.rp[a] > 0) || !m || days(m) > 7) oldR.add(a); }
  if (oldR.size && !S.suivi.every(s => +s.brk > 0)) A.push(["c-info", "Runes", `${oldR.size} ${pl(oldR.size, "prix de rune manque ou date", "prix de runes manquent ou datent")} de plus de 7 jours : les brisages estimés en dépendent.`]);
  if (old.size) A.push(["c-info", "Prix", `${old.size} ${pl(old.size, "prix de ressource manque ou date", "prix de ressources manquent ou datent")} de plus de 7 jours. Les estimations en dépendent.`]);
  const recent = new Set(J.filter(e => days(e.achat) <= 14).map(e => e.item));
  const best = S.suivi.map(s => ({ s, ...statsOf(s) })).filter(x => x.ok && x.roi > 0 && !recent.has(x.s.id)).sort((a, b) => b.roi - a.roi)[0];
  if (best) A.push(["c-good", "Opportunité", `${ITEMS.get(best.s.id)?.n} est estimé à ${pillTxt(best.roi)} et n'a pas été crafté depuis 14 jours.`]);
  const dm = new Map(); for (const e of J) { const R = realize(e); if (!R || !R.date.startsWith(today().slice(0, 7))) continue; dm.set(R.date, (dm.get(R.date) || 0) + R.ventes - (+e.cout || 0)); }
  const top = [...dm.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] > 0) A.push(["c-good", "Record", `Meilleur jour du mois : ${pD(top[0]).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric" })} avec ${fmt(top[1])} de bénéfice.`]);
  $("#alerts").innerHTML = A.length ? A.slice(0, 7).map(([c, l, t]) => `<li><span class="chip ${c}">${l}</span><span>${esc(t)}</span></li>`).join("") : `<li class="empty">Rien à signaler.</li>`;
}

// ---------------------------------------------------------------- le groupe
function renderGroup() {
  document.querySelectorAll("[data-gg]").forEach(b => b.setAttribute("aria-pressed", b.dataset.gg === ggran));
  const now = new Date();
  const from = ggran === "tout" ? null : GR[ggran].start(now);
  const lab = { semaine: "cette semaine", mois: "ce mois-ci", annee: "cette année", tout: "depuis le début" }[ggran];
  $("#hGrpBar").textContent = "Classement · " + lab;
  const M = membersSorted().map(([uid, m]) => {
    let ven = 0, cout = 0, n = 0, last = "";
    for (const e of m.journal) {
      const R = realize(e); const dts = [e.achat, e.brisage, e.vente].filter(Boolean).sort(); if (dts.length && dts[dts.length - 1] > last) last = dts[dts.length - 1];
      if (!R) continue; const d = pD(R.date); if (from && (!d || d < from)) continue;
      ven += R.ventes; cout += +e.cout || 0; n++;
    }
    const stock = m.journal.filter(e => !realize(e)).reduce((a, e) => a + (+e.cout || 0), 0);
    const per = m.journal.filter(e => { const R = realize(e); const d = R && pD(R.date); return R && (!from || (d && d >= from)); });
    const bi = byItem(per)[0];
    return { uid, m, ven, cout, ben: ven - cout, roi: cout ? (ven - cout) / cout : null, n, stock, best: bi, last };
  });
  // barres
  const mx = Math.max(1, ...M.map(x => Math.abs(x.ben))); const hasNeg = M.some(x => x.ben < 0);
  const sorted = [...M].sort((a, b) => b.ben - a.ben);
  $("#grpBars").innerHTML = sorted.length ? sorted.map((x, rk) => {
    const w = Math.abs(x.ben) / mx * (hasNeg ? 50 : 100), left = hasNeg ? (x.ben >= 0 ? 50 : 50 - w) : 0;
    return `<div class="gbar" title="${esc(x.m.p.pseudo)} : ${fmt(x.ben)} de bénéfice ${lab}"><span class="rank">${rk + 1}</span><span class="nm">${esc(x.m.p.pseudo)}</span>
      <span class="track">${hasNeg ? '<span class="axis" style="left:50%"></span>' : ""}<span class="fill" style="left:${left}%;width:${Math.max(w, x.ben ? 1 : 0)}%;background:${colorOf(x.uid)}"></span></span>
      <span class="v ${x.ben < 0 ? "neg" : ""}">${fmt(x.ben)}</span></div>`; }).join("") : '<p class="empty">Aucun membre pour l\'instant.</p>';
  // tableau
  $("#grpRows").innerHTML = M.map(x => `<tr data-uid="${x.uid}">
    <td class="l"><div class="mname"><span class="avatar" style="background:${colorOf(x.uid)}">${esc(initials(x.m.p.pseudo))}</span><span>${esc(x.m.p.pseudo)}${x.uid === ME ? '<span class="you">moi</span>' : ""}<small>${esc(x.m.p.serveur || "")}</small></span></div></td>
    <td class="m ${x.ben < 0 ? "neg" : x.ben > 0 ? "pos" : ""}">${fmt(x.ben)}</td><td class="m">${fmt(x.ven)}</td>
    <td>${x.roi != null ? `<span class="pill ${pillCls(x.roi)}">${pillTxt(x.roi)}</span>` : "–"}</td>
    <td class="m">${x.n}</td><td class="m">${fmt(x.stock)}</td>
    <td class="l">${x.best ? `${esc(x.best.k)} <span class="note">${pillTxt(x.best.roi)}</span>` : "–"}</td>
    <td class="l note">${x.last ? fdate(x.last) : "–"}</td></tr>`).join("");
  // courbes cumulées 12 semaines
  killChart("grp"); if (!window.Chart) return;
  const G = GR.semaine, cur = G.start(now); const wk = []; for (let k = 11; k >= 0; k--) wk.push(G.add(cur, -k));
  const ds = membersSorted().map(([uid, m]) => {
    const per = wk.map(() => 0);
    for (const e of m.journal) { const R = realize(e); if (!R) continue; const d = pD(R.date); if (!d) continue; const i = wk.findIndex((w, j) => d >= w && (j === wk.length - 1 || d < wk[j + 1])); if (i >= 0) per[i] += R.ventes - (+e.cout || 0); }
    let s = 0; const c = colorHex(uid);
    return { label: m.p.pseudo, data: per.map(v => Math.round(s += v)), borderColor: c, backgroundColor: c, borderWidth: 2, pointRadius: 3, pointHoverRadius: 6, pointBorderColor: css("--surface"), pointBorderWidth: 1.5, tension: .2 };
  });
  $("#grpLegend").innerHTML = membersSorted().map(([uid, m]) => `<span><i style="background:${colorOf(uid)}"></i>${esc(m.p.pseudo)}</span>`).join("");
  const { tip, grid, anim } = chartBase();
  charts.grp = new Chart($("#chGrp"), { type: "line", data: { labels: wk.map(w => w.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })), datasets: ds },
    options: { responsive: true, maintainAspectRatio: false, animation: anim, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { ...tip, displayColors: true, boxPadding: 4, callbacks: { title: it => "Semaine du " + wk[it[0].dataIndex].toLocaleDateString("fr-FR", { day: "numeric", month: "long" }), label: it => `${it.dataset.label} : ${fmt(it.raw)}` } } },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 0 } }, y: { grid, border: { display: false }, ticks: { padding: 8, callback: v => kfmt(v) } } } } });
}
$("#grpRows").addEventListener("click", e => { const tr = e.target.closest("[data-uid]"); if (!tr) return; setView(tr.dataset.uid); setTab("dash"); window.scrollTo({ top: 0, behavior: "smooth" }); });
document.querySelectorAll("[data-gg]").forEach(b => b.addEventListener("click", () => { ggran = b.dataset.gg; lsSet("ggran", ggran); renderGroup(); }));

// ---------------------------------------------------------------- recherche d'items
let hits = [], hl = 0;
function search(v) {
  const f = norm(v.trim()); const box = $("#qres");
  if (f.length < 2) { box.hidden = true; return; }
  const toks = f.split(/\s+/);
  hits = D.items.filter(it => toks.every(t => it.nn.includes(t))).slice(0, 14); hl = 0;
  box.innerHTML = hits.length ? hits.map((it, i) => `<li data-add="${it.id}" class="${i === 0 ? "hl" : ""}"><span>${esc(it.n)}${S.suivi.some(s => s.id === it.id) ? " ✓" : ""}</span><small>Niv. ${it.l} · ${esc(D.types[it.t] || "")}</small></li>`).join("") : `<li class="note">Aucun item craftable trouvé</li>`;
  box.hidden = false;
}
function addItem(id) {
  if (!isMe()) return;
  const it = ITEMS.get(id); $("#qres").hidden = true; $("#q").value = "";
  if (S.suivi.some(s => s.id === id)) { toast(`${it.n} est déjà suivi`); return; }
  S.suivi.push({ id, brk: 0 }); open.add(id); Store.saveSuivi(); render(); toast(`${it.n} ajouté`);
}
$("#q").addEventListener("input", e => search(e.target.value));
$("#q").addEventListener("keydown", e => {
  const box = $("#qres"); if (box.hidden || !hits.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); hl = (hl + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length; [...box.children].forEach((li, i) => li.classList.toggle("hl", i === hl)); }
  if (e.key === "Enter") { e.preventDefault(); addItem(hits[hl].id); }
  if (e.key === "Escape") box.hidden = true;
});
$("#qres").addEventListener("mousedown", e => { const li = e.target.closest("[data-add]"); if (li) { e.preventDefault(); addItem(+li.dataset.add); } });
$("#q").addEventListener("blur", () => setTimeout(() => $("#qres").hidden = true, 120));

// ---------------------------------------------------------------- saisie
let softT; function softCrafts() { clearTimeout(softT); softT = setTimeout(() => { if (tab === "crafts") { renderCrafts(); applyRO(); } }, 450); }
function setPrice(rid, v) {
  pendingPrix.add("prix:" + rid); const n = +v || 0;
  if (n > 0) S.prix[rid] = n; else delete S.prix[rid]; S.maj[rid] = today();
  later("prix", () => Store.savePrix());
}
function setRuneP(a, v) { pendingPrix.add("rp:" + a); const n = +v || 0; if (n > 0) S.rp[a] = n; else delete S.rp[a]; S.rm[a] = today(); later("prix", () => Store.savePrix()); }
function setRunePts(a, v) { pendingPrix.add("rpt:" + a); const n = Math.max(1, Math.round(+v || 0)); if (n !== D.stats[a]?.[2]) S.rpt[a] = n; else delete S.rpt[a]; later("prix", () => Store.savePrix()); }
function setCfg(k, v) { pendingPrix.add("cfg:"); S.cfg = { ...S.cfg, [k]: v }; later("prix", () => Store.savePrix()); }
document.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "budget" || t.id === "maxq" || t.id === "dropPct") { lsSet(t.id, t.value); renderCrafts(); applyRO(); return; }
  if (t.id === "rq") { rfilter = t.value; renderRes(); applyRO(); return; }
  if (!isMe()) return;
  if (t.dataset.price) { setPrice(t.dataset.price, t.value); t.classList.toggle("miss", !(+t.value > 0)); if (tab === "crafts") softCrafts(); return; }
  if (t.dataset.runep) { setRuneP(t.dataset.runep, t.value); t.classList.toggle("miss", !(+t.value > 0)); if (tab === "crafts") softCrafts(); return; }
  if (t.dataset.runepts) { setRunePts(t.dataset.runepts, t.value); return; }
  if (t.dataset.coef) { const s = S.suivi.find(x => x.id === +t.dataset.coef); s.coef = t.value === "" ? 100 : Math.min(4000, Math.max(0, +t.value || 0)); saveSuiviLater(); softCrafts(); return; }
  if (t.id === "cfgTaxe") { setCfg("taxe", Math.min(50, Math.max(0, +t.value || 0))); return; }
  if (t.dataset.brk) { const s = S.suivi.find(x => x.id === +t.dataset.brk); s.brk = +t.value || 0; saveSuiviLater(); softCrafts(); return; }
  if (t.dataset.rq) { const s = S.suivi.find(x => x.id === +t.dataset.rq); if (!s.r) s.r = recipeOf(s).map(([i, q]) => ({ i, q })); s.r[+t.dataset.k].q = Math.max(1, +t.value || 1); saveSuiviLater(); softCrafts(); return; }
  if (t.dataset.j) {
    const f = t.dataset.f; const v = (f === "achat" || f === "brisage" || f === "vente") ? t.value : (+t.value || 0);
    const e0 = S.journal.find(j => j._id === t.dataset.j); if (e0) e0[f] = v;
    pendingJ.set(t.dataset.j, { ...(pendingJ.get(t.dataset.j) || {}), [f]: v });   // protégé tout de suite
    later("j" + t.dataset.j + f, () => Store.updJr(t.dataset.j, { [f]: v }), 400); return;
  }
  if (t.id === "jQty" && !$("#jCost").dataset.touched) prefillCost();
  if (t.id === "jCost") t.dataset.touched = "1";
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.price || t.dataset.brk || t.dataset.rq || t.dataset.runep || t.dataset.runepts || t.dataset.coef || t.id === "cfgTaxe") render();
  if (t.dataset.rec && isMe()) { pendingPrix.add("rec:" + t.dataset.rec); if (t.checked) S.rec[t.dataset.rec] = true; else delete S.rec[t.dataset.rec]; Store.savePrix(); render(); }
  if (t.id === "cfgRecolte" && isMe()) { setCfg("recolte", t.value); Store.savePrix(); render(); }
  if (t.dataset.j) { renderJr(); applyRO(); }
  if (t.id === "jItem") { delete $("#jCost").dataset.touched; prefillCost(); }
});
$("#crafts").addEventListener("click", e => {
  const t = e.target; if (t.closest("input")) return;
  const del = t.closest("[data-del]");
  if (del) { if (!isMe()) return; const id = +del.dataset.del; const it = ITEMS.get(id); S.suivi = S.suivi.filter(s => s.id !== id); open.delete(id); Store.saveSuivi(); render(); toast(`${it ? it.n : "Item"} retiré`); return; }
  const rd = t.closest("[data-rdel]");
  if (rd) { if (!isMe()) return; const s = S.suivi.find(x => x.id === +rd.dataset.rdel); if (!s.r) s.r = recipeOf(s).map(([i, q]) => ({ i, q })); s.r.splice(+rd.dataset.k, 1); Store.saveSuivi(); render(); return; }
  const rr = t.closest("[data-rreset]");
  if (rr) { if (!isMe()) return; const s = S.suivi.find(x => x.id === +rr.dataset.rreset); delete s.r; Store.saveSuivi(); render(); toast("Recette du jeu restaurée"); return; }
  const sb = t.closest("[data-serie]"); if (sb) { quickSerie(+sb.dataset.serie); return; }
  const tr = t.closest("tr.item"); if (tr) { const id = +tr.dataset.id; open.has(id) ? open.delete(id) : open.add(id); renderCrafts(); applyRO(); }
});
function jErr(m) { let el = $("#jErr"); if (!el) { el = document.createElement("p"); el.id = "jErr"; el.className = "err"; el.setAttribute("role", "alert"); $("#jform").after(el); } el.textContent = m; el.hidden = !m; }
$("#jform").addEventListener("submit", e => {
  e.preventDefault(); if (!isMe()) return; const id = +$("#jItem").value; if (!id) { jErr("Ajoute d'abord un item dans Crafts suivis : le journal ne liste que tes items suivis."); return; }
  const it = ITEMS.get(id); const qte = Math.max(1, +$("#jQty").value || 1); const cout = +$("#jCost").value || 0;
  if (!cout) { jErr("Indique le coût total de la série (les prix des ressources de cet item ne sont pas tous renseignés, donc il n'a pas pu être calculé)."); $("#jCost").classList.add("miss"); $("#jCost").focus(); return; }
  jErr(""); $("#jCost").classList.remove("miss");
  Store.addJr({ item: id, nom: it.n, qte, cout, achat: $("#jBuy").value || today(), brisage: "", runes: 0, vente: "", encaisse: 0 });
  delete $("#jCost").dataset.touched; $("#jQty").value = 1; prefillCost(); toast("Série ajoutée au journal");
});
$("#jr").addEventListener("click", e => {
  const q = e.target.closest("[data-quick]"); if (q && isMe()) { quickJr(q.dataset.jid, q.dataset.quick); return; }
  const b = e.target.closest("[data-jdel]"); if (!b || !isMe()) return;
  if (b.dataset.armed) { Store.delJr(b.dataset.jdel); toast("Ligne supprimée"); return; }
  b.dataset.armed = "1"; b.textContent = "Supprimer ?"; b.style.color = "var(--bad)";
  setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "×"; b.style.color = ""; } }, 3000);
});
document.querySelectorAll("[data-g]").forEach(b => b.addEventListener("click", () => { gran = b.dataset.g; lsSet("gran", gran); renderDash(); }));
$("#demoToggle").addEventListener("click", () => { demoOn = false; renderDash(); });

// ---------------------------------------------------------------- export / import
$("#btnData").addEventListener("click", () => { $("#dataPanel").hidden = !$("#dataPanel").hidden; });
$("#btnDataClose").addEventListener("click", () => { $("#dataPanel").hidden = true; });
$("#btnExport").addEventListener("click", () => {
  const me = member(ME);
  const data = { format: "atelier-brisage", version: 1, exporte: new Date().toISOString(), pseudo: MYPROFILE.pseudo, suivi: me.suivi, prix: { p: me.prix, m: me.maj, rp: me.rp, rm: me.rm, rpt: me.rpt, r: me.rec, cfg: me.cfg }, journal: me.journal.map(({ _id, ...e }) => e) };
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  a.download = `atelier-brisage-${MYPROFILE.pseudo}-${today()}.json`; document.body.appendChild(a); a.click(); a.remove();
  toast("Fichier exporté");
});
$("#fileImport").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = "";
  try {
    await importData(JSON.parse(await f.text()));
  } catch (x) { console.error(x); toast("Fichier non reconnu : importe un fichier exporté par l'Atelier de brisage"); }
});
async function importData(d) {
    if (d.format !== "atelier-brisage") throw new Error("format");
    const me = member(ME); let ni = 0, nj = 0;
    for (const s of d.suivi || []) { if (!me.suivi.some(x => x.id === s.id)) { me.suivi.push({ ...s }); ni++; } }
    if (d.prix?.p) { Object.assign(me.prix, d.prix.p); Object.assign(me.maj, d.prix.m || {}); Object.assign(me.rp, d.prix.rp || {}); Object.assign(me.rm, d.prix.rm || {}); Object.assign(me.rpt, d.prix.rpt || {}); Object.assign(me.rec, d.prix.r || {}); if (d.prix.cfg) me.cfg = { ...me.cfg, ...d.prix.cfg }; }
    const wasView = VIEW; VIEW = ME; S = me;
    Store.saveSuivi(); Store.savePrix();
    const batch = db.batch();
    for (const j of d.journal || []) { batch.set(db.collection(`profiles/${ME}/journal`).doc(), j); nj++; }
    if (nj) await batch.commit();
    VIEW = wasView; S = member(VIEW); render();
    toast(`Import terminé : ${ni} item(s), ${nj} série(s)`);
}

// ---------------------------------------------------------------- saisie rapide
function quickSerie(id) {
  if (!isMe()) return; const s = S.suivi.find(x => x.id === id); const it = ITEMS.get(id); if (!s || !it) return;
  const c = costOf(s);
  Store.addJr({ item: id, nom: it.n, qte: 1, cout: c.miss ? 0 : Math.round(c.cost), achat: today(), brisage: "", runes: 0, vente: "", encaisse: 0 });
  toast(c.miss ? `Série de ${it.n} ajoutée : complète son coût dans le journal` : `Série de ${it.n} ajoutée au journal (${fmt(c.cost)})`);
}
function quickJr(jid, kind) {
  const e = S.journal.find(j => j._id === jid); if (!e) return;
  if (kind === "brise") {
    const s = S.suivi.find(x => x.id === e.item); const st = s ? statsOf(s) : null;
    const runes = st && st.gross ? Math.round(st.gross * (e.qte || 1)) : 0;
    const patch = { brisage: today(), ...(runes ? { runes } : {}) }; Object.assign(e, patch); Store.updJr(jid, patch); renderJr(); applyRO();
    if (!runes) { const el = document.getElementById("jruns-" + jid) || document.getElementById("jrunes-" + jid); el?.focus(); toast("Brisé aujourd'hui : saisis la valeur des runes"); }
    else toast(`Brisé aujourd'hui · runes estimées ${fmt(runes)}`);
  } else {
    const enc = Math.round((+e.runes || 0) * (1 - taxe()));
    const patch = { vente: today(), encaisse: enc }; Object.assign(e, patch); Store.updJr(jid, patch); renderJr(); applyRO();
    const el = document.getElementById("jencaisse-" + jid); el?.focus(); el?.select();
    toast(`Vendu aujourd'hui · ${fmt(enc)} encaissés (taxe déduite). Corrige si besoin.`);
  }
}

// ---------------------------------------------------------------- clavier façon tableur
// Tab / Entrée : case suivante dans la même colonne · Maj+Tab / Maj+Entrée : case précédente
// ↑ / ↓ : idem dans les cases numériques
function colCells(el) {
  const col = el.dataset.col; const scope = el.closest("table, .recipe") || document;
  return [...scope.querySelectorAll(`[data-col="${CSS.escape(col)}"]`)].filter(x => !x.disabled && x.offsetParent !== null);
}
document.addEventListener("keydown", e => {
  const el = e.target;
  if (el.matches?.("input[data-col]") && !e.altKey && !e.ctrlKey && !e.metaKey) {
    const isNum = el.type === "number";
    let dir = 0;
    if (e.key === "Tab" || e.key === "Enter") dir = e.shiftKey ? -1 : 1;
    else if (isNum && e.key === "ArrowDown") dir = 1; else if (isNum && e.key === "ArrowUp") dir = -1;
    if (dir) {
      const cells = colCells(el); const i = cells.indexOf(el); const nx = cells[i + dir];
      if (nx) { e.preventDefault(); el.dispatchEvent(new Event("change", { bubbles: true })); const target = document.getElementById(nx.id) || nx; target.focus(); try { target.select(); } catch (x) { } return; }
      if (e.key === "Enter") { e.preventDefault(); el.blur(); return; }
    }
  }
  // raccourcis globaux (hors saisie)
  if (el.matches?.("input,select,textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!$("#app") || $("#app").hidden) return;
  const k = e.key;
  if (["1", "2", "3", "4", "5"].includes(k)) { setTab(["dash", "grp", "crafts", "res", "jr"][+k - 1]); e.preventDefault(); }
  else if (k === "/") { e.preventDefault(); if (!isMe()) setView(ME); setTab("crafts"); $("#q").focus(); }
  else if (k === "n" || k === "N") { e.preventDefault(); if (!isMe()) setView(ME); setTab("jr"); $("#jItem").focus(); }
  else if (k === "?") { e.preventDefault(); $("#helpPanel").hidden = false; }
  else if (k === "Escape") { $("#helpPanel").hidden = true; }
  else if ((k === "b" || k === "v") && tab === "jr" && isMe()) {
    const btn = el.closest?.("tr")?.querySelector(`[data-quick="${k === "b" ? "brise" : "vendu"}"]`); if (btn) { e.preventDefault(); btn.click(); }
  }
});
$("#planAll").addEventListener("change", e => { lsSet("planAll", e.target.checked ? "1" : ""); renderCrafts(); applyRO(); });
["budget", "maxq", "dropPct"].forEach(k => { const v = lsGet(k); if (v) $("#" + k).value = v; });
if (lsGet("planAll")) $("#planAll").checked = true;
$("#plan").addEventListener("click", e => {
  const f = e.target.closest("[data-follow]"); if (!f || !isMe()) return;
  const id = +f.dataset.follow; if (S.suivi.some(x => x.id === id)) return;
  S.suivi.push({ id, brk: 0 }); Store.saveSuivi(); render(); toast(`${ITEMS.get(id).n} ajouté aux crafts suivis`);
});
$("#advToggle").addEventListener("change", e => { document.body.classList.toggle("adv-on", e.target.checked); lsSet("adv", e.target.checked ? "1" : ""); });
if (lsGet("adv")) { document.body.classList.add("adv-on"); $("#advToggle").checked = true; }
$("#btnHelp").addEventListener("click", () => { $("#helpPanel").hidden = false; });
$("#helpPanel").addEventListener("click", e => { if (e.target.id === "helpPanel" || e.target.closest("[data-close]")) $("#helpPanel").hidden = true; });

// ---------------------------------------------------------------- divers
document.addEventListener("pointerover", e => {
  const c = e.target.closest?.("[data-tip]"); const t = $("#tip"); if (!c) { t.classList.remove("show"); return; }
  t.textContent = c.dataset.tip; const r = c.getBoundingClientRect();
  t.style.left = Math.max(8, Math.min(innerWidth - t.offsetWidth - 8, r.left + r.width / 2 - t.offsetWidth / 2)) + "px"; t.style.top = (r.top - 34) + "px"; t.classList.add("show");
});
const reTheme = () => { if (D && VIEW) { renderHeader(); render(); } };
const THEMES = ["system", "dark", "light"], THEME_LAB = { system: "Auto", dark: "Sombre", light: "Clair" };
let theme = lsGet("theme") || "system";
function applyTheme() {
  if (theme === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  $("#themeLab").textContent = THEME_LAB[theme]; reTheme();
}
$("#btnTheme").addEventListener("click", () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; lsSet("theme", theme); applyTheme(); toast("Thème : " + THEME_LAB[theme].toLowerCase()); });
$("#themeLab").textContent = THEME_LAB[theme];
$("#dataPanel").addEventListener("click", e => { if (e.target.id === "dataPanel") $("#dataPanel").hidden = true; });
document.addEventListener("keydown", e => { if (e.key === "Escape") $("#dataPanel").hidden = true; });
$("#btnStarter").addEventListener("click", async () => {
  try { const d = await (await fetch("data/depart-tanguy.json")).json(); await importData(d); $("#dataPanel").hidden = true; }
  catch (x) { console.error(x); toast("Impossible de charger les items de départ"); }
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", reTheme);

boot();
