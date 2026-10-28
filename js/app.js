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

function blank() { return { p: {}, prix: {}, maj: {}, suivi: [], journal: [], loaded: false }; }
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
function costOf(s, prix = S.prix) {
  const r = recipeOf(s); let c = 0, miss = 0;
  for (const [id, q] of r) { const p = prix[id]; if (p > 0) c += p * q; else miss++; }
  return { cost: c, miss };
}
function statsOf(s, prix = S.prix) {
  const { cost, miss } = costOf(s, prix); const brk = +s.brk || 0;
  const ok = !miss && cost > 0 && brk > 0;
  return { cost, miss, brk, ok, benef: ok ? brk - cost : null, roi: ok ? (brk - cost) / cost : null };
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
    const d = snap.data() || {}; const p = { ...(d.p || {}) }, mj = { ...(d.m || {}) };
    if (uid === ME) for (const rid of pendingPrix) { if (m.prix[rid] > 0) p[rid] = m.prix[rid]; else delete p[rid]; mj[rid] = m.maj[rid]; }
    m.prix = p; m.maj = mj; m.loaded = true; render();
  }, onErr));
  unsubs.push(base.collection("data").doc("suivi").onSnapshot(snap => {
    if (uid === ME && timers.suivi) return; // modification locale en attente d'enregistrement
    const d = snap.data() || {}; m.suivi = (d.items || []).map(x => ({ ...x })); render();
  }, onErr));
  unsubs.push(base.collection("journal").onSnapshot(snap => {
    const act = uid === ME ? document.activeElement?.dataset?.j : null;
    m.journal = snap.docs.map(d => act === d.id ? (m.journal.find(j => j._id === act) || { _id: d.id, ...d.data() }) : ({ _id: d.id, ...d.data() }));
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
  savePrix() { if (!isMe()) return; pendingPrix.clear(); db.doc(`profiles/${ME}/data/prix`).set({ p: { ...S.prix }, m: { ...S.maj } }).catch(fail); },
  saveSuivi() { if (!isMe()) return; timers.suivi = null; db.doc(`profiles/${ME}/data/suivi`).set({ items: S.suivi.map(x => ({ ...x })) }).catch(fail); },
  addJr(e) { if (!isMe()) return; db.collection(`profiles/${ME}/journal`).add(e).catch(fail); },
  updJr(id, patch) { if (!isMe()) return; db.doc(`profiles/${ME}/journal/${id}`).update(patch).catch(fail); },
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
  document.querySelectorAll("#v-crafts input, #v-crafts select, #v-res input, #v-jr input, #v-jr select").forEach(x => { if (!x.classList.contains("keep")) x.disabled = r; });
  document.querySelectorAll("#v-crafts .x, #v-jr .x, [data-rreset]").forEach(x => x.hidden = r);
}
function keepFocus(fn) {
  const a = document.activeElement, id = a?.id, ss = a?.selectionStart; fn();
  if (id) { const el = document.getElementById(id); if (el && el !== a) { el.focus(); try { if (ss != null && el.type !== "number") el.setSelectionRange(ss, ss); } catch (e) { } } }
}

// ----- Crafts suivis
function renderCrafts() {
  const rows = S.suivi.map(s => ({ s, it: ITEMS.get(s.id), ...statsOf(s) })).sort((a, b) => (b.roi ?? -1e9) - (a.roi ?? -1e9));
  keepFocus(() => {
    $("#crafts").innerHTML = rows.length ? rows.map(r => {
      const nm = r.it ? r.it.n : "Item retiré du jeu", isOpen = open.has(r.s.id);
      const roiCell = r.ok ? `<span class="pill ${pillCls(r.roi)}">${pillTxt(r.roi)}</span>` :
        `<span class="pill p-na">${r.miss ? r.miss + " prix manquant" + (r.miss > 1 ? "s" : "") : "brisage à remplir"}</span>`;
      let html = `<tr class="item ${isOpen ? "open" : ""}" data-id="${r.s.id}">
        <td class="l"><div class="iname"><span class="chev">›</span> ${esc(nm)}<small>${r.it ? `Niv. ${r.it.l} · ${esc(D.types[r.it.t] || "")} · ${esc(r.it.j)}` : ""}${r.s.r ? " · recette modifiée" : ""}</small></div></td>
        <td class="m">${r.miss ? `<span class="neg" title="Coût partiel">≥ ${fmt(r.cost)}</span>` : fmt(r.cost)}</td>
        <td><input class="num brk-in" id="brk-${r.s.id}" data-brk="${r.s.id}" type="number" min="0" value="${r.s.brk || ""}" placeholder="kamas" aria-label="Valeur de brisage de ${esc(nm)}"></td>
        <td class="m ${r.benef < 0 ? "neg" : ""}">${r.ok ? fmt(r.benef) : "–"}</td>
        <td>${roiCell}</td>
        <td><button class="ghost x" data-del="${r.s.id}" title="Retirer de la liste" aria-label="Retirer ${esc(nm)}">×</button></td></tr>`;
      if (isOpen) {
        const rec = recipeOf(r.s);
        html += `<tr class="detail"><td colspan="6"><div class="recipe">
          <div class="rrow rhead"><span>Ressource</span><span style="text-align:right">Qté</span><span style="text-align:right">Prix unitaire</span><span style="text-align:right">Sous-total</span><span></span></div>
          ${rec.map(([rid, q], k) => { const p = S.prix[rid]; return `<div class="rrow">
            <span class="rn">${esc(D.res[rid] || "Ressource " + rid)}</span>
            <input class="num" id="q-${r.s.id}-${rid}" data-rq="${r.s.id}" data-k="${k}" type="number" min="1" value="${q}" aria-label="Quantité">
            <input class="num ${p > 0 ? "" : "miss"}" id="p-${r.s.id}-${rid}" data-price="${rid}" type="number" min="0" value="${p || ""}" placeholder="prix" aria-label="Prix de ${esc(D.res[rid] || "")}">
            <span class="st">${p > 0 ? fmt(p * q) : "–"}</span>
            <button class="ghost x" data-rdel="${r.s.id}" data-k="${k}" aria-label="Retirer l'ingrédient" title="Retirer l'ingrédient">×</button></div>`; }).join("")}
          <div class="rfoot"><span class="note">Total : <b style="font-family:var(--mono)">${fmt(r.cost)}</b>${r.miss ? ` (${r.miss} prix manquant${r.miss > 1 ? "s" : ""})` : ""}</span>
            ${r.s.r ? `<button class="ghost" data-rreset="${r.s.id}">Revenir à la recette du jeu</button>` : ""}</div></div></td></tr>`;
      }
      return html;
    }).join("") : `<tr><td colspan="6" class="empty">${isMe() ? "Aucun item suivi. Cherche un item ci-dessus pour l'ajouter." : "Ce membre ne suit encore aucun item."}</td></tr>`;
  });
  renderPlan(rows);
}
function renderPlan(rows) {
  let budget = Math.max(0, +$("#budget").value || 0); const maxq = Math.max(1, Math.floor(+$("#maxq").value || 1));
  const cands = rows.filter(r => r.ok && r.benef > 0).sort((a, b) => b.roi - a.roi);
  const plan = []; let inv = 0, ben = 0;
  for (const r of cands) { const q = Math.min(maxq, Math.floor(budget / r.cost)); if (q <= 0) continue; plan.push({ ...r, q }); budget -= q * r.cost; inv += q * r.cost; ben += q * r.benef; }
  $("#plan").innerHTML = plan.length ? plan.map(p => `<li><span class="qty">${p.q}×</span><span>${esc(p.it.n)}<br><small class="note">${fmt(p.cost)} pièce · ${pillTxt(p.roi)}</small></span><span class="pf">+${fmt(p.q * p.benef)}</span></li>`).join("")
    : `<li class="empty">${cands.length ? "Budget trop faible pour le moins cher des crafts rentables." : "Renseigne les prix des ressources et le brisage estimé pour obtenir un plan."}</li>`;
  $("#tInv").textContent = fmt(inv); $("#tBen").textContent = fmt(ben);
}

// ----- Ressources
function neededRes() {
  const m = new Map();
  for (const s of S.suivi) { const it = ITEMS.get(s.id); for (const [rid] of recipeOf(s)) { if (!m.has(rid)) m.set(rid, []); m.get(rid).push(it ? it.n : "?"); } }
  return [...m.entries()];
}
function renderRes() {
  const f = norm(rfilter);
  const list = neededRes().map(([rid, its]) => ({ rid, its, n: D.res[rid] || "Ressource " + rid }))
    .filter(x => !f || norm(x.n).includes(f))
    .sort((a, b) => ((S.prix[a.rid] > 0) - (S.prix[b.rid] > 0)) || a.n.localeCompare(b.n, "fr"));
  keepFocus(() => {
    $("#res").innerHTML = list.length ? list.map(x => { const p = S.prix[x.rid]; return `<tr>
      <td class="l"><b>${esc(x.n)}</b></td><td class="l note">${esc([...new Set(x.its)].join(", "))}</td>
      <td><input class="num ${p > 0 ? "" : "miss"}" id="rp-${x.rid}" data-price="${x.rid}" type="number" min="0" value="${p || ""}" placeholder="prix" aria-label="Prix de ${esc(x.n)}"></td>
      <td class="m note">${fdate(S.maj[x.rid])}</td></tr>`; }).join("")
      : `<tr><td colspan="4" class="empty">${S.suivi.length ? "Aucune ressource ne correspond au filtre." : "Ajoute des items dans « Crafts suivis » pour voir les ressources à acheter."}</td></tr>`;
  });
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
      const inp = (f, type, w, extra = "") => `<td style="width:${w}px"><input ${type === "date" ? "" : 'class="num"'} id="j${f}-${e._id}" data-j="${e._id}" data-f="${f}" type="${type}" ${type === "number" ? 'min="0"' : ""} value="${esc(e[f] || "")}" ${extra}></td>`;
      return `<tr><td class="l"><b>${esc(e.nom)}</b></td>
        ${inp("qte", "number", 64, 'aria-label="Quantité"')}${inp("achat", "date", 138, 'aria-label="Date d\'achat"')}${inp("cout", "number", 104, 'aria-label="Coût total"')}
        ${inp("brisage", "date", 138, 'aria-label="Date de brisage"')}${inp("runes", "number", 104, 'placeholder="kamas" aria-label="Valeur des runes"')}
        ${inp("vente", "date", 138, 'aria-label="Date de vente"')}${inp("encaisse", "number", 104, 'placeholder="kamas" aria-label="Kamas encaissés"')}
        <td class="m ${ben < 0 ? "neg" : ben > 0 ? "pos" : ""}">${R ? fmt(ben) : "–"}</td>
        <td>${roi != null ? `<span class="pill ${pillCls(roi)}">${pillTxt(roi)}</span>` : ""}</td>
        <td class="l"><span class="status ${st[0]}">${st[1]}</span></td>
        <td><button class="ghost x" data-jdel="${e._id}" aria-label="Supprimer la ligne" title="Supprimer">×</button></td></tr>`;
    }).join("") : `<tr><td colspan="12" class="empty">${isMe() ? "Aucune série enregistrée. Ajoute ton premier achat ci-dessus." : "Ce membre n'a encore enregistré aucune série."}</td></tr>`;
  });
  const done = J.filter(e => realize(e)), run = J.filter(e => !realize(e));
  const inv = done.reduce((a, e) => a + (+e.cout || 0), 0), rn = done.reduce((a, e) => a + realize(e).ventes, 0);
  const stock = run.reduce((a, e) => a + (+e.cout || 0), 0);
  $("#jtot").innerHTML = `<div class="tot"><span>Investi (réalisé)</span><b>${fmt(inv)}</b></div>
    <div class="tot"><span>Ventes</span><b>${fmt(rn)}</b></div>
    <div class="tot big"><span>Bénéfice réel</span><b>${fmt(rn - inv)}</b></div>
    <div class="tot"><span>Rendement réel</span><b>${inv ? pillTxt((rn - inv) / inv) : "–"}</b></div>
    <div class="tot"><span>En stock</span><b>${fmt(stock)}</b></div>`;
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
let softT; function softCrafts() { clearTimeout(softT); softT = setTimeout(() => { if (tab === "crafts") renderCrafts(); applyRO(); }, 350); }
function setPrice(rid, v) {
  pendingPrix.add(String(rid)); const n = +v || 0;
  if (n > 0) S.prix[rid] = n; else delete S.prix[rid]; S.maj[rid] = today();
  later("prix", () => Store.savePrix());
}
document.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "budget" || t.id === "maxq") { renderCrafts(); applyRO(); return; }
  if (t.id === "rq") { rfilter = t.value; renderRes(); applyRO(); return; }
  if (!isMe()) return;
  if (t.dataset.price) { setPrice(t.dataset.price, t.value); t.classList.toggle("miss", !(+t.value > 0)); if (tab === "crafts") softCrafts(); return; }
  if (t.dataset.brk) { const s = S.suivi.find(x => x.id === +t.dataset.brk); s.brk = +t.value || 0; clearTimeout(timers.suivi); saveSuiviLater(); softCrafts(); return; }
  if (t.dataset.rq) { const s = S.suivi.find(x => x.id === +t.dataset.rq); if (!s.r) s.r = recipeOf(s).map(([i, q]) => ({ i, q })); s.r[+t.dataset.k].q = Math.max(1, +t.value || 1); clearTimeout(timers.suivi); saveSuiviLater(); softCrafts(); return; }
  if (t.dataset.j) {
    const f = t.dataset.f; const v = (f === "achat" || f === "brisage" || f === "vente") ? t.value : (+t.value || 0);
    const e0 = S.journal.find(j => j._id === t.dataset.j); if (e0) e0[f] = v;
    later("j" + t.dataset.j + f, () => Store.updJr(t.dataset.j, { [f]: v }), 500); return;
  }
  if (t.id === "jQty" && !$("#jCost").dataset.touched) prefillCost();
  if (t.id === "jCost") t.dataset.touched = "1";
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.price || t.dataset.brk || t.dataset.rq) render();
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
  const data = { format: "atelier-brisage", version: 1, exporte: new Date().toISOString(), pseudo: MYPROFILE.pseudo, suivi: me.suivi, prix: { p: me.prix, m: me.maj }, journal: me.journal.map(({ _id, ...e }) => e) };
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
    if (d.prix?.p) { Object.assign(me.prix, d.prix.p); Object.assign(me.maj, d.prix.m || {}); }
    const wasView = VIEW; VIEW = ME; S = me;
    Store.saveSuivi(); Store.savePrix();
    const batch = db.batch();
    for (const j of d.journal || []) { batch.set(db.collection(`profiles/${ME}/journal`).doc(), j); nj++; }
    if (nj) await batch.commit();
    VIEW = wasView; S = member(VIEW); render();
    toast(`Import terminé : ${ni} item(s), ${nj} série(s)`);
}

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
