/* Maç Analiz — arkadaş sitesi. Veri: data.json (yerel uygulamadan yayınlanır).
   Tüm metinler textContent ile yazılır; kupon ve kupon geçmişi (tutarlar dahil) sadece bu cihazın tarayıcısında
   saklanır, hiçbir yere gönderilmez. Geçmiş hesapları history.js'te (History), elle girilen iddaa oranları ve
   beklenen değer iddaa.js'te (Iddaa, §29). */
"use strict";

const TZ = "Europe/Istanbul";
const STORE = "macanaliz.kupon.v1";
const HSTORE = "macanaliz.gecmis.v1"; // §27 oynanan kuponlar + aylık bütçe
const ISTORE = "macanaliz.iddaa.v1"; // §29 elle girilen iddaa oranları (maç detayı, Kuponum, Oynadım ortak); §34 otomatik de
const OTO_STORE = "macanaliz.iddaa.oto.v1"; // §34 "0" = otomatik çekme kapalı (varsayılan açık)
const DURUM_STORE = "macanaliz.iddaa.durum.v1"; // §34 son çekim durumu (spor başına)
const KINDS = [
  ["safe", History.TYPE_NAMES.safe, "Tutma olasılığı görece yüksek, oranı düşük. Hiçbir kupon garanti değildir."],
  ["risky", "Riskli", "Risk almayan viski içemez."],
  ["slip", "Market fişi", "Çok maçlı, tamamen keyif."],
];
const GROUPS = {
  h2h: "Maç sonucu", double_chance: "Çifte şans", totals: "Alt / üst", btts: "Karşılıklı gol", spreads: "Handikap",
};

let DATA = null;
const state = { sport: "football", day: 0, kupon: loadKupon(), stake: 10, playing: false, histMsg: null,
  historyError: null };
state.history = loadHistory();
state.iddaa = loadIddaa();
const byId = new Map(); // maç id → {match, sport}

/* ---------- yardımcılar ---------- */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    const aria = k.startsWith("aria-");
    if (v === null || v === undefined || (v === false && !aria)) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true && !aria ? "" : String(v)); // aria-* değerleri "true"/"false" olmalı
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const fmtTime = (iso) => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const fmtDateTime = (iso) => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const fmtDate = (iso) => new Intl.DateTimeFormat("tr-TR", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(iso));
const pct = (p) => (p == null ? "–" : p >= 0.01 || p <= 0 ? `%${Math.round(p * 100)}` : `%${(p * 100).toFixed(1).replace(".", ",")}`);
const odds = (x) => (x == null ? "–" : Number(x).toFixed(2).replace(".", ","));
const tl = (x) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(x);
const started = (m) => new Date(m.kickoff) <= new Date();
const parseNum = (v) => parseFloat(String(v).trim().replace(",", ".")); // "1,75" → 1.75
const days = () => (DATA && DATA[state.sport]) || [];
const isMinor = (m) => m.sport === "minor"; // oranı çekilmeyen lig: sadece kendi model, fiyat yok
const matchLabel = (m) => `${m.home} – ${m.away}`;
/* Açılış günü: başlamamış maçı olan ilk gün, yoksa maçı olan ilk gün, o da yoksa bugün. */
function firstDay() {
  const ds = days();
  let i = ds.findIndex((d) => d.matches.some((m) => !started(m)));
  if (i < 0) i = ds.findIndex((d) => d.matches.length);
  return Math.max(0, i);
}

/* Model ile piyasa farkı (olasılık puanı). EDGE puan ve üstü işaretlenir (TASARIM.md §6: 5 puan). Listede sadece 1X2: model gol sayısını
   piyasadan sistematik düşük görüyor (2026-11 ölçümü), alt/üst farkları çoğunlukla bu eğilim. */
const EDGE = 0.05;
const diffOf = (o) => (o.model_prob == null || o.market_prob == null ? null : o.model_prob - o.market_prob);
const pts = (d) => `${d > 0 ? "+" : "−"}${Math.round(Math.abs(d) * 100)}`;
/* Takım arması (futbol, diğer ligler, NBA): listede 20px, detayda 64px daire; yoksa ya da yüklenemezse boş daire. */
function crest(m, side, size) {
  const cls = size === "lg" ? "logo lg" : "logo";
  const blank = () => h("span", { class: cls, "aria-hidden": "true" });
  const src = m.logos && m.logos[side];
  if (!src) return blank();
  const img = h("img", { class: cls, src, alt: "", loading: "lazy", decoding: "async", onerror: () => img.replaceWith(blank()) });
  return img;
}

/* MS olasılık çubuğu: ev / beraberlik / deplasman (NBA: ev / deplasman, beraberlik yok). */
const OUT3 = ["home", "draw", "away"];
const outsOf = (m) => (m.sport === "basketball" ? ["home", "away"] : OUT3);
function probs3(m, field) {
  const get = (k) => { const o = m.options.find((x) => x.market === "h2h" && x.outcome === k); return o ? o[field] : null; };
  const v = outsOf(m).map(get);
  return v.every((x) => x != null) ? v : null;
}
/* kind: "" (liste, 6px) | "lg" (detay, 8px) | "model" (detayda altta, 4px, soluk) */
function pbar(vals, kind) {
  const outs = vals.length === 2 ? ["home", "away"] : OUT3;
  return h("div", { class: kind ? `pbar ${kind}` : "pbar", "aria-hidden": "true" }, vals.map((p, i) =>
    h("span", { class: `s-${outs[i]}`, style: `flex-grow:${Math.max(p, 0.001)}` })));
}
/* Sitede gösterilen MS olasılığı harman mı (futbol §26-5, NBA §28 ayrı karar). */
const nbaBlend = () => (DATA.performance_nba && DATA.performance_nba.blend) || null;
const blendOn = (m) => (m.sport === "basketball" ? !!(nbaBlend() && nbaBlend().use_on_site) : !!(DATA.blend && DATA.blend.use_on_site));

const STALE_MS = 12 * 3600 * 1000;
const PROGRAM_STALE_MS = 36 * 3600 * 1000; // diğer liglerin maç programı günde bir yenilenir
/* Seçili sporun oran (diğer liglerde maç programı) zamanı; 12 saatten (program: 36) eskiyse uyarı rengi + yazı. */
function oddsStamp(sport) {
  const sp = sport || state.sport;
  if (!DATA) return null;
  let t, stale, text;
  if (sp === "minor") {
    t = DATA.minor_info && DATA.minor_info.fixtures_updated;
    stale = t && Date.now() - new Date(t).getTime() > PROGRAM_STALE_MS;
    text = t ? `Program ${fmtStamp(t)}` : "Program yok";
  } else {
    t = DATA.odds_updated && DATA.odds_updated[sp];
    stale = t && Date.now() - new Date(t).getTime() > STALE_MS;
    text = t ? `Oranlar ${fmtStamp(t)}` : "Oran yok";
  }
  return h("span", { class: stale ? "updated stale" : "updated",
    title: t ? `${sp === "minor" ? "Maç programı" : "Oranlar"}: ${fmtDateTime(t)}` : null },
    text, stale ? " · eski olabilir" : "");
}
/* Bugünse sadece saat, değilse "21 Kas 20:25". */
function fmtStamp(iso) {
  const d = new Date(iso);
  const day = (x) => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  if (day(d) === day(new Date())) return fmtTime(iso);
  return new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}
function updateHeader() { /* eski başlık çubuğu yok: oran zamanı ekranların içinde (oddsStamp) */ }

/* ---------- tema (Sistem / Koyu / Açık; TASARIM.md §2) ---------- */
const TSTORE = "macanaliz.tema.v1";
function loadTheme() {
  try { const t = localStorage.getItem(TSTORE); return t === "dark" || t === "light" ? t : "system"; } catch { return "system"; }
}
function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === "dark" || pref === "light") root.setAttribute("data-theme", pref);
  else root.removeAttribute("data-theme");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", getComputedStyle(root).getPropertyValue("--bg").trim() || "#0D1014");
}
function setTheme(pref) {
  try {
    if (pref === "system") localStorage.removeItem(TSTORE); else localStorage.setItem(TSTORE, pref);
  } catch { toast("Tema bu cihaza kaydedilemedi (tarayıcı kayıt alanı kapalı)"); }
  applyTheme(pref);
}
if (window.matchMedia) {
  const mq = matchMedia("(prefers-color-scheme: light)");
  const onChange = () => { if (loadTheme() === "system") applyTheme("system"); };
  if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
}

/* ---------- ortak bileşenler ---------- */
const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, String(v));
  for (const kid of kids.flat(Infinity)) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
/* İnce çizgili ikonlar (24×24, currentColor). */
const ICONS = {
  back: ["M15 5l-7 7 7 7"], chev: ["M9 5l7 7-7 7"], share: ["M12 3v13M7 8l5-5 5 5M5 13v7h14v-7"],
  plus: ["M12 5v14M5 12h14"], down: ["M6 9l6 6 6-6"], check: ["M5 12.5l4.5 4.5L19 7.5"], trend: ["M3 17l5-5 4 3 8-9"],
};
function icon(name, size, sw) {
  const s = svg("svg", { width: size || 22, height: size || 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": sw || 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
    ICONS[name].map((d) => svg("path", { d })));
  return s;
}
function removeIcon() {
  return svg("svg", { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "aria-hidden": "true" },
    svg("circle", { cx: 12, cy: 12, r: 9 }), svg("path", { d: "M8 12h8" }));
}
/* Grup: küçük gri bölüm başlığı + kart. title null → başlıksız. */
function sec(title, ...kids) {
  return h("section", { class: "sec" }, title ? h("h2", { class: "sec-h" }, title) : null, ...kids);
}
const card = (...kids) => h("div", { class: "card" }, ...kids);
/* Masaüstünde iki sütun (≥ 1024 px, yeterli genişlikte); mobilde display: contents — DOM sırası ve görünüm aynı kalır. */
const twoCol = (left, right) => h("div", { class: "pgrid" },
  h("div", { class: "pcol" }, left.filter(Boolean)), h("div", { class: "pcol" }, right.filter(Boolean)));
const padCard = (...kids) => h("div", { class: "card pad" }, ...kids);
const badge = (text, kind, extra) => h("span", { class: `badge${kind ? ` ${kind}` : ""}${extra ? ` ${extra}` : ""}` }, text);
/* Segmentli seçici (role=tablist). items: [[değer, etiket]]. */
function segmented(label, items, current, onSelect, extra) {
  return h("div", { class: `seg${extra ? ` ${extra}` : ""}`, role: "tablist", "aria-label": label }, items.map(([v, lab]) =>
    h("button", { type: "button", role: "tab", "aria-selected": v === current, onclick: () => { if (v !== current) onSelect(v); } }, lab)));
}
/* Ekran başlığı: büyük başlık (+ isteğe bağlı sağ yazı) ve altındakiler. */
function screenHead(title, ...rest) {
  return h("header", { class: "hd" }, h("h1", { class: "title" }, title), ...rest);
}
/* Piyasa / model karşılaştırma çubukları (olasılıklar 0..1). */
function cmpBars(rows) {
  return h("div", { class: "cmp" }, rows.flatMap(([lbl, p, kind, strong]) => [
    h("span", { class: "lbl" }, lbl),
    h("div", { class: "track", "aria-hidden": "true" }, h("span", { class: kind, style: `width:${Math.max(0, Math.min(1, p || 0)) * 100}%` })),
    h("span", { class: "val", style: strong ? "font-weight:600" : "color:var(--muted)" }, pct(p))]));
}
function backLink(href, label) {
  return h("a", { class: "back", href }, icon("back", 22, 2.2), label);
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 1800);
}

/* ---------- kupon (localStorage) ---------- */
function loadKupon() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE));
    if (!Array.isArray(v)) return [];
    return v.filter((l) => l && typeof l.key === "string" && l.pick && l.kickoff && !isNaN(new Date(l.kickoff))
      && Number(l.price) > 1);
  } catch { return []; }
}
function saveKupon() {
  try { localStorage.setItem(STORE, JSON.stringify(state.kupon)); } catch { /* gizli sekme vb. */ }
  const n = state.kupon.length;
  const b = document.getElementById("kupon-count");
  b.textContent = n;
  b.setAttribute("aria-label", `${n} seçim`);
  b.hidden = n === 0;
  refreshSide();
}
/* Masaüstü kenar çubuğu (kupon özeti, Değerli sayısı) kupon / iddaa değişince yenilenir; mobilde bir şey yapmaz. */
function refreshSide() {
  if (WIDE.matches) Desktop.renderSide(document.getElementById("side"));
}
const inKupon = (key) => state.kupon.some((l) => l.key === key);
function legFrom(m, o, src) {
  const fair = o.price == null; // oranı çekilmeyen lig: adil oranla girer, kullanıcı iddaa oranını yazar
  return { key: o.key, matchId: m.id, pick: o.pick, match: matchLabel(m), competition: m.competition,
    kickoff: m.kickoff, price: fair ? o.fair : o.price, prob: o.prob, fair, src, model: isMinor(m) || !!o.unverified }; // src: safe|risky|slip|own
}
function toggleOption(m, o) {
  if (inKupon(o.key)) {
    state.kupon = state.kupon.filter((l) => l.key !== o.key);
    toast("Kupondan çıkarıldı");
  } else {
    state.kupon.push(legFrom(m, o, "own"));
    const ist = IDDAA_STATUS_TEXT[legIddaa(m.id, o.key, m.kickoff)];
    toast(started(m) ? "Kupona eklendi — uyarı: maç başladı"
      : ist ? `Kupona eklendi — uyarı: ${ist}`
      : iddaaOf(m.id, o.key) != null ? "Kupona iddaa oranıyla eklendi"
      : o.price == null ? "Adil oranla eklendi — iddaa oranını yaz" : "Kupona eklendi");
  }
  saveKupon();
}
function addCoupon(c, kind) {
  let added = 0, late = 0;
  for (const leg of c.legs) {
    const ref = byId.get(leg.match);
    const o = ref && ref.match.options.find((x) => x.key === leg.key);
    if (o && !inKupon(o.key)) {
      state.kupon.push(legFrom(ref.match, o, kind)); added++;
      if (started(ref.match)) late++;
    }
  }
  saveKupon();
  const warn = late ? ` — uyarı: ${late} maç başladı` : "";
  toast(added ? `${added} seçim kupona eklendi${warn}` : "Bu seçimler zaten kuponda");
}

/* ---------- iddaa oranları (localStorage, §29) ----------
   Tek kayıt: maç detayında, Kuponum'da ve Oynadım formunda girilen oran aynı yere yazılır. Kupondaki seçimin oranı:
   iddaa kaydı varsa o, yoksa seçimin eklendiği andaki oran (yurtdışı ya da adil). Maç başladıktan 24 saat sonra silinir. */
function loadIddaa() {
  let s = Iddaa.emptyStore();
  try {
    const raw = localStorage.getItem(ISTORE);
    if (raw != null) s = Iddaa.parseStore(raw);
  } catch { /* gizli sekme, kayıt alanı kapalı: oranlar bu oturumda bellekte kalır */ }
  if (Iddaa.prune(s, new Date())) persistIddaa(s);
  return s;
}
function persistIddaa(s) {
  try { localStorage.setItem(ISTORE, Iddaa.serialize(s)); return true; } catch { return false; }
}
/* price null → o seçeneğin iddaa oranı silinir. */
function setIddaa(matchId, kickoff, key, price) {
  Iddaa.prune(state.iddaa, new Date());
  if (!Iddaa.set(state.iddaa, matchId, kickoff, key, price)) return false;
  if (!persistIddaa(state.iddaa)) toast("iddaa oranı bu cihaza kaydedilemedi (tarayıcı kayıt alanı kapalı ya da dolu)");
  refreshSide(); // masaüstü kenar çubuğundaki toplam oran iddaa oranıyla değişir
  return true;
}
const iddaaOf = (matchId, key) => Iddaa.get(state.iddaa, matchId, key);
const legPrice = (l) => iddaaOf(l.matchId, l.key) ?? Number(l.price);
const legVerified = (l) => iddaaOf(l.matchId, l.key) != null;
const legModel = (l) => !!l.model || String(l.matchId).startsWith("lfa-"); // diğer ligler: olasılık model tahmini
/* §35 iddaa durumu (Coupons.build / legStatus için): son başarılı çekim taze mi, bültenin en geç maçı, maç bültende mi
   (son çekimde eşleşip oranı yazılan maç). */
function iddaaCtx(sport) {
  const st = loadIddaaStatus()[sport] || {};
  const fresh = !!st.lastOk && Date.now() - Date.parse(st.lastOk) <= Coupons.FRESH_MS;
  const ref = (m) => byId.get(m);
  return {
    fetched: iddaaAutoOn() && fresh,
    coverTo: st.coverTo ? Date.parse(st.coverTo) : NaN,
    price: (m, key) => iddaaOf(m, key),
    source: (m, key) => Iddaa.source(state.iddaa, m, key),
    inBulletin: (m) => Iddaa.autoKeys(state.iddaa, m).length > 0,
    kickoff: (m) => (ref(m) ? new Date(ref(m).match.kickoff).getTime() : NaN),
    started: (m) => !!ref(m) && started(ref(m).match),
    option: (m, key) => {
      const o = ref(m) && ref(m).match.options.find((x) => x.key === key);
      return o ? { prob: o.prob, price: o.price } : null;
    },
  };
}
/* Günün başı: futbol İstanbul 00:00, NBA gecesi 08:00 (İstanbul yıl boyu UTC+3). */
const dayStartMs = (day, sport) => Date.parse(`${day.date}T${sport === "basketball" ? "08" : "00"}:00:00+03:00`);
/* Kupondaki seçimin iddaa durumu: "closed" | "absent" | "ok" | "unknown" (diğer ligler, başlamış maç, veri yokken unknown). */
function legIddaa(matchId, key, kickoff) {
  const ref = byId.get(matchId);
  if (!ref || isMinor(ref.match) || started(ref.match)) return "unknown";
  const sport = ref.match.sport === "basketball" ? "basketball" : "football";
  return Coupons.legStatus(iddaaCtx(sport), matchId, key, new Date(kickoff).getTime());
}
const IDDAA_STATUS_TEXT = { closed: "iddaa'da kapalı", absent: "iddaa bülteninde yok" };
/* §29 öncesi Kuponum'da elle yazılan oranlar (adil oranla eklenen seçimlerde fair=false olurdu) iddaa kaydına taşınır. */
function migrateKuponOdds() {
  let n = 0;
  for (const l of state.kupon) {
    if (l.fair === false && legModel(l) && !legVerified(l) && setIddaa(l.matchId, l.kickoff, l.key, Number(l.price))) {
      l.fair = true; n++;
    }
  }
  if (n) saveKupon();
}
const bandPct = () => Math.round(Iddaa.EV_BANDS.value * 100);
/* ---------- §34 iddaa oranlarını tarayıcıda çekme ----------
   Açılışta ve sekmeye dönüşte, spor başına en fazla 2 saatte bir (Bulletin.due). Ham yanıt saklanmaz; eşleşen seçeneklerin
   oranı iddaa kaydına "auto" olarak yazılır (elle girilen her zaman önce). Hata sessiz: sadece Ayarlar'daki durumda görünür. */
const IDDAA_TIMEOUT_MS = 10000;
function iddaaAutoOn() {
  try { return localStorage.getItem(OTO_STORE) !== "0"; } catch { return true; }
}
function setIddaaAutoOn(on) {
  try { if (on) localStorage.removeItem(OTO_STORE); else localStorage.setItem(OTO_STORE, "0"); } catch { /* kayıt alanı kapalı */ }
  if (!on) { // kapatınca çekilmiş oranlar da kalkar; elle girilenler kalır
    for (const id of Object.keys(state.iddaa.matches)) Iddaa.setAuto(state.iddaa, id, state.iddaa.matches[id].kickoff, {}, "");
    persistIddaa(state.iddaa);
    refreshSide();
  }
}
function loadIddaaStatus() {
  try { const v = JSON.parse(localStorage.getItem(DURUM_STORE)); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function saveIddaaStatus(st) {
  try { localStorage.setItem(DURUM_STORE, JSON.stringify(st)); } catch { /* yok sayılır */ }
}
const feedError = (e) => (e && e.name === "AbortError" ? "Zaman aşımı" : e instanceof TypeError ? "Ağ ya da erişim (CORS) hatası"
  : e instanceof SyntaxError ? "Biçim değişti" : String((e && e.message) || e));
let feedBusy = false;
async function fetchSport(sport, st) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IDDAA_TIMEOUT_MS);
  let res;
  try { res = await fetch(Bulletin.url(sport), { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: ctrl.signal }); } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const r = Bulletin.parse(await res.json(), Date.now());
  if (!r.ok) throw new Error("Biçim değişti");
  const ours = (DATA[sport] || []).flatMap((d) => d.matches).filter((m) => !started(m));
  const mt = Bulletin.match(r.events, ours, DATA.iddaa_map, sport);
  const c = Bulletin.collect(mt.pairs, sport);
  if (!c.ok) throw new Error("Biçim değişti"); // eski otomatik oranlara dokunulmaz
  if (!iddaaAutoOn()) return false; // çekme sürerken kapatıldı: oranları geri yazma
  const at = new Date().toISOString();
  const { nOdds, unknown } = c;
  for (const { match, odds } of c.perMatch) Iddaa.setAuto(state.iddaa, match.id, match.kickoff, odds, at);
  // bültende artık olmayan (askıya alınan, kaldırılan) maçların eski otomatik oranı kalkar; elle girilenler kalır
  const paired = new Set(c.perMatch.map((x) => x.match.id));
  for (const m of ours) if (!paired.has(m.id) && Iddaa.autoKeys(state.iddaa, m.id).length) Iddaa.setAuto(state.iddaa, m.id, m.kickoff, {}, at);
  if (mt.log.teams.length || mt.log.matches.length) console.info(`iddaa eşleşmeyenler (${sport})`, mt.log);
  if (r.skipped.length) console.info(`iddaa: ayrıştırılamayan ${r.skipped.length} maç atlandı (${sport})`, r.skipped);
  // §35 bültenin en geç maçı: sonraki günlerin kuponları "iddaa henüz açmadı" diye yurtdışı oranla kalır
  const last = r.events.reduce((a, e) => Math.max(a, e.kickoff), -Infinity);
  Object.assign(st, { lastOk: at, coverTo: Number.isFinite(last) ? new Date(last).toISOString() : null,
    error: null, errorAt: null, matched: mt.pairs.length, odds: nOdds, unknown, skipped: r.skipped.length,
    nTeams: mt.log.teams.length, teams: mt.log.teams.slice(0, 20).map((t) => t.name),
    nMatches: mt.log.matches.length, matches: mt.log.matches.slice(0, 20).map((x) => `${x.home} – ${x.away}`) });
  return true; // kayıt değişmiş olabilir (yeni oranlar ya da bültenden düşenler)
}
async function refreshIddaaFeed(force = false) {
  if (feedBusy || !DATA || !DATA.iddaa_map || !iddaaAutoOn()) return;
  feedBusy = true;
  let changed = false;
  try {
    const status = loadIddaaStatus();
    for (const sport of ["football", "basketball"]) {
      // §35 yeni yayın (data.json) son denemeden sonraysa eşleme yeni maçlarla yeniden yapılır (eşleşmeyen maç kupondan düşer)
      const tried = status[sport] && Date.parse(status[sport].lastTry);
      const newData = tried && DATA.generated_at && tried < Date.parse(DATA.generated_at);
      if (!force && !newData && !Bulletin.due(status, sport, Date.now())) continue;
      const st = (status[sport] = { ...(status[sport] || {}), lastTry: new Date().toISOString() });
      saveIddaaStatus(status); // deneme zamanı önce: hata olsa da 2 saat beklenir
      try { changed = (await fetchSport(sport, st)) || changed; } catch (e) { st.error = feedError(e); st.errorAt = new Date().toISOString(); }
      saveIddaaStatus(status);
    }
  } finally { feedBusy = false; }
  if (changed && iddaaAutoOn()) { persistIddaa(state.iddaa); refreshSide(); }
  const typing = document.activeElement && document.activeElement.tagName === "INPUT";
  if ((changed || location.hash.startsWith("#/gecmis")) && !typing) route(); // yazarken yeniden çizip kutuyu bozma
}
/* Geçmiş > Ayarlar: otomatik çekme anahtarı, son başarılı çekim, hata, eşleşmeyenler. */
function iddaaFeedSection(render) {
  const on = iddaaAutoOn(), st = loadIddaaStatus();
  const sportLine = (sport, name) => {
    const x = st[sport] || {};
    return h("div", { class: "feed-st row" }, h("b", {}, name),
      h("span", {}, x.lastOk ? `Son başarılı çekim: ${fmtDateTime(x.lastOk)} · ${x.matched || 0} maç, ${x.odds || 0} oran` : "Henüz başarılı çekim yok"),
      x.skipped ? h("span", { class: "muted" }, `Bültende ayrıştırılamayan ${x.skipped} maç atlandı`) : null,
      x.error ? h("span", { class: "bad" }, `Son hata: ${x.error}${x.errorAt ? ` (${fmtDateTime(x.errorAt)})` : ""}`) : null,
      (x.nTeams || x.nMatches) ? h("details", { class: "more" },
        h("summary", {}, `Eşleşmeyen: ${x.nTeams || 0} takım, ${x.nMatches || 0} maç`),
        x.teams && x.teams.length ? h("p", { class: "opt-sub" }, "Takım: ", x.teams.join(", ")) : null,
        x.matches && x.matches.length ? h("p", { class: "opt-sub" }, "Maç: ", x.matches.join(", ")) : null) : null);
  };
  return sec("iddaa oranları",
    card(
      h("div", { class: "set-row row" }, h("span", {}, "iddaa oranlarını otomatik çek"),
        segmented("iddaa oranlarını otomatik çek", [["on", "Açık"], ["off", "Kapalı"]], on ? "on" : "off",
          (v) => { setIddaaAutoOn(v === "on"); if (v === "on") refreshIddaaFeed(true).then(render); render(); }, "sm")),
      on ? [sportLine("football", "Futbol"), sportLine("basketball", "NBA"),
        h("button", { type: "button", class: "link-btn row", disabled: feedBusy, onclick: async (ev) => {
          ev.currentTarget.disabled = true;
          await refreshIddaaFeed(true);
          render();
        } }, "Şimdi çek")] : null),
    h("p", { class: "sec-note" }, "Oranlar iddaa'dan bu cihaza çekilir; Maç Analiz sunucusuna ya da siteye gönderilmez. ",
      "Elle girdiğin oran her zaman önce gelir. Açıkken uygulama açılışta en fazla 2 saatte bir çeker; çekilemezse elle girişe dönülür."));
}

/* ---------- kupon geçmişi (localStorage, §27) ---------- */
function loadHistory() {
  let raw = null;
  try { raw = localStorage.getItem(HSTORE); } catch { state.historyError = "Tarayıcı kayıt alanına erişilemiyor; geçmiş kaydedilemez."; }
  if (raw == null) return History.emptyStore();
  const r = History.parseStore(raw);
  if (r.ok) return r.store;
  // Bozuk kayıt silinmez: ayrı anahtara kopyalanır, kullanıcı yedekten yükleyebilir.
  try { localStorage.setItem(`${HSTORE}.bozuk`, raw); } catch { /* yer yok vb. */ }
  state.historyError = `Kayıtlı geçmiş okunamadı (${r.error}). Eski veri "${HSTORE}.bozuk" anahtarında saklandı; yedeğin varsa yükle.`;
  return History.emptyStore();
}
function saveHistory() {
  try { localStorage.setItem(HSTORE, History.serialize(state.history)); return true; } catch {
    toast("Geçmiş kaydedilemedi (tarayıcı kayıt alanı dolu ya da kapalı)");
    return false;
  }
}
function applyResults() {
  try {
    if (DATA && History.applyResults(state.history, DATA.results || [])) saveHistory();
  } catch { /* sonuç uygulanamazsa geçmiş olduğu gibi kalır */ }
}
/* ---------- ortak parçalar ---------- */
/* Odds API aylık kota satırı (futbol/NBA sayfalarında). */
function quotaLine() {
  const q = DATA && DATA.odds_quota;
  if (!q || state.sport === "minor") return null;
  return h("p", { class: "foot" }, `Bu ay kalan: ${q.remaining} kredi, günlük güvenli harcama: ${q.daily_safe}`,
    ` · ${fmtDateTime(q.resets_at)}'te yenilenir`);
}
/* Son oran çekme başarısızsa (kota sınırı vb.) seçili spor için uyarı bandı. */
const ODDS_REASON = {
  budget: "bugünkü güvenli kredi harcaması doldu; yarın yeniden denenecek",
  low_quota: "oran servisinin aylık kotası azaldığı için çekme durduruldu",
  quota: "oran servisinin kotası doldu",
  error: "oran servisine ulaşılamadı",
};
function oddsWarning() {
  if (!DATA || state.sport === "minor") return null;
  const st = DATA.odds_status && DATA.odds_status[state.sport];
  if (!st || st.ok) return null;
  const t = DATA.odds_updated && DATA.odds_updated[state.sport];
  return h("p", { class: "alert warn", role: "status" }, h("b", {}, "Oranlar güncellenemedi"),
    ` (${ODDS_REASON[st.reason] || "bilinmeyen hata"}). `,
    t ? `Gösterilen oranlar ${fmtDateTime(t)} tarihli; iddaa'daki güncel oranla karşılaştır.` : "Oran yok.");
}
function minorNote() {
  return h("p", { class: "sec-note" }, "Bu liglerin bahis oranı çekilmiyor: olasılıklar sadece kendi ",
    "modelimizden (geçmiş maçlar, gol ve xG). Adil oran = 1 / olasılık; iddaa oranı bundan yüksekse model o seçeneği ",
    "daha olası görüyor. Geçmiş testte model kapanış oranlarının biraz gerisinde kaldı — fikir verir, garanti değildir.");
}
function note(minor) {
  return h("p", { class: "foot" }, minor
    ? "Bu liglerde olasılıklar sadece kendi modelden; hiçbir tahmin garanti değildir."
    : "Oranlar uluslararası bahis şirketlerinden; iddaa oranları farklı olabilir. Olasılıklar oranlardan hesaplanır, hiçbir kupon garanti değildir.",
    DATA ? ` Site yayını: ${fmtDateTime(DATA.generated_at)}.` : "");
}

/* ---------- görünüm: Bugün (maç listesi) ---------- */
const SHORT = { home: "1", draw: "X", away: "2" };
const fmtDec = (x, d) => (x == null ? "–" : Number(x).toFixed(d == null ? 1 : d).replace(".", ","));
const fmtLine = (l) => String(l).replace(".", ","); // 2.75 → "2,75" (yuvarlanmaz)
const signedC = (x) => (x > 0 ? "+" : x < 0 ? "−" : "±") + fmtDec(Math.abs(x));
const ymd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
/* Veri gününün bugünden farkı (İstanbul). NBA gecesi İstanbul 08:00'de biter: gece 02:00'de hâlâ "bu gece". */
function dayOffset(d, sport) {
  const now = new Date(Date.now() - (sport === "basketball" ? 8 * 3600 * 1000 : 0));
  return Math.round((Date.parse(d.date) - Date.parse(ymd(now))) / 86400000);
}
const weekday = (date, style) => new Intl.DateTimeFormat("tr-TR", { timeZone: "UTC", weekday: style || "long" }).format(new Date(date));
function dayName(d, sport, short) {
  const off = dayOffset(d, sport), night = sport === "basketball";
  if (off === 0) return night ? "Bu gece" : "Bugün";
  if (off === 1) return night ? "Yarın gece" : "Yarın";
  if (off === -1) return night ? "Dün gece" : "Dün";
  return short ? `${weekday(d.date, "short")} ${Number(d.date.slice(8, 10))}` : weekday(d.date);
}
/* Model piyasadan en çok ayrıldığı MS sonucu (|fark| ≥ EDGE); diğer liglerde piyasa yok → rozet yok. */
function edgeOf(m) {
  if (isMinor(m)) return null;
  let best = null;
  for (const k of outsOf(m)) {
    const o = m.options.find((x) => x.market === "h2h" && x.outcome === k);
    const d = o && diffOf(o);
    if (d != null && Math.abs(d) >= EDGE && (!best || Math.abs(d) > Math.abs(best.d))) best = { outcome: k, d, o };
  }
  return best;
}
const edgeText = (e) => `Model ${SHORT[e.outcome]} ${pts(e.d)}`;
function sportChips(onChange) {
  const chip = (sp, lab) => h("button", { type: "button", class: "chip", "aria-pressed": state.sport === sp,
    onclick: () => { if (state.sport !== sp) { state.sport = sp; state.day = firstDay(); onChange(); } } }, lab);
  return [chip("football", "Futbol"), chip("basketball", "Basketbol"), DATA.minor ? chip("minor", "Diğer ligler") : null];
}
function dayChipList(onChange) {
  return days().map((d, i) => h("button", { type: "button", class: "chip", "aria-pressed": state.day === i,
    "aria-label": `${dayName(d, state.sport)}, ${d.label}, ${d.matches.length} maç`,
    onclick: () => { state.day = i; onChange(); } }, dayName(d, state.sport, true), h("span", { class: "n" }, d.matches.length)));
}
function viewToday(root) {
  const render = () => (WIDE.matches ? reselectFirst() : viewToday(root));
  if (state.sport === "minor" && !DATA.minor) { state.sport = "football"; state.day = firstDay(); }
  const day = days()[state.day];
  const n = day ? day.matches.length : 0;
  const kids = [h("header", { class: "hd" },
    h("div", { class: "brandbar" },
      h("a", { class: "brand", href: "#/", "aria-label": "Maç Analiz" },
        h("span", { class: "brand-mark", "aria-hidden": "true" }, icon("trend", 18, 2.4)),
        h("span", { class: "brand-name", "aria-hidden": "true" }, "MAÇ ANALİZ")),
      oddsStamp()),
    h("div", { class: "title-row" }, h("h1", { class: "title" }, day ? dayName(day, state.sport) : "Bugün"),
      day ? h("span", { class: "sub" }, `${weekday(day.date)}, ${day.label} · ${n} maç`) : null),
    h("div", { class: "chip-rows" },
      h("div", { class: "chips", role: "group", "aria-label": "Spor" }, sportChips(render)),
      days().length > 1 ? h("div", { class: "chips", role: "group", "aria-label": "Gün" }, dayChipList(render)) : null))];
  const warn = oddsWarning();
  if (warn) kids.push(warn);
  if (state.sport === "minor") kids.push(minorNote());
  if (!n) kids.push(h("p", { class: "empty" }, "Bu gün için maç yok."));
  else {
    const groups = [];
    for (const m of day.matches) {
      if (!groups.length || groups[groups.length - 1].comp !== m.competition) groups.push({ comp: m.competition, list: [] });
      groups[groups.length - 1].list.push(m);
    }
    const two = state.sport === "basketball";
    for (const g of groups) {
      const allDone = g.list.every(isDone); // §32 Dün: sütun başlığı yerine "SKOR"
      const lg = seasonLeague(g.list[0].comp); // §33 simülasyonu olan lig: başlık lig sayfasına bağlantı
      kids.push(h("section", { class: "league", "aria-label": g.comp },
        h("div", { class: "cols", style: allDone ? "grid-template-columns:minmax(0,1fr) auto" : two ? "grid-template-columns:minmax(0,1fr) 40px 40px" : null },
          lg ? h("a", { class: "lg-link", href: `#/lig/${lg.comp}`, "aria-label": `${lg.name}: puan tablosu ve sezon simülasyonu` },
              h("span", { class: "lg-name", lang: "en" }, g.comp), h("span", { class: "lg-go", "aria-hidden": "true" }, "Tablo ›"))
            : h("span", { class: "lg-name", lang: "en", "aria-hidden": "true" }, g.comp), /* veri adları İngilizce: SPAIN, SPAİN değil */
          (allDone ? ["SKOR"] : two ? ["1", "2"] : ["1", "X", "2"]).map((c) => h("span", { "aria-hidden": "true" }, c))),
        card(g.list.map(matchRow))));
    }
  }
  kids.push(h("p", { class: "foot" }, state.sport === "minor" ? "Sayılar yüzde, sadece kendi modelden."
    : `Sayılar yüzde${state.sport === "basketball" ? " (uzatmalar dahil)" : ""}. Rozet: model piyasadan en az ${Math.round(EDGE * 100)} puan ayrılıyor.`),
    note(state.sport === "minor"), quotaLine());
  root.replaceChildren(...kids.filter(Boolean));
}
/* §32 biten maç: skor + "model ✓/✗" rozeti (modelin en yüksek olasılık verdiği sonuç gerçekleşti mi). */
const isDone = (m) => m.score != null;
function hitBadge(rep, xs) {
  if (!rep || rep.model_hit == null) return null;
  return badge(rep.model_hit ? "model ✓" : "model ✗", rep.model_hit ? "good" : "bad", xs ? "xs" : null);
}
function doneRow(m) {
  const rep = m.report, vals = probs3(m, "prob");
  const label = `${fmtTime(m.kickoff)}, bitti. ${m.home} – ${m.away}, skor ${m.score}`
    + (rep && rep.model_hit != null ? `, model ${rep.model_hit ? "bildi" : "bilemedi"}` : "");
  return h("a", { class: "mrow row", href: `#/mac/${encodeURIComponent(m.id)}`, "aria-label": label },
    h("div", { class: "mrow-top fin", "aria-hidden": "true" },
      h("span", { class: "time done" }, fmtTime(m.kickoff), h("small", {}, "bitti")),
      h("div", { class: "teams" }, ["home", "away"].map((s) => h("span", { class: "team" }, crest(m, s), h("span", { class: "nm" }, m[s])))),
      h("span", { class: "fscore" }, m.score.replace("-", "–"))),
    h("div", { class: "mrow-bot", "aria-hidden": "true" }, vals ? pbar(vals) : null, hitBadge(rep, true)));
}
function matchRow(m) {
  if (isDone(m)) return doneRow(m);
  const outs = outsOf(m);
  const vals = probs3(m, "prob"); // sitede gösterilen (diğer ligler: model)
  const top = vals ? Math.max(...vals) : null;
  const e = edgeOf(m), live = started(m);
  const label = `${fmtTime(m.kickoff)}${live ? ", başladı" : ""}. ${m.home} – ${m.away}. `
    + (vals ? outs.map((k, i) => `${SHORT[k]} %${Math.round(vals[i] * 100)}`).join(", ") : "Olasılık yok")
    + (e ? `. ${edgeText(e)} puan` : "");
  return h("a", { class: "mrow row", href: `#/mac/${encodeURIComponent(m.id)}`, "aria-label": label },
    h("div", { class: outs.length === 2 ? "mrow-top two" : "mrow-top", "aria-hidden": "true" },
      h("span", { class: live ? "time live" : "time" }, fmtTime(m.kickoff), live ? h("small", {}, "başladı") : null),
      h("div", { class: "teams" }, ["home", "away"].map((s) => h("span", { class: "team" }, crest(m, s), h("span", { class: "nm" }, m[s])))),
      vals ? vals.map((p) => h("span", { class: p === top ? "p3 top" : "p3" }, Math.round(p * 100)))
        : outs.map(() => h("span", { class: "p3" }, "–"))),
    h("div", { class: "mrow-bot", "aria-hidden": "true" }, vals ? pbar(vals) : null,
      e ? badge(edgeText(e), "accent", "xs") : null));
}

/* ---------- görünüm: lig sayfası (§33 sezon simülasyonu) ----------
   Puan tablosu + simülasyon sütunları (şampiyonluk / Avrupa / düşme %), haftalık değişim okları, tek cümlelik özet. */
const seasonLeague = (code) => ((DATA.season && DATA.season.leagues) || []).find((l) => l.comp === code) || null;
/* Türkçe tamlayan eki: Galatasaray'ın, Bayern Munich'in, Como'nun. Son ünlüye göre. Büyük harfli kısaltmalar harf
   harf okunur (PSG = pe-se-ge → PSG'nin, AEK → AEK'nın): son harfin okunuşu. */
const LETTER_SOUND = { A: "a", E: "e", I: "ı", İ: "i", O: "o", Ö: "ö", U: "u", Ü: "ü", K: "ka", H: "he", Q: "kü", W: "ve", X: "iks", Y: "ye" };
function genitive(name) {
  const vowels = "aeıioöuüAEIİOÖUÜ";
  const letters = name.replace(/[^A-Za-zÇĞİÖŞÜçğıöşü]/g, "");
  const abbr = letters.length >= 2 && letters.length <= 5 && letters === letters.toLocaleUpperCase("tr-TR")
    && name.trim().split(/\s+/).pop().replace(/[^A-Za-zÇĞİÖŞÜçğıöşü]/g, "") === letters;
  const sound = abbr ? (LETTER_SOUND[letters.slice(-1)] || `${letters.slice(-1).toLocaleLowerCase("tr-TR")}e`) : letters;
  const last = [...sound].reverse().find((c) => vowels.includes(c)) || "e";
  const v = { a: "ı", ı: "ı", e: "i", i: "i", o: "u", u: "u", ö: "ü", ü: "ü" }[last.toLocaleLowerCase("tr-TR")] || "i";
  const endsVowel = vowels.includes(sound.slice(-1));
  return `${name}'${endsVowel ? "n" : ""}${v}n`;
}
function seasonLead(lg) {
  const t = lg.teams.reduce((a, b) => (b.champion > a.champion ? b : a));
  const d = t.delta && t.delta.champion;
  const ch = d != null && Math.abs(d) >= 0.005 ? `, geçen haftaya göre ${d > 0 ? "+" : "−"}${Math.round(Math.abs(d) * 100)}` : "";
  return `${genitive(t.name)} şampiyonluk ihtimali ${pct(t.champion)}${ch}.`;
}
/* Değişim oku: ≥1 puan. good: artış iyi mi (düşmede artış kötü). Yön yazıyla da var (▲/▼ + sayı). */
function deltaArrow(d, goodUp, what) {
  if (d == null || Math.abs(d) < 0.01) return null;
  const up = d > 0, n = Math.round(Math.abs(d) * 100);
  return h("small", { class: `dl ${up === goodUp ? "g" : "b"}`, "aria-label": `${what} geçen haftaya göre ${n} puan ${up ? "arttı" : "azaldı"}` },
    `${up ? "▲" : "▼"}${n}`);
}
const zoneText = (z) => (z[0] === z[1] ? `${z[0]}.` : `${z[0]}–${z[1]}.`);
function viewLeague(root, code) {
  const lg = seasonLeague(code);
  if (!lg) { location.replace("#/"); return; }
  const z = lg.zones, T = lg.teams.length;
  const edge = (pos) => [z.ucl[1], z.europe[1], z.relegation[0] - 1, z.playoff ? z.playoff[0] - 1 : -1].includes(pos) && pos < T;
  const cell = (t, k, goodUp, what) => h("td", { class: "pc" }, pct(t[k]), t.delta ? deltaArrow(t.delta[k], goodUp, what) : null);
  const rows = lg.teams.map((t) => h("tr", { class: edge(t.pos) ? "zedge" : null },
    h("td", { class: "ps" }, t.pos),
    h("th", { scope: "row", class: "tm" },
      h("span", { class: "tn" }, crest({ logos: { home: t.logo } }, "home"), h("span", { class: "nm" }, t.name)),
      h("small", {}, `${t.played} maç · ŞL ${pct(t.ucl)} · bekl. ${Math.round(t.xpts)}${t.playoff != null && t.playoff >= 0.005 ? ` · play-off ${pct(t.playoff)}` : ""}`)),
    h("td", { class: "wcol" }, t.played), // masaüstünde ayrı sütunlar; mobilde bunlar ad altındaki küçük satırda
    h("td", {}, t.gd > 0 ? `+${t.gd}` : t.gd), h("td", { class: "pt" }, t.pts), h("td", { class: "wcol" }, Math.round(t.xpts)),
    cell(t, "champion", true, "Şampiyonluk"), h("td", { class: "pc wcol" }, pct(t.ucl)), cell(t, "europe", true, "Avrupa"),
    z.playoff ? h("td", { class: "pc wcol" }, t.playoff == null ? "–" : pct(t.playoff)) : null,
    cell(t, "relegation", false, "Düşme"))); // Düşme son sütun kalır (td:last-child dolgusu mobilde değişmesin)
  const notes = [`${fmtInt(DATA.season.n_sims)} sezon simüle edildi. Modelin takım güçleri kesin değil: her simüle sezonda güçlere, `
    + "geçmiş 4 sezonda ölçülen model hatası kadar rastgele sapma eklenir ve güçler sezon içinde haftadan haftaya biraz değişebilir. "
    + "Sakatlık ve kadro değişiklikleri ayrıca hesaba katılmaz."];
  if (code === "T1") notes.push("Türkiye Kupası şampiyonu ilk 4'teyse 5. sıra da Avrupa'ya gidebilir.");
  else notes.push("5. Şampiyonlar Ligi kontenjanı (Avrupa Performans Yeri) sezon sonunda belli olur; burada sayılmaz.");
  root.replaceChildren(
    h("div", { class: "topnav" }, backLink("#/", "Bugün")),
    screenHead(lg.name, h("p", { class: "lead" }, seasonLead(lg))),
    sec("Puan tablosu ve simülasyon", h("div", { class: "card lt-wrap" },
      h("table", { class: "ltable" },
        h("caption", { class: "sr" }, `${lg.name} puan tablosu, şampiyonluk, Avrupa ve düşme olasılıkları`),
        h("thead", {}, h("tr", {}, [["#"], ["Takım", "tm"], ["O", "wcol", "Oynanan maç"], ["Av"], ["P"],
          ["Bekl.", "wcol", "Beklenen sezon sonu puanı"], ["Şamp."], ["ŞL", "wcol", "Şampiyonlar Ligi"], ["Avrupa"],
          ...(z.playoff ? [["Play-off", "wcol", "Düşme play-off'u"]] : []), ["Düşme"]].map(([x, cls, title]) =>
          h("th", { scope: "col", class: cls || null, title: title || null }, x)))),
        h("tbody", {}, rows))),
      h("p", { class: "sec-note" }, `Çizgiler bölge sınırları: Şampiyonlar Ligi ${zoneText(z.ucl)}, Avrupa kupaları ${zoneText(z.europe)}`
        + (z.playoff ? `, düşme play-off'u ${zoneText(z.playoff)}` : "") + `, düşme ${zoneText(z.relegation)} sıra. `
        + "Oklar geçen haftaki simülasyona göre değişim (yüzde puanı). Yüzdeler bu sıralarda bitirme olasılığı. "
        + "Takım adının altında: oynanan maç, Şampiyonlar Ligi olasılığı ve beklenen sezon sonu puanı.")),
    h("div", { class: "sec" }, notes.map((t) => h("p", { class: "foot" }, t))));
}

/* ---------- görünüm: maç detayı ---------- */
const MTABS = { football: [["result", "Sonuç"], ["goals", "Gol"], ["teams", "Takımlar"]],
  basketball: [["result", "Sonuç"], ["points", "Sayı"], ["teams", "Takımlar"]] };
const fmtWhen = (iso) => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long",
  hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
function shareBtn(m) {
  const vals = probs3(m, "prob");
  const text = `${matchLabel(m)} (${m.competition}, ${fmtDateTime(m.kickoff)})`
    + (vals ? `\n${outsOf(m).map((k, i) => `${SHORT[k]} ${pct(vals[i])}`).join("  ")}` : "") + `\n${location.href}`;
  return h("a", { class: "icon-btn", href: `https://wa.me/?text=${encodeURIComponent(text)}`, target: "_blank", rel: "noopener",
    "aria-label": "Maçı WhatsApp'ta paylaş" }, icon("share", 22, 2));
}
function viewMatch(root, id, from, opts) {
  const wide = !!(opts && opts.wide); // masaüstü sağ sütun: geri bağlantısı yok, liste solda duruyor
  const back = wide ? h("span") : from === "value" ? backLink("#/degerli", "Değerli")
    : from === "options" ? backLink("#/degerli/tum", "Tüm seçenekler") : backLink("#/", "Bugün");
  const ref = byId.get(id);
  const top = h("div", { class: "topnav" }, back, ref ? shareBtn(ref.match) : null);
  if (!ref) { root.replaceChildren(top, h("p", { class: "empty" }, "Maç bulunamadı; veriler güncellenmiş olabilir.")); return; }
  const m = ref.match, nba = m.sport === "basketball";
  if (!state.mtab || state.mtab.id !== id) state.mtab = { id, tab: "result" };
  const render = () => { const y = window.scrollY; viewMatch(root, id, from, opts); window.scrollTo(0, y); };
  const rank = (side) => {
    const t = m.info && m.info.table, src = m.info && m.info[`${side}_src`];
    const r = t && src && t.find((x) => x["Takım"] === src);
    return r ? `${r["Sıra"]}. sıra` : null;
  };
  const e = m.expected, done = isDone(m), past = !nba && !e;
  const mid = done ? h("div", { class: "mid" }, h("small", {}, "Skor"),
      h("span", { class: "xg", "aria-label": `${m.home} ${m.score.split("-")[0]}, ${m.away} ${m.score.split("-")[1]}` }, m.score.replace("-", "–")))
    : past ? h("div", { class: "mid" }, h("small", {}, "Sonuç"), h("span", { class: "xg sm" }, "–"))
    : nba
    ? h("div", { class: "mid" }, h("small", {}, "Ev sahibi farkı"), h("span", { class: "xg sm" }, e.margin == null ? "–" : signedC(e.margin)),
        e.total != null ? h("small", {}, `toplam ${fmtDec(e.total)}`) : null)
    : h("div", { class: "mid" }, h("small", {}, "Beklenen gol"),
        h("span", { class: "xg", "aria-label": `${m.home} ${fmtDec(e.home)}, ${m.away} ${fmtDec(e.away)}` }, `${fmtDec(e.home)}–${fmtDec(e.away)}`));
  const side = (s) => h("div", { class: "side" }, crest(m, s, "lg"), h("b", {}, m[s]), rank(s) ? h("small", {}, rank(s)) : null);
  const tabs = past || done ? MTABS.football.filter(([k]) => k !== "goals") : MTABS[nba ? "basketball" : "football"];
  const tab = tabs.some(([k]) => k === state.mtab.tab) ? state.mtab.tab : "result";
  const head = h("header", { class: "mhead" },
    h("p", { class: "meta" }, `${m.competition} · ${fmtWhen(m.kickoff)}`, done ? " · bitti" : started(m) ? " · başladı" : ""),
    h("h1", { class: "sr" }, matchLabel(m)),
    h("div", { class: "versus" }, side("home"), mid, side("away")),
    m.report ? karneCard(m) : null,
    wide ? null : segmented("Bölüm", tabs, tab, (v) => { state.mtab.tab = v; render(); }));
  if (wide) { root.replaceChildren(top, head, ...detailGrid(m, tabs.map(([k]) => k), render), note(isMinor(m))); return; }
  const body = tab === "goals" ? goalsTab(m, render) : tab === "points" ? pointsTab(m, render)
    : tab === "teams" ? teamsTab(m) : resultTab(m, render);
  root.replaceChildren(top, head, ...body.filter(Boolean), note(isMinor(m)));
}

/* Masaüstü maç detayı: sekmeler yerine kartlar iki sütunda. Sol: olasılıklar ve iddaa (sonuç, çifte şans, gol / sayı
   pazarları); sağ: oran hareketi ve takım bilgisi (form, xG, istatistik, eksikler, puan durumu). Uyarılar üstte, notlar altta
   tam genişlik. 1280 px altında iki yığın alt alta (önce sol). */
function detailGrid(m, tabKeys, render) {
  const build = { result: () => resultTab(m, render), goals: () => goalsTab(m, render), points: () => pointsTab(m, render),
    teams: () => teamsTab(m) };
  const top = [], left = [], lines = [], right = [], bottom = [];
  for (const k of tabKeys) {
    for (const el of build[k]().filter(Boolean)) {
      const title = el.tagName === "SECTION" && el.querySelector(":scope > .sec-h");
      if (!title) (el.classList.contains("alert") ? top : bottom).push(el);
      else if (k === "teams" || title.textContent === "Oran hareketi") right.push(el);
      else (k === "result" ? left : lines).push(el);
    }
  }
  // Takım bilgisi yoksa (ör. NBA verisi kurulamadı) gol / sayı pazarları sağ sütuna: tek sütun yarım kalmasın
  if (!right.length) right.push(...lines); else left.push(...lines);
  // Biten maçta sol tek kart (Maç sonucu) kalır: oran grafiği sola geçer, sütunlar dengelenir
  const chart = right.find((el) => el.querySelector(":scope > .sec-h").textContent === "Oran hareketi");
  if (chart && left.length < 2 && right.length > 2) { right.splice(right.indexOf(chart), 1); left.push(chart); }
  const col = (xs) => (xs.length ? h("div", { class: "dcol" }, xs) : null);
  return [...top, h("div", { class: "dgrid" }, col(left), col(right)), ...bottom];
}
/* §32 Karne: gerçek skor, xG, maç öncesi son olasılıklar (piyasa / model), gerçekleşen sonuca verilen olasılık,
   modelin en olası skoru ve tek cümlelik "kim haklıydı". */
function outcomeName(m, o, dative) {
  if (o === "draw") return dative ? "beraberliğe" : "beraberlik";
  return `${o === "home" ? m.home : m.away} ${dative ? "galibiyetine" : "galibiyeti"}`;
}
function verdictText(m, rep) {
  if (!rep.verdict || !rep.model || !rep.market) return null;
  const mk = pct(rep.market.p_actual), md = pct(rep.model.p_actual), name = outcomeName(m, rep.outcome, true);
  if (rep.verdict === "equal") return `Berabere: ikisi de ${name} aynı olasılığı verdi (${md}).`;
  return rep.verdict === "model" ? `Model haklıydı: ${name} ${md} verdi, piyasa ${mk}.`
    : `Piyasa haklıydı: ${name} ${mk} verdi, model ${md}.`;
}
function karneCard(m) {
  const rep = m.report, i = OUT3.indexOf(rep.outcome);
  const line = (lab, p) => h("div", { class: "krow" }, h("span", { class: "lbl" }, lab),
    OUT3.map((o, k) => h("span", { class: k === i ? "kp act" : "kp" }, `${SHORT[o]} ${pct(p[k])}`, k === i ? h("small", {}, " ✓") : null)));
  const sc = [];
  if (rep.model_top) sc.push(`Modelin en olası skoru ${rep.model_top.score.replace("-", "–")} (${pct(rep.model_top.p)})`);
  if (rep.actual_score_p != null) sc.push(`gerçek skor ${rep.score.replace("-", "–")}: ${pct(rep.actual_score_p)}`);
  const v = verdictText(m, rep);
  return sec("Karne", padCard(
    h("div", { class: "khead" }, h("span", { class: "kscore" }, rep.score.replace("-", "–")),
      h("span", { class: "kxg" }, rep.xg ? `xG ${fmtDec(rep.xg.home, 2)} – ${fmtDec(rep.xg.away, 2)}` : "xG yok"),
      hitBadge(rep)),
    rep.market ? line("Piyasa", rep.market.p) : null,
    rep.model ? line("Model", rep.model.p) : h("p", { class: "bars-cap" }, "Bu maçta kendi model yoktu."),
    h("p", { class: "kline" }, `Gerçekleşen sonuca (${outcomeName(m, rep.outcome)}): `,
      rep.market ? `piyasa ${pct(rep.market.p_actual)}` : "", rep.model ? `, model ${pct(rep.model.p_actual)}` : "", "."),
    sc.length ? h("p", { class: "kline" }, sc.join(" · "), ".") : null,
    v ? h("p", { class: "kverdict" }, v) : null,
    h("p", { class: "bars-cap" }, "Olasılıklar maç başlamadan önceki son tahmin. ✓ gerçekleşen sonuç.")));
}

/* Seçenek satırı: seçim, adil / yurtdışı oran, beklenen değer yazısı, kupona ekle, iddaa oranı kutusu.
   big: MS için büyük "1 / X / 2" etiketi. onLive: yazarken (kar payı satırı için). */
const cap1 = (s) => s.charAt(0).toLocaleUpperCase("tr-TR") + s.slice(1);
function evText(ev, model) {
  const lab = Iddaa.evLabel(ev, model);
  if (!lab) return null;
  return { band: lab.band, text: model ? `${cap1(Iddaa.MODEL_LABEL)} · ${Iddaa.formatPct(ev)}` : `${cap1(Iddaa.BAND_NAMES[lab.band])} · ${Iddaa.formatPct(ev)}` };
}
/* iddaa oranı kutusu + beklenen değer yazısı (maç detayı ve Değerli ortak). minor: doğrulanmamış model → renk yok.
   Kutudaki oran: elle girilen, yoksa otomatik çekilen (§34). Altında "gereken %X · tahmin %Y · elle|iddaa". */
function iddaaField(m, o, minor, onLive) {
  const effective = () => iddaaOf(m.id, o.key);
  const evEl = h("span", { class: "opt-ev", "aria-live": "polite" });
  const reqEl = h("span", { class: "opt-req" });
  const wrap = h("span", { class: "opt-evs" }, evEl, reqEl);
  let input = null;
  const show = (text) => { // → oran | null (boş) | undefined (geçersiz)
    const t = String(text).trim();
    input.removeAttribute("aria-invalid");
    input.classList.remove("good");
    evEl.className = "opt-ev";
    reqEl.replaceChildren();
    if (!t) { evEl.replaceChildren(); return null; }
    const v = Iddaa.parseOdds(t);
    if (v == null) {
      input.setAttribute("aria-invalid", "true");
      evEl.className = "opt-ev bad";
      evEl.replaceChildren("Geçersiz: 1'den büyük oran yaz");
      return undefined;
    }
    const lab = evText(Iddaa.expectedValue(o.prob, v), minor);
    if (lab) {
      evEl.className = `opt-ev${lab.band === "value" ? " good" : lab.band === "low" ? " bad" : ""}`;
      if (lab.band === "value") input.classList.add("good");
      evEl.replaceChildren(lab.text);
    } else evEl.replaceChildren();
    const man = Iddaa.manual(state.iddaa, m.id, o.key), auto = Iddaa.autoOdds(state.iddaa, m.id, o.key);
    const tag = man == null && auto != null && v === auto ? "iddaa" : "elle";
    reqEl.replaceChildren(`gereken ${pct(Iddaa.required(v))} · tahmin ${pct(o.prob)}${minor ? " (doğrulanmamış)" : ""} · `,
      h("span", { class: `src ${tag === "iddaa" ? "auto" : "man"}` }, tag));
    return v;
  };
  const saved = effective();
  input = h("input", { type: "text", inputmode: "decimal", autocomplete: "off", enterkeyhint: "done", class: "inp", placeholder: "iddaa",
    value: saved == null ? "" : odds(saved),
    oninput: (ev) => { show(ev.target.value); if (onLive) onLive(); },
    onchange: (ev) => {
      const v = show(ev.target.value);
      if (v === undefined) { toast("Oran 1'den büyük bir sayı olmalı (1,85 ya da 1.85)"); return; }
      setIddaa(m.id, m.kickoff, o.key, v); // boş → elle oran silinir; otomatik oran varsa geri gelir
      const now = effective();
      ev.target.value = now == null ? "" : odds(now);
      show(ev.target.value);
      if (onLive) onLive();
    } });
  show(input.value);
  return { input, evEl: wrap };
}
function optRow(m, o, render, opts) {
  const { big, onLive } = opts || {};
  const minor = isMinor(m) || !!o.unverified; // §34 NBA'de Odds API'de olmayan iddaa çizgisi: sadece model, piyasa yok
  const { input, evEl } = iddaaField(m, o, minor, onLive);
  const d = diffOf(o);
  const flag = !minor && !big && d != null && Math.abs(d) >= EDGE;
  const blendDiff = !minor && o.market === "h2h" && blendOn(m) && o.market_prob != null && Math.abs(o.prob - o.market_prob) > 0.0005;
  // MS'de olasılık yukarıdaki büyük rakamlarda; diğer pazarlarda satırda yazılır
  const sub = o.unverified ? `Model ${pct(o.prob)} · piyasa yok · Adil ${odds(o.fair)}`
    : minor ? `Model ${pct(o.prob)} · Adil ${odds(o.fair)}`
    : `${big ? "" : `${blendDiff ? `Harman ${pct(o.prob)}` : pct(o.prob)}${o.model_prob != null ? ` (model ${pct(o.model_prob)})` : ""} · `}Adil ${odds(o.fair)} · Yurtdışı ${o.price ? odds(o.price) : "–"}`;
  const can = o.addable || minor;
  const inK = inKupon(o.key);
  // Kupona eklenemeyen seçenek (çeyrek çizgi): düğme yok, iddaa oranı ve beklenen değer yine çalışır. Çifte şans eklenir
  // (§36: skordan sonuçlanır; yurtdışı oranı yok, adil oranla girer, iddaa oranı varsa o geçer)
  const add = can ? h("button", { type: "button", class: "add-btn", "aria-pressed": inK,
    "aria-label": `${o.pick}: ${inK ? "kupondan çıkar" : "kupona ekle"}`,
    onclick: () => { toggleOption(m, o); render(); } },
    icon(inK ? "check" : "plus", 16, 2.4), inK ? "Kuponda" : "Kupona ekle") : null;
  return { input, o, el: h("div", { class: "opt row" },
    h("div", { class: "opt-main" },
      h("div", { class: "opt-pick" }, big ? h("span", { class: "k", "aria-hidden": "true" }, big) : null,
        big ? h("span", { class: "sr" }, o.pick) : o.pick,
        flag ? badge(`Model ${pts(d)}`, "accent", "xs") : null, add),
      h("span", { class: "opt-sub" }, sub),
      evEl),
    h("label", { class: "opt-in" }, h("span", { class: "sr" }, `${o.pick} iddaa oranı`), input)) };
}
const pctPlain = (x) => Iddaa.formatPct(x).replace(/^\+/, "");
/* MS kar payı: maçın tüm MS sonuçlarının iddaa oranı girilince (futbol 1-X-2, NBA 1-2). */
function marginLine(m, rows) {
  const val = h("b", {});
  const el = h("div", { class: "kv", "aria-live": "polite" }, h("span", {}, "iddaa kar payı (MS)"), val);
  const update = () => {
    const vals = rows.map((r) => Iddaa.parseOdds(r.input.value));
    const mg = Iddaa.margin(vals);
    if (mg == null || vals.length !== outsOf(m).length) {
      val.style.color = "var(--muted)";
      val.style.fontWeight = "400";
      val.textContent = m.sport === "basketball" ? "iki oranı gir" : "1, X ve 2'yi gir";
      return;
    }
    val.style.color = "";
    val.style.fontWeight = "";
    val.textContent = pctPlain(mg);
  };
  update();
  return { el, update };
}
/* Maçın seçenekleri + iddaa kaydında oranı olan ek seçenekler (§34: futbol 3 yollu handikap, NBA'de Odds API dışı çizgi). */
function optsOf(m) {
  if (!m.lines) return m.options;
  const rec = state.iddaa.matches[m.id];
  const keys = rec ? [...new Set([...Object.keys(rec.odds), ...Iddaa.autoKeys(state.iddaa, m.id)])] : [];
  return keys.length ? m.options.concat(Bulletin.extraOptions(m, keys)) : m.options;
}
function optionsCard(m, opts, render, big) {
  const rows = opts.map((o) => optRow(m, o, render, { big: big ? (m.sport === "basketball" ? SHORT[o.outcome] : SHORT[o.outcome]) : null }));
  return { rows, el: card(rows.map((r) => r.el)) };
}
function resultTab(m, render) {
  const minor = isMinor(m), nba = m.sport === "basketball";
  const outs = outsOf(m);
  const shown = probs3(m, "prob");
  const md = minor ? null : probs3(m, "model_prob");
  const mk = minor ? null : probs3(m, "market_prob");
  const out = [];
  const warn = !minor && oddsWarning();
  if (warn) out.push(warn);
  if (shown) {
    const topP = Math.max(...shown);
    const e = edgeOf(m);
    const r = (v) => v.map((x) => Math.round(x * 100)).join(" · ");
    out.push(sec("Maç sonucu", padCard(
      h("div", { class: "big3", "aria-label": outs.map((k, i) => `${nba ? (k === "home" ? m.home : m.away) : SHORT[k]} %${Math.round(shown[i] * 100)}`).join(", ") },
        outs.map((k, i) => h("div", { "aria-hidden": "true" }, h("small", {}, nba ? `${SHORT[k]} · ${k === "home" ? m.home : m.away}` : SHORT[k]),
          h("span", { class: shown[i] === topP ? "v top" : "v" }, Math.round(shown[i] * 100))))),
      h("div", { class: "bars" }, pbar(shown, "lg"), md ? pbar(md, "model") : null,
        h("div", { class: "bars-cap" },
          h("span", {}, minor ? "Sadece kendi model; piyasa yok." : md
            ? `Üst: ${blendOn(m) ? "harman" : "piyasa"} · alt: model (${r(md)})` : `${blendOn(m) ? "Harman" : "Piyasa"}; kendi model bu maçta yok.`),
          e ? badge(edgeText(e), "accent") : null),
        blendOn(m) && mk ? h("span", { class: "bars-cap" }, `Piyasa: ${r(mk)}`) : null))));
  }
  if (m.sport === "football") out.push(oddsChart(m));
  if (!nba && !minor && !m.expected) return out; // §32 geçmiş maç: donmuş 1X2 + oran grafiği; iddaa/kupon yok
  const h2h = m.options.filter((o) => o.market === "h2h");
  if (h2h.length) {
    let margin = null;
    const rows = h2h.map((o) => optRow(m, o, render, { big: SHORT[o.outcome], onLive: () => margin && margin.update() }));
    margin = marginLine(m, rows);
    out.push(sec("İddaa oranların", card(rows.map((r) => r.el), margin.el),
      h("p", { class: "sec-note" }, "iddaa'da gördüğün oranı kutuya yaz: beklenen değer = olasılık × oran − 1. ",
        minor ? "Bu ligde model doğrulanmamış; renk verilmez." : `+%${bandPct()} üstü değerli, −%${bandPct()} altı düşük, arası adil.`,
        " Oran bu cihazda kalır, Kuponum'a da geçer. Otomatik çekilen oranın altında “iddaa”, senin yazdığında “elle” yazar.")));
  }
  const dc = m.options.filter((o) => o.market === "double_chance");
  if (dc.length) out.push(sec("Çifte şans", optionsCard(m, dc, render).el));
  const hc = optsOf(m).filter((o) => o.market === "handicap3"); // §34 sadece iddaa'da çizgisi varsa
  if (hc.length) out.push(lineGroup(m, "Handikaplı MS", hc, render, (o) => o.line, hcapLabel, -1));
  out.push(explain(m));
  return out;
}
/* §31 MS piyasa olasılığının zaman içindeki değişimi: düz çizgiler piyasa (1/X/2 renkleri), kesikli yatay çizgiler model.
   Renk tek başına anlam taşımasın diye sağ uçta "1 %48" etiketleri. Veri: m.odds_trend.points [[iso, p1, px, p2], ...]. */
const TREND_COLORS = ["var(--home)", "var(--draw)", "var(--away)"];
function oddsChart(m) {
  const t = m.odds_trend;
  if (!t || !t.points || t.points.length < 2) return sec("Oran hareketi", padCard(h("p", { class: "empty-sm" }, "Oran henüz değişmedi.")));
  const pts = t.points, md = probs3(m, "model_prob");
  const all = pts.flatMap((p) => p.slice(1)).concat(md || []);
  const lo = Math.max(0, Math.floor((Math.min(...all) - 0.04) * 20) / 20), hi = Math.min(1, Math.ceil((Math.max(...all) + 0.04) * 20) / 20);
  const t0 = Date.parse(pts[0][0]), t1 = Date.parse(pts[pts.length - 1][0]);
  const L = 34, R = 268, T = 10, B = 120;
  const X = (iso) => L + ((Date.parse(iso) - t0) / Math.max(1, t1 - t0)) * (R - L);
  const Y = (v) => B - ((v - lo) / Math.max(0.01, hi - lo)) * (B - T);
  const ticks = [lo, (lo + hi) / 2, hi];
  const last = pts[pts.length - 1];
  const labs = [0, 1, 2].map((i) => ({ i, y: Y(last[i + 1]) })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < labs.length; k++) labs[k].y = Math.max(labs[k].y, labs[k - 1].y + 13);
  const first = pts[0];
  const label = "Piyasa olasılığı, " + OUT3.map((o, i) => `${SHORT[o]} %${Math.round(first[i + 1] * 100)} → %${Math.round(last[i + 1] * 100)}`).join(", ")
    + (md ? `. Model: ${OUT3.map((o, i) => `${SHORT[o]} %${Math.round(md[i] * 100)}`).join(", ")}` : "");
  return sec("Oran hareketi", padCard(
    svg("svg", { viewBox: "0 0 320 146", class: "trend", role: "img", "aria-label": label },
      ticks.map((v) => [svg("line", { x1: L, x2: R, y1: Y(v), y2: Y(v), class: "grid" }),
        svg("text", { x: L - 6, y: Y(v) + 4, class: "tick", "text-anchor": "end" }, Math.round(v * 100))]),
      md ? md.map((v, i) => svg("line", { x1: L, x2: R, y1: Y(v), y2: Y(v), class: "model", style: `stroke:${TREND_COLORS[i]}` })) : null,
      [0, 1, 2].map((i) => svg("polyline", { class: "line", style: `stroke:${TREND_COLORS[i]}`,
        points: pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[i + 1]).toFixed(1)}`).join(" ") })),
      labs.map(({ i, y }) => svg("text", { x: R + 6, y: y + 4, class: "lab" }, `${SHORT[OUT3[i]]} %${Math.round(last[i + 1] * 100)}`)),
      svg("text", { x: L, y: 140, class: "tick" }, fmtDateTime(first[0])),
      svg("text", { x: R, y: 140, class: "tick", "text-anchor": "end" }, fmtDateTime(last[0]))),
    h("p", { class: "bars-cap" }, md ? "Düz çizgi piyasa, kesikli model." : "Piyasa olasılığı; kendi model bu maçta yok.")));
}
/* Çizgi seçici (alt/üst, handikap): çipler + seçilen çizginin seçenekleri. */
function lineGroup(m, title, opts, render, keyOf, labelOf, preferred) {
  if (!opts.length) return null;
  const lines = [...new Set(opts.map(keyOf))].sort((a, b) => a - b);
  const store = state.mtab.lines || (state.mtab.lines = {});
  let cur = store[title];
  if (!lines.includes(cur)) cur = lines.reduce((a, b) => (Math.abs(b - preferred) < Math.abs(a - preferred) ? b : a), lines[0]);
  const shown = opts.filter((o) => keyOf(o) === cur);
  return sec(title,
    lines.length > 1 ? h("div", { class: "chips", role: "group", "aria-label": `${title} çizgisi` }, lines.map((l) =>
      h("button", { type: "button", class: "chip", "aria-pressed": l === cur, onclick: () => { store[title] = l; render(); } }, labelOf(l)))) : null,
    optionsCard(m, shown, render).el);
}
const hcapLabel = (l) => (l > 0 ? `${l}:0` : `0:${-l}`);
function goalsTab(m, render) {
  const minor = isMinor(m);
  const out = [];
  const tot = m.options.filter((o) => o.market === "totals");
  out.push(lineGroup(m, "Alt / üst", tot, render, (o) => o.line, (l) => `${fmtLine(l)} gol`, 2.5));
  const btts = m.options.filter((o) => o.market === "btts");
  if (btts.length) out.push(sec("Karşılıklı gol", optionsCard(m, btts, render).el));
  const ts = m.stats && m.stats.top_scores;
  if (ts && ts.length) {
    out.push(sec("En olası skorlar", padCard(h("div", { class: "scores" }, ts.map((t) => h("div", { class: "sc" }, h("b", {}, t.score), h("span", {}, pct(t.p)))))),
      h("p", { class: "sec-note" }, minor ? "Kendi modelden." : "Sitede gösterilen olasılıklarla.")));
  }
  if (!minor && tot.length) out.push(h("p", { class: "foot" }, "Model gol sayısını genelde piyasadan az bekliyor; alt/üst farklarına bu gözle bak."));
  if (out.filter(Boolean).length === 0) out.push(h("p", { class: "empty" }, "Bu maç için gol pazarı yok."));
  return out;
}
function pointsTab(m, render) {
  const e = m.expected, me = m.model_expected;
  const out = [];
  const tile = (name, mk, md) => h("div", { class: "tile" }, h("span", { class: "nm" }, name),
    h("span", { class: "big" }, mk, md != null ? h("small", {}, ` / ${md}`) : null), h("span", { class: "cap" }, md != null ? "piyasa / model" : "piyasa"));
  out.push(sec("Beklenen", h("div", { class: "card pad" }, h("div", { class: "tiles" },
    tile("Ev sahibi farkı", e.margin == null ? "–" : signedC(e.margin), me ? signedC(me.margin) : null),
    tile("Toplam sayı", e.total == null ? "–" : fmtDec(e.total), me ? fmtDec(me.total) : null)))));
  const sp = optsOf(m).filter((o) => o.market === "spreads");
  out.push(lineGroup(m, "Handikap", sp, render, (o) => Math.abs(o.line), fmtLine, Math.abs(e.margin || 0)));
  const tot = optsOf(m).filter((o) => o.market === "totals");
  out.push(lineGroup(m, "Alt / üst", tot, render, (o) => o.line, fmtLine, e.total || 0));
  out.push(h("p", { class: "foot" }, "Handikap ve alt/üst olasılıkları piyasadan; uzatmalar dahil. ",
    "iddaa'nın farklı çizgileri kendi modelden (piyasa yok, doğrulanmamış)."));
  return out;
}
/* Takımlar sekmesi. */
const RES_NAMES = { G: "galibiyet", B: "beraberlik", M: "mağlubiyet" };
function formBoxes(rows, opp) {
  return h("div", { class: "form-boxes", role: "img", "aria-label": `Son ${rows.length} maç: ${rows.map((r) => RES_NAMES[r.result] || r.result).join(", ")}` },
    rows.map((r) => h("span", { class: `fb ${r.result}`, title: `${r[opp]} ${r.score}`, "aria-hidden": "true" }, r.result)));
}
function formSection(m, homeRows, awayRows, opp, venueOf) {
  const line = (name, rows) => h("div", { class: "form-line" }, h("span", { class: "nm" }, name),
    rows && rows.length ? formBoxes(rows, opp) : h("span", { class: "muted" }, "veri yok"));
  const list = (name, rows) => (rows && rows.length ? [h("p", { class: "sec-h", style: "margin:8px 0 4px" }, name),
    h("ul", { class: "list-plain card" }, rows.map((r) => h("li", {}, h("span", {}, `${r.result} · ${r[opp]} `, h("span", { class: "muted" }, venueOf(r))),
      h("span", {}, h("b", {}, r.score), h("span", { class: "muted" }, `  ${fmtDate(r.date)}`)))))] : []);
  return sec("Form", padCard(line(m.home, homeRows), line(m.away, awayRows), h("span", { class: "sec-note", style: "margin:0" }, `Son 5 maç, en yenisi solda. ${m.sport === "basketball" ? "G galibiyet, M mağlubiyet." : "G galibiyet, B beraberlik, M mağlubiyet."}`)),
    h("details", { class: "more" }, h("summary", {}, "Maçları göster"), ...list(m.home, homeRows), ...list(m.away, awayRows)));
}
function teamsTab(m) {
  return m.sport === "basketball" ? nbaTeams(m) : footballTeams(m);
}
const XG_GAP = 0.4; // son 5 maçta maç başı gol − xG farkı bu kadarsa not düş
function footballTeams(m) {
  const out = [], i = m.info, s = m.stats;
  if (i) out.push(formSection(m, i.home_form, i.away_form, "opponent", (r) => r.venue));
  const H = s && s.home, A = s && s.away;
  if ((H && H.xg_form) || (A && A.xg_form)) {
    const t = (name, x) => h("div", { class: "tile" }, h("span", { class: "nm" }, name),
      x ? h("span", { class: "big" }, fmtDec(x.xg_for, 2), h("small", {}, ` / ${fmtDec(x.xg_against, 2)}`)) : h("span", { class: "big" }, "–"),
      h("span", { class: "cap" }, x ? `üretilen / yenen · gol ${fmtDec(x.goals_for)} / ${fmtDec(x.goals_against)}` : "veri yok"));
    out.push(sec("xG · son 5 maç ortalaması", padCard(h("div", { class: "tiles" }, t(m.home, H && H.xg_form), t(m.away, A && A.xg_form)))));
    const notes = [[m.home, H], [m.away, A]].flatMap(([name, tm]) => {
      const x = tm && tm.xg_form;
      if (!x) return [];
      const att = x.goals_for - x.xg_for, def = x.goals_against - x.xg_against;
      const n = [];
      if (att >= XG_GAP) n.push(`${name} son maçlarda xG'sinin üstünde gol atıyor (şanslı gidiyor olabilir).`);
      if (att <= -XG_GAP) n.push(`${name} son maçlarda xG'sinin altında gol atıyor (fırsatları değerlendiremiyor).`);
      if (def >= XG_GAP) n.push(`${name} rakiplerin xG'sinden fazla gol yiyor.`);
      if (def <= -XG_GAP) n.push(`${name} rakiplerin xG'sinden az gol yiyor (kalecisi/şansı iyi gidiyor).`);
      return n;
    });
    if (notes.length) out.push(...notes.map((t) => h("p", { class: "foot" }, t)));
  }
  if (H || A) {
    const two = (x, k1, k2, dp) => (x && x[k1] != null ? `${fmtDec(x[k1], dp)} – ${fmtDec(x[k2], dp)}` : "–");
    const rows = [
      ["Üst 2,5", (t) => pct(t && t.venue.over25)], ["KG var", (t) => pct(t && t.venue.btts)],
      ["Gol yemedi", (t) => pct(t && t.venue.clean_sheet)], ["Gol atamadı", (t) => pct(t && t.venue.failed_to_score)],
      ["Korner", (t) => two(t && t.corners, "for", "against", 1)], ["Sarı kart", (t) => two(t && t.yellow, "for", "against", 1)],
    ];
    const th = (name, t, where) => h("th", {}, h("span", {}, name), t ? `${where}, ${t.venue.n} maç` : "veri yok");
    out.push(sec("İstatistik", card(h("table", { class: "ttable" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), th(m.home, H, "iç saha"), th(m.away, A, "dış saha"))),
      h("tbody", {}, rows.map(([label, f]) => h("tr", {}, h("td", {}, label), h("td", {}, f(H)), h("td", {}, f(A))))))),
      h("p", { class: "sec-note" }, "Yüzdeler bu sezon: ev sahibinin iç saha, deplasmanın dış saha maçları. Korner ve kart maç başı, lehine – aleyhine.")));
  }
  const j = m.injuries;
  if (j) {
    const sign = (x) => (x > 0 ? "+" : x < 0 ? "−" : "±") + fmtDec(Math.abs(x)) + "%";
    const side = (name, t) => h("li", { style: "flex-direction:column;gap:4px" }, h("b", { style: "font-weight:600" }, name),
      h("span", { class: t && t.missing.length ? "" : "muted" }, t && t.missing.length ? t.missing.join(", ") : "Bildirilen eksik yok."),
      t && (t.attack_pct || t.defence_pct) ? h("span", { class: "muted" }, `Tahmini etki: attığı gol ${sign(t.attack_pct)}, yediği gol ${sign(t.defence_pct)}`) : null);
    out.push(sec("Eksik oyuncular", h("ul", { class: "list-plain card" }, side(m.home, j.home), side(m.away, j.away)),
      h("p", { class: "sec-note" }, "Sakat ve cezalılar. Etki, oyuncunun son 10 maçtaki süresi ve gol+asist payından hesaplanır; ",
        "bu düzeltme şimdilik sadece ölçülüyor, olasılıklara dahil değil.")));
  }
  if (i && i.table && i.table.length) {
    const cols = ["Sıra", "Takım", "O", "G", "B", "M", "Av", "P"];
    out.push(sec("Puan durumu", card(h("div", { class: "scroll-x" }, h("table", { class: "ttable" },
      h("thead", {}, h("tr", {}, cols.map((c) => h("th", { style: c === "Takım" ? "text-align:left" : null }, c === "Sıra" ? "#" : c)))),
      h("tbody", {}, i.table.map((r) => h("tr", { class: r["Takım"] === i.home_src || r["Takım"] === i.away_src ? "hl" : null },
        cols.map((c) => h("td", { style: c === "Takım" ? "text-align:left;color:var(--text)" : null }, r[c]))))))))));
  }
  if (i && i.h2h && i.h2h.length) {
    out.push(sec("Aralarındaki son maçlar", h("ul", { class: "list-plain card" }, i.h2h.map((x) =>
      h("li", {}, h("span", {}, `${x.home} `, h("b", {}, x.score), ` ${x.away}`), h("span", { class: "muted" }, fmtDate(x.date)))))));
  }
  if (!out.length) out.push(h("p", { class: "empty" }, "Bu maç için takım bilgisi yok."));
  return out;
}
function nbaTeams(m) {
  const i = m.nba_info;
  if (!i) return [h("p", { class: "empty" }, "Kendi model bu maç için kurulamadı (takım verisi yok); olasılıklar piyasadan.")];
  const out = [formSection(m, i.form.home, i.form.away, "opp", (r) => (r.home ? "iç saha" : "dış saha"))];
  const R = i.ratings || {}, H = R.home, A = R.away;
  if (H || A) {
    const v = (t, k, rk) => (t ? h("span", {}, fmtDec(t[k]), rk ? h("small", {}, ` ${t[rk]}.`) : null) : "–");
    const rows = [["Hücum", (t) => v(t, "ortg")], ["Savunma", (t) => v(t, "drtg")],
      ["Net", (t) => (t ? h("span", {}, signedC(t.net), h("small", {}, ` ${t.rank_net}.`)) : "–")], ["Tempo (pace)", (t) => v(t, "pace", "rank_pace")]];
    out.push(sec("Rating ve tempo", card(h("table", { class: "ttable" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, h("span", {}, m.home)), h("th", {}, h("span", {}, m.away)))),
      h("tbody", {}, rows.map(([label, f]) => h("tr", {}, h("td", {}, label), h("td", {}, f(H)), h("td", {}, f(A))))))),
      h("p", { class: "sec-note" }, "Rating: 100 hücumda atılan (hücum) ve yenen (savunma) sayı, rakip gücüne göre düzeltilmiş, son maçlar daha ağırlıklı. ",
        "Net = hücum − savunma; küçük sayı lig sırası. Pace: 48 dakikadaki hücum sayısı.")));
  }
  const rest = (t) => (!t || t.days == null ? "Sezonun ilk maçı" : t.b2b ? "Art arda ikinci gece (dün oynadı)" : `${t.days - 1} gün dinlendi`);
  out.push(sec("Dinlenme", card(
    h("div", { class: "kv row" }, h("span", {}, m.home), h("b", { class: i.rest.home && i.rest.home.b2b ? "warn-t" : null }, rest(i.rest.home))),
    h("div", { class: "kv row" }, h("span", {}, m.away), h("b", { class: i.rest.away && i.rest.away.b2b ? "warn-t" : null }, rest(i.rest.away))))));
  const j = i.injuries;
  const STAT = { Out: "Oynamayacak", Doubtful: "Şüpheli (zayıf ihtimal)" };
  const side = (name, list) => h("li", { style: "flex-direction:column;gap:4px" }, h("b", { style: "font-weight:600" }, name),
    list && list.length ? list.map((x) => h("span", {}, `${x.name} – `, h("span", { class: "muted" }, STAT[x.status] || x.status)))
      : h("span", { class: "muted" }, j.status === "no_report" ? "Rapor alınamadı." : "Bildirilen eksik yok."));
  out.push(sec("Eksik oyuncular", h("ul", { class: "list-plain card" }, side(m.home, j.home), side(m.away, j.away)),
    h("p", { class: "sec-note" }, j.status === "no_report"
      ? "NBA resmi sakatlık raporu bu maç için henüz yok ya da okunamadı; model eksik düzeltmesi yapmadı."
      : `Oynamayacak ve şüpheli oyuncular, son 15 maçtaki süre ve +/- katkısına göre takım rating'inden düşüldü. Ev sahibi farkına etkisi: ${signedC(j.effect)} sayı.`)));
  return out;
}
/* "Bu sayılar ne?" açıklaması (eski uzun notlar, katlanmış). */
function explain(m) {
  const minor = isMinor(m), nba = m.sport === "basketball";
  const ps = minor ? [minorNote().textContent]
    : nba ? ["Piyasa: oranlardan bahis şirketi payı ayıklanmış olasılık. Model: oranlara bakmadan son 3 sezonun NBA maçlarından kurduğumuz model (hücum/savunma rating'i, pace, ev avantajı, dinlenme ve resmi sakatlık raporundaki eksikler).",
      `Model piyasadan ${Math.round(EDGE * 100)}+ puan ayrılınca rozetle işaretlenir. NBA'de geçmiş oran olmadığı için model ile piyasa canlıda karşılaştırılıyor; 300 maç dolunca harman denenecek (Performans). Maç sonucu uzatmalar dahildir.`]
    : ["Piyasa: oranlardan bahis şirketi payı ayıklanmış olasılık. Model: oranlara bakmadan geçmiş maçlardan (gol ve xG) kurduğumuz model; Süper Lig, 5 büyük lig ve Avrupa kupalarında, diğerlerinde yok.",
      `Model piyasadan ${Math.round(EDGE * 100)}+ puan ayrılınca rozetle işaretlenir (+: model daha yüksek görüyor). Geçmiş testte piyasa daha isabetli çıktı; fark bir fikir verir, kesin değer değildir.`,
      blendOn(m) || (DATA.blend && probs3(m, "blend_prob")) ? blendNote() : null];
  return h("details", { class: "more" }, h("summary", {}, "Bu sayılar ne?"), ps.filter(Boolean).map((t) => h("p", {}, t)));
}

/* ---------- görünüm: Değerli (§30) ----------
   Liste yayında kurulur (data.json value.picks: ham model − piyasa ≥ eşik); burada iddaa oranları eklenir. */
const VALUE_NOTE = "Bu liste modelin piyasadan ayrıldığı seçenekleri gösterir; kazanç garantisi değildir. " +
  "Model piyasayı geçmişte yenemediyse bu seçimler de yenmeyebilir.";
const UNDER_NOTE = "Modelin bilinen Alt eğilimi var, takip sonucunu bekle.";
const signedPct = (x) => (x == null ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}%${Math.abs(x * 100).toFixed(1).replace(".", ",")}`);
const fmtShortWhen = (iso) => {
  const d = new Date(iso);
  return `${new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, weekday: "short" }).format(d)} ${fmtTime(iso)}`;
};
function valueRow(r) {
  const ref = byId.get(r.match);
  const m = ref && ref.match, o = m && m.options.find((x) => x.key === r.key);
  const mv = Value.move(r);
  const bars = r.minor ? [["Model", r.model_prob, "fill-model", true]]
    : [["Piyasa", r.market_prob, "fill-market"], ["Model", r.model_prob, "fill-model", true]];
  if (!r.minor && r.blend_prob != null) bars.push(["Harman", r.blend_prob, "fill-dim"]);
  const field = m && o ? iddaaField(m, o, r.minor, null) : null;
  const tags = [
    r.diff != null ? badge(`${r.diff > 0 ? "+" : "−"}${fmtDec(Math.abs(r.diff) * 100)} puan`, r.diff > 0 && !r.below ? "accent" : null) : null,
    r.minor ? badge("doğrulanmamış model", "muted") : r.below ? badge("eşik altı", "muted") : null,
    r.group ? badge(r.group, "plain") : null,
    r.minor ? badge(`Adil ${odds(r.fair)}`, "plain") : badge(`Yurtdışı ${odds(r.price)}`, "plain"),
    !r.minor ? badge(`Adil ${odds(r.fair)}`, "plain muted") : null,
    mv ? badge(`Oran ${odds(mv.first)} → ${odds(mv.last)}`, "plain muted") : null,
  ];
  return h("div", { class: "vrow row" },
    h("div", { class: "vtop" }, h("span", { class: "vpick" }, r.pick), h("span", { class: "when" }, fmtShortWhen(r.kickoff))),
    h("a", { class: "vmatch", href: `#/mac/${encodeURIComponent(r.match)}` }, `${r.home} – ${r.away}`, " ›"),
    cmpBars(bars),
    h("div", { class: "tags" }, tags),
    r.group === "Alt/Üst" ? h("p", { class: "opt-sub" }, UNDER_NOTE) : null,
    field ? h("div", { class: "vin" }, h("div", { class: "opt-main" }, h("span", { class: "opt-sub" }, "iddaa oranın"), field.evEl),
      h("label", { class: "opt-in" }, h("span", { class: "sr" }, `${r.pick} iddaa oranı`), field.input)) : null);
}
function viewValue(root) {
  const v = DATA.value;
  const render = () => viewValue(root);
  const thr = v ? Math.round(v.threshold * 100) : 4;
  const head = (seg) => h("header", { class: "hd" }, h("h1", { class: "title" }, "Değerli"), valueListSeg("value"),
    h("p", { class: "lede" }, `Modelin piyasadan en az ${thr} puan ayrıldığı seçenekler. Kazanç garantisi değildir.`), seg);
  if (!v) { root.replaceChildren(head(null), h("p", { class: "empty" }, "Bu yayında liste yok."), note()); return; }
  const { rows, minor } = Value.build(v.picks, state.iddaa, (id) => (byId.get(id) || {}).match, new Date());
  const fb = rows.filter((r) => r.sport !== "basketball"), nb = rows.filter((r) => r.sport === "basketball");
  if (!state.vsport) state.vsport = !fb.length && !minor.length && nb.length ? "basketball" : "football";
  const cur = state.vsport;
  const kids = [head(segmented("Spor", [["football", `Futbol · ${fb.length}`], ["basketball", `NBA · ${nb.length}`]], cur,
    (x) => { state.vsport = x; render(); }))];
  const list = cur === "basketball" ? nb : fb;
  const vleft = [];
  vleft.push(sec("Seçenekler", list.length ? card(list.map(valueRow))
    : padCard(h("p", { class: "muted" }, "Şu an eşiği geçen seçenek yok.")),
  h("p", { class: "sec-note" }, "Beklenen değeri pozitif olanlar (iddaa oranı girdiklerin) en üstte, sonra farka göre. ",
    "Adil oran = 1 ÷ model olasılığı; beklenen değer sitede gösterilen olasılıkla. iddaa oranı girdiğin ama eşik altında kalan ",
    "seçenekler \"eşik altı\" etiketiyle görünür.")));
  if (cur === "football" && minor.length) {
    vleft.push(sec("Diğer ligler · doğrulanmamış model", card(minor.map(valueRow)),
      h("p", { class: "sec-note" }, "Bu liglerde piyasa olasılığı yok; sadece iddaa oranı girdiğin seçenekler, model olasılığıyla. Takibe girmez.")));
  }
  kids.push(twoCol(vleft, [valueTracking(v)]), h("p", { class: "foot" }, VALUE_NOTE), note());
  root.replaceChildren(...kids);
}
function valueTracking(v) {
  const t = v.tracking;
  if (!t || !t.n) {
    return sec("Takip", padCard(h("p", { class: "muted" }, "Henüz listeye giren seçenek kaydı yok. Her yayında listeye girenler o anki olasılık ve oranlarla kaydedilir.")));
  }
  const goal = v.min_reliable;
  const mv = t.moves;
  const cell = (x, cls) => h("span", { class: cls || null }, x);
  return sec("Takip", padCard(
    h("div", { class: "progress-head" },
      h("span", { class: "bignum" }, t.settled, h("small", {}, ` / ${goal} sonuçlandı`)),
      t.reliable ? badge("Güvenilir", "good") : badge("Henüz güvenilir değil", "muted")),
    h("div", { class: "track", role: "img", "aria-label": `${t.settled} / ${goal} seçenek sonuçlandı` },
      h("span", { class: "fill-model", style: `width:${Math.max(2, Math.min(100, (t.settled / goal) * 100))}%` })),
    h("p", { class: "opt-sub" }, `${t.n} seçenek listeye girdi, ${t.pending} bekliyor${t.won ? `, ${t.won} tuttu` : ""}.`),
    h("div", { class: "vtable" },
      cell(""), cell("Tuttu"), cell("Piyasa"), cell("Model"),
      t.groups.flatMap((g) => [cell(g.group, "r"), cell(rate(g.hit_rate), g.hit_rate != null ? "r" : null),
        cell(rate(g.market_expected)), cell(rate(g.model_expected))]),
      cell("Birim kazanç", "r"), cell(""), cell(""), cell(signedPct(t.roi), t.roi != null ? (t.roi > 0 ? "good-t" : "bad-t") : null)),
    h("p", { class: "opt-sub" }, mv && mv.n
      ? `Başlamış ${mv.n} seçenekte oran ilk görülmeden son görülmeye: %${Math.round(mv.dropped * 100)}'i düştü, ortalama değişim ${signedPct(mv.mean_change)}. `
      : "Oran hareketi: henüz en az iki kez oranı görülmüş, başlamış seçenek yok. ",
      "Oranı sonradan düşen seçenekler, modelin bilgiyi erken yakaladığını gösterir. Alt/üst satırlarında modelin bilinen bir Alt eğilimi var."),
    h("details", { class: "more", style: "margin:0" }, h("summary", {}, "Pazar ayrıntısı"),
      h("div", { class: "scroll-x" }, h("table", { class: "ttable" },
        h("thead", {}, h("tr", {}, ["Pazar", "Giren", "Sonuç", "Tuttu", "Oran düştü", "Kazanç"].map((c) => h("th", {}, c)))),
        h("tbody", {}, t.groups.map((g) => h("tr", {}, h("td", {}, g.group), h("td", {}, g.n), h("td", {}, g.settled),
          h("td", {}, rate(g.hit_rate)), h("td", {}, g.moves.n ? `%${Math.round(g.moves.dropped * 100)} (${g.moves.n})` : "–"),
          h("td", {}, signedPct(g.roi))))))),
      h("p", { style: "margin-top:8px" }, "Tuttu / Piyasa / Model: sonuçlanan seçeneklerde gerçek tutma oranı ile piyasanın ve modelin ",
        "ortalama olasılığı (iadeler hariç). Model piyasadan iyiyse Tuttu, Piyasa'dan yüksek çıkar. Birim kazanç: listeye ",
        "girdiği andaki yurtdışı oranla, seçenek başına 1 birim.")),
    !t.reliable ? h("p", { class: "opt-sub" }, `En az ${goal} sonuçlanmış seçenek gerekli; bu kadar az seçenekte tutma oranı çoğunlukla şanstır.`) : null));
}

/* ---------- görünüm: Değerli > Tüm seçenekler (§36) ----------
   Modelin olasılık verdiği her seçenek (options.js), iddaa oranıyla (yoksa yurtdışı). Filtreler bu cihazda hatırlanır
   (macanaliz.filtre.v1). Masaüstünde sıralanabilir tablo. */
const OPT_PAGE = 50;
const MARKET_NAMES = [["all", "Pazar: tümü"], ["result", "Sonuç"], ["double", "Çifte şans"], ["totals", "Gol (alt/üst)"],
  ["btts", "KG"], ["handicap", "Handikap"]];
const SORT_NAMES = { value: "değer", odds: "oran", time: "saat", gap: "fark", match: "maç", pick: "seçim", required: "gereken", prob: "tahmin" };
const SRC_CLS = { iddaa: "auto", elle: "man", "yurtdışı": "ext" };
const BAND_CLS = { value: "good", low: "bad", fair: "plain", model: "muted" };
function loadFilters() {
  try { return Options.parseFilters(localStorage.getItem(Options.STORE)); } catch { return Options.defaults(); }
}
function saveFilters(f) {
  try { localStorage.setItem(Options.STORE, Options.serializeFilters(f)); } catch { /* gizli sekme: bu oturumda bellekte */ }
}
/* Gösterilen 3 günün (bugün, yarın, sonraki gün) maçlarından satırlar. Diğer ligler futbol altında. */
function optionRows() {
  const dayOf = new Map(), all = [];
  for (const sp of ["football", "basketball", "minor"]) {
    for (const d of DATA[sp] || []) {
      const off = dayOffset(d, sp === "basketball" ? "basketball" : "football");
      if (off < 0 || off > 2) continue;
      for (const m of d.matches) { dayOf.set(m.id, off); all.push(m); }
    }
  }
  return Options.collect(all, {
    now: new Date(),
    dayOf: (m) => (dayOf.has(m.id) ? dayOf.get(m.id) : null),
    extra: (m) => optsOf(m).filter((o) => o.extra),
    price: (m, o) => iddaaOf(m.id, o.key),
    source: (m, o) => Iddaa.source(state.iddaa, m.id, o.key),
    status: (m, o) => legIddaa(m.id, o.key, m.kickoff),
  });
}
/* Yerel <select> çip: items [[değer, metin]]; on: varsayılandan farklı (limon kenar). */
function fselect(label, value, items, onPick, on) {
  const sel = h("select", { class: "fsel", "aria-label": label, onchange: (e) => onPick(items[e.target.selectedIndex][0]) },
    items.map(([v, t]) => h("option", { value: String(v), selected: v === value }, t)));
  return h("span", { class: `chip fchip${on ? " on" : ""}` }, sel, icon("down", 14, 2.2));
}
const ftoggle = (text, pressed, onClick) => h("button", { type: "button", class: `chip${pressed ? " on" : ""}`, "aria-pressed": pressed,
  onclick: onClick }, text);
const dayNames = (sport) => {
  const third = weekday(ymd(new Date(Date.now() + 2 * 86400000 - (sport === "basketball" ? 8 * 3600 * 1000 : 0))));
  return sport === "basketball" ? ["Bu gece", "Yarın gece", `${cap1(third)} gecesi`] : ["Bugün", "Yarın", cap1(third)];
};
/* Filtre çubuğu (mobilde yatay kayar, masaüstünde tek satır) + sonuç sayısı ve temizle. */
function filterBar(f, rows, n, change, clear) {
  const d = Options.defaults();
  const presets = Options.MIN_ODDS_PRESETS;
  const custom = state.oCustom || (f.minOdds != null && !presets.includes(f.minOdds));
  const oddsItems = [[null, "Oran: sınırsız"], ...presets.map((p) => [p, `Oran ≥ ${odds(p)}`]),   // elle modda çip uygulanan değeri gösterir (geçersiz yazı uygulanmaz, önceki geçerli değer kalır)
    ["custom", f.minOdds == null ? "Oran: elle · sınırsız" : `Oran ≥ ${odds(f.minOdds)} · elle`]];
  const kids = [
    fselect("En düşük oran", custom ? "custom" : f.minOdds, oddsItems, (v) => {
      if (v === "custom") { state.oCustom = true; change({}); return; }
      state.oCustom = false; change({ minOdds: v });
    }, f.minOdds != null || custom),
  ];
  if (custom) {
    const err = h("span", { class: "finp-err", id: "finp-err", role: "alert", hidden: true }, "Geçersiz oran");
    const wrap = h("span", { class: "chip fchip on finp-wrap" });
    const invalid = (on) => {
      wrap.classList.toggle("bad", on);
      err.hidden = !on;
      if (on) inp.setAttribute("aria-invalid", "true"); else inp.removeAttribute("aria-invalid");
    };
    const inp = h("input", { type: "text", inputmode: "decimal", autocomplete: "off", enterkeyhint: "done", class: "inp finp",
      "aria-label": "En düşük oran (elle)", "aria-describedby": "finp-err", placeholder: "1,65",
      value: f.minOdds == null ? "" : odds(f.minOdds),
      oninput: () => invalid(false),
      onchange: (e) => {
        const t = e.target.value.trim();
        if (!t) { change({ minOdds: null }); return; }
        const v = Iddaa.parseOdds(t);
        if (v == null) { invalid(true); return; } // uygulanmaz; çip önceki geçerli değeri gösterir
        change({ minOdds: v });
      } });
    wrap.append(inp, err);
    kids.push(wrap);
  }
  const dn = dayNames(f.sport);
  kids.push(
    ftoggle("Sadece değerliler", f.onlyValue, () => change({ onlyValue: !f.onlyValue })),
    fselect("Pazar", f.market, MARKET_NAMES, (v) => change({ market: v }), f.market !== d.market),
    fselect("Spor", f.sport, [["all", "Spor: tümü"], ["football", "Futbol"], ["basketball", "Basketbol"]], (v) => change({ sport: v }),
      f.sport !== d.sport),
    fselect("Lig", f.league, [["all", "Tüm ligler"], ...Options.leagues(rows, f).map((l) => [l, l])], (v) => change({ league: v }),
      f.league !== d.league),
    fselect("Gün", f.day, [["all", "Gün: tümü"], [0, dn[0]], [1, dn[1]], [2, dn[2]]], (v) => change({ day: v }), f.day !== d.day),
    fselect("Sıralama", f.sort.by, ["value", "odds", "time", "gap"].concat(["value", "odds", "time", "gap"].includes(f.sort.by) ? [] : [f.sort.by])
      .map((k) => [k, `Sırala: ${SORT_NAMES[k]}`]), (v) => change({ sort: { by: v, dir: Options.SORTS[v] } }), false),
    ftoggle("Kapalıları göster", f.showClosed, () => change({ showClosed: !f.showClosed })));
  const k = Options.activeCount(f);
  return h("div", { class: "fwrap" },
    h("div", { class: "chips fbar", role: "group", "aria-label": "Filtreler" }, kids),
    h("div", { class: "fcount", "aria-live": "polite" },
      h("span", {}, `${n} seçenek${k ? ` · ${k} filtre` : ""}`),
      k ? h("button", { type: "button", class: "linkbtn", onclick: clear }, "Filtreleri temizle") : null));
}
function addBtnFor(r, render) {
  const ref = byId.get(r.match);
  if (!r.addable || !ref) return h("span", { class: "opt-req" }, "kupona eklenmez");
  const inK = inKupon(r.key);
  return h("button", { type: "button", class: "add-btn", "aria-pressed": inK, "aria-label": `${r.pick}: ${inK ? "kupondan çıkar" : "kupona ekle"}`,
    onclick: () => { toggleOption(ref.match, r.option); render(); } }, icon(inK ? "check" : "plus", 16, 2.4), inK ? "Kuponda" : "Kupona ekle");
}
const valueBadge = (r) => {
  const lab = r.ev == null ? null : evText(r.ev, r.unverified);
  return lab ? badge(lab.text, BAND_CLS[r.band], "xs") : null;
};
const srcTag = (r) => h("span", { class: `src ${SRC_CLS[r.src] || ""}` }, r.src);
const matchLink = (r) => h("a", { class: "vmatch", href: `#/mac/${encodeURIComponent(r.match)}` }, `${r.home} – ${r.away}`, " ›");
const reqText = (r) => `gereken ${pct(r.required)} · tahmin ${pct(r.prob)}${r.unverified ? " (doğrulanmamış)" : ""}`;
function optionItem(r, render) {
  return h("div", { class: "orow row" },
    h("div", { class: "orow-main" },
      h("div", { class: "orow-top" }, h("span", { class: "vpick" }, r.pick), valueBadge(r)),
      matchLink(r),
      h("span", { class: "opt-sub" }, `${fmtShortWhen(r.kickoff)} · ${r.competition}`),
      h("span", { class: "opt-req" }, reqText(r))),
    h("div", { class: "orow-side" },
      h("span", { class: "oodds" }, h("b", { class: "num" }, odds(r.price)), srcTag(r)),
      addBtnFor(r, render)));
}
/* Masaüstü tablosu: başlığa tıklayınca sıralama (aynı başlık → yön ters). */
function optionTable(rows, f, change, render) {
  const cols = [["match", "Maç"], ["pick", "Seçim"], ["odds", "Oran", "r"], ["required", "Gereken", "r"], ["prob", "Tahmin", "r"],
    ["value", "Değer"]];
  const th = ([by, label, cls]) => {
    const on = f.sort.by === by;
    return h("th", { class: cls || null, "aria-sort": on ? (f.sort.dir === "asc" ? "ascending" : "descending") : null, scope: "col" },
      h("button", { type: "button", class: "thbtn", onclick: () => change({ sort: Options.toggleSort(f.sort, by) }) },
        label, h("span", { class: "arr", "aria-hidden": "true" }, on ? (f.sort.dir === "asc" ? "▲" : "▼") : "")));
  };
  return h("div", { class: "card otable-wrap" }, h("table", { class: "otable" },
    h("thead", {}, h("tr", {}, cols.map(th), h("th", { scope: "col" }, h("span", { class: "sr" }, "Kupon")))),
    h("tbody", {}, rows.map((r) => h("tr", {},
      h("td", {}, matchLink(r), h("small", {}, `${fmtShortWhen(r.kickoff)} · ${r.competition}`)),
      h("td", { class: "pk" }, r.pick),
      h("td", { class: "r" }, h("b", { class: "num" }, odds(r.price)), srcTag(r)),
      h("td", { class: "r" }, pct(r.required)),
      h("td", { class: "r" }, pct(r.prob), r.unverified ? h("small", {}, "doğrulanmamış") : null),
      h("td", {}, valueBadge(r) || h("span", { class: "muted" }, "–")),
      h("td", { class: "r" }, addBtnFor(r, render)))))));
}
const valueListSeg = (cur) => segmented("Liste", [["value", "Değerli"], ["all", "Tüm seçenekler"]], cur,
  (x) => { location.hash = x === "all" ? "#/degerli/tum" : "#/degerli"; });
function viewOptions(root) {
  const render = () => {
    const bar = root.querySelector(".fbar"), sl = bar ? bar.scrollLeft : 0, y = WIDE.matches ? root.scrollTop : window.scrollY;
    viewOptions(root);
    const nb = root.querySelector(".fbar");
    if (nb) nb.scrollLeft = sl;
    if (WIDE.matches) root.scrollTop = y; else window.scrollTo(0, y);
  };
  if (!state.ofilter) state.ofilter = loadFilters();
  const all = optionRows();
  const f = Options.effective(state.ofilter, all); // kayıtlı lig artık yoksa: Tüm ligler (kayıt değişmez)
  const list = Options.apply(all, f);
  const change = (patch) => {
    Object.assign(state.ofilter, patch);
    state.optLimit = OPT_PAGE;
    saveFilters(state.ofilter);
    render();
  };
  const clear = () => { state.ofilter = Options.defaults(); state.oCustom = false; state.optLimit = OPT_PAGE; saveFilters(state.ofilter); render(); };
  const limit = state.optLimit || OPT_PAGE;
  const shown = list.slice(0, limit);
  const kids = [h("header", { class: "hd" }, h("h1", { class: "title" }, "Değerli"), valueListSeg("all"),
    h("p", { class: "lede" }, "Modelin olasılık hesapladığı bütün seçenekler, iddaa oranıyla (yoksa yurtdışı). Kazanç garantisi değildir."))];
  const sports = [...new Set(all.filter((r) => !r.minor && (f.sport === "all" || r.sport === f.sport)).map((r) => r.sport))];
  if (sports.some((sp) => !iddaaCtx(sp).fetched)) {
    kids.push(h("p", { class: "alert warn", role: "status" }, h("b", {}, "iddaa oranları yok; "), "yurtdışı oranlar gösteriliyor."));
  }
  kids.push(filterBar(f, all, list.length, change, clear));
  if (!all.length) kids.push(padCard(h("p", { class: "muted" }, "Şu an gösterilecek seçenek yok.")));
  else if (!list.length) {
    // çifte şansın yurtdışı oranı yok: iddaa oranı çekilmemişse satır çıkamaz
    const dcNoIddaa = f.market === "double" && f.sport !== "basketball" && !iddaaCtx("football").fetched;
    kids.push(padCard(h("p", { class: "muted" }, dcNoIddaa ? "Çifte şans için iddaa oranı gerekiyor." : "Bu filtrelere uyan seçenek yok."),
      Options.activeCount(f) ? h("button", { type: "button", class: "btn sm secondary", onclick: clear }, "Filtreleri temizle") : null));
  } else {
    kids.push(WIDE.matches ? optionTable(shown, f, change, render) : card(shown.map((r) => optionItem(r, render))));
    if (list.length > shown.length) {
      kids.push(h("button", { type: "button", class: "btn sm block more-btn",
        onclick: () => { state.optLimit = limit + OPT_PAGE; render(); } }, `Daha fazla göster (+${Math.min(OPT_PAGE, list.length - shown.length)})`));
    }
  }
  kids.push(h("p", { class: "foot" }, "iddaa'da kapalı ya da bültende olmayan seçenekler gizli (\"Kapalıları göster\"). Değer = tahmin × oran − 1; ",
    `+%${bandPct()} üstü değerli, −%${bandPct()} altı düşük. Diğer liglerde ve iddaa'nın ek NBA çizgilerinde model doğrulanmamış: renk yok. `,
    "Gereken = oranın başa baş olasılığı (1 ÷ oran)."), note());
  root.replaceChildren(...kids);
}

/* ---------- görünüm: Kupon (Kuponum / Önerilenler) ---------- */
function kuponHead(cur) {
  const n = state.kupon.length;
  return h("header", { class: "hd" }, h("h1", { class: "title" }, "Kupon"),
    segmented("Kupon türü", [["mine", n ? `Kuponum · ${n}` : "Kuponum"], ["suggest", "Önerilenler"]], cur,
      (v) => { location.hash = v === "mine" ? "#/kupon" : "#/kupon/oneri"; }));
}
const MONTHS_UP = (d) => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, month: "long" }).format(d);
/* Bütçe uyarısı (Kuponum, Oynadım formu, Geçmiş): %80 ve üstü. */
function budgetBanner(extra) {
  const b = History.budgetState(state.history, new Date(), extra);
  if (!b || b.level === "ok") return null;
  const used = `Bu ay ${tl(b.spent)} yatırdın, aylık bütçen ${tl(b.budget)} (%${Math.round(b.ratio * 100)}).`;
  return h("p", { class: b.level === "over" ? "alert bad" : "alert warn", role: "alert" },
    h("b", {}, b.level === "over" ? "Aylık bütçeni aştın. " : "Aylık bütçenin %80'ine geldin. "), used,
    b.level === "over" ? ` ${tl(-b.left)} fazla.` : ` Kalan ${tl(b.left)}.`);
}
/* Ay bütçesi grubu: harcanan (metin rengi) + bu kupon (uyarı rengi) çubuğu. */
function budgetSection(extra) {
  const now = new Date();
  const base = History.budgetState(state.history, now);
  const title = `${MONTHS_UP(now)} bütçesi`;
  if (!base) {
    return sec(title, padCard(h("p", { class: "opt-sub" }, "Aylık bütçe belirlenmedi. ",
      h("a", { href: "#/gecmis" }, "Geçmiş > Ayarlar"), "'dan girersen %80'e gelince ve aşınca uyarı çıkar.")));
  }
  const withK = History.budgetState(state.history, now, extra > 0 ? extra : 0);
  const p0 = Math.min(1, base.ratio), p1 = Math.min(1, withK.ratio);
  const level = withK.level;
  return sec(title, padCard(
    h("div", { class: "progress-head" },
      h("span", { class: "bignum", style: "font-size:22px" }, fmtMoney(base.spent), h("small", {}, ` / ${fmtMoney(base.budget)} TL`)),
      h("span", { class: "opt-sub" }, extra > 0 ? `Bu kuponla %${Math.round(withK.ratio * 100)}` : `%${Math.round(base.ratio * 100)}`)),
    h("div", { class: "budget-bar", role: "img", "aria-label": `Bütçenin %${Math.round(base.ratio * 100)}'i kullanıldı${extra > 0 ? `, bu kuponla %${Math.round(withK.ratio * 100)}` : ""}` },
      h("span", { class: "fill-text", style: `left:0;width:${p0 * 100}%` }),
      extra > 0 ? h("span", { class: level === "over" ? "fill-bad" : "fill-warn", style: `left:${p0 * 100}%;width:${Math.max(0, p1 - p0) * 100}%` }) : null),
    level !== "ok" ? h("span", { class: level === "over" ? "bad-t" : "warn-t", style: "font-size:12px;font-weight:600" },
      level === "over" ? `Bu kuponla bütçeyi ${tl(-withK.left)} aşıyorsun.` : `Bu kuponla bütçenin %${Math.round(withK.ratio * 100)}'ine geliyorsun.`)
      : h("span", { class: "opt-sub" }, `Kalan ${tl(withK.left)}.`)));
}
const fmtMoney = (x) => new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(x);
const DEP_TEXT = "Bu seçimler birbirine bağlı, birlikte oynamak riski çeşitlendirmez.";
function viewKupon(root) {
  const render = () => { const y = window.scrollY; viewKupon(root); window.scrollTo(0, y); };
  const legs = state.kupon;
  const kids = [kuponHead("mine")];
  const bb = budgetBanner();
  if (bb) kids.push(bb);
  if (!legs.length) {
    kids.push(padCard(h("p", { style: "font-weight:600" }, "Kuponun boş."),
      h("p", { class: "opt-sub" }, "Önerilen kuponlardan birini alabilir ya da Bugün'deki maçların detayından seçim ekleyebilirsin."),
      h("div", { class: "btn-row" }, h("a", { class: "btn secondary", href: "#/kupon/oneri" }, "Önerilenlere bak"),
        h("a", { class: "btn", href: "#/" }, "Bugün'e git"))));
    root.replaceChildren(...kids, note());
    return;
  }
  const total = legs.reduce((a, l) => a * (legPrice(l) || 1), 1);
  const probs = legs.map((l) => l.prob);
  const totalProb = probs.every((p) => p != null) ? probs.reduce((a, p) => a * p, 1) : null;
  const totalEV = Iddaa.couponEV(legs.map((l) => ({ prob: l.prob, price: legPrice(l) })));
  const unverified = legs.filter((l) => !legVerified(l)).length;
  const anyModel = legs.some(legModel);
  const dep = Iddaa.dependentLegs(legs); // §34 aynı maçtan seçimler: birbirine bağlı
  const late = [...new Set(legs.filter((l) => new Date(l.kickoff) <= new Date()).map((l) => l.match))];

  const kleft = [], kright = [];
  kleft.push(sec("Seçimler", card(legs.map((l) => {
    const ist = IDDAA_STATUS_TEXT[legIddaa(l.matchId, l.key, l.kickoff)]; // §35
    const lab = legVerified(l) ? evText(Iddaa.expectedValue(l.prob, legPrice(l)), legModel(l)) : null;
    return h("div", { class: "kleg row" },
      h("div", { class: "info" }, h("span", { class: "pick" }, l.pick),
        h("span", { class: "meta" }, `${l.match} · ${fmtShortWhen(l.kickoff)}`),
        ist ? h("span", { class: "meta bad-t", style: "font-weight:600" }, `Uyarı: ${ist}`) : null,
        h("span", { class: "meta" }, `Olasılık ${pct(l.prob)}${legModel(l) ? " (model)" : ""} · `,
          lab ? h("span", { class: lab.band === "value" ? "good-t" : lab.band === "low" ? "bad-t" : null, style: "font-weight:600" }, lab.text)
            : h("span", { class: "warn-t", style: "font-weight:600" }, l.fair ? "Adil oran — iddaa oranını yaz" : "Yurtdışı oran — iddaa oranını yaz"))),
      h("label", {}, h("span", { class: "sr" }, `${l.pick} iddaa oranı`),
        h("input", { type: "text", inputmode: "decimal", autocomplete: "off", enterkeyhint: "done", class: lab && lab.band === "value" ? "inp good" : "inp",
          value: odds(legPrice(l)),
          onchange: (ev) => {
            const t = ev.target.value.trim();
            const v = Iddaa.parseOdds(t);
            if (!t) setIddaa(l.matchId, l.kickoff, l.key, null); // boş: iddaa oranı silinir, eklendiği oran geri gelir
            else if (v != null) setIddaa(l.matchId, l.kickoff, l.key, v);
            else toast("Oran 1'den büyük bir sayı olmalı (1,85 ya da 1.85)");
            render();
          } })),
      h("button", { type: "button", class: "rm", "aria-label": `${l.pick} seçimini kaldır`,
        onclick: () => { state.kupon = state.kupon.filter((x) => x.key !== l.key); saveKupon(); render(); } }, removeIcon()));
  })), h("p", { class: "sec-note" }, "Oranlar iddaa'da gördüğün değerler; maç detayıyla ortak. Kutuyu boşaltırsan otomatik çekilen iddaa oranına, o da yoksa seçimin eklendiği orana döner.")));
  if (dep.length) kleft.push(h("div", { class: "alert warn", role: "status" },
    h("p", {}, h("b", {}, DEP_TEXT)),
    h("ul", { class: "dep-list" }, dep.map((g) => h("li", {}, `${legs[g[0]].match}: ${g.map((i) => legs[i].pick).join(" + ")}`))),
    h("p", {}, "Bahis siteleri aynı maçtan birden fazla seçimi kabul etmeyebilir.")));
  if (late.length) kleft.push(h("p", { class: "alert warn" }, h("b", {}, "Başlamış maç: "), late.join(", ")));

  const evLab = totalEV == null ? null : evText(totalEV, anyModel);
  const evCls = !evLab || anyModel ? "" : evLab.band === "value" ? "good-t" : evLab.band === "low" ? "bad-t" : "";
  let stakeText = String(state.stake).replace(".", ",");
  const payout = h("b", {}, `${fmtMoney(Math.round(state.stake * total * 100) / 100)} TL`);
  kright.push(h("div", { class: "card pad" },
    h("div", { class: "sum3" },
      h("div", {}, h("small", {}, "Toplam oran"), h("span", { class: "num" }, odds(total))),
      h("div", {}, h("small", {}, "Tutma ihtimali"), h("span", { class: "num" }, totalProb == null ? "–" : `%${fmtDec(totalProb * 100)}`)),
      h("div", {}, h("small", {}, "Beklenen değer"), h("span", { class: `num ${evCls}` }, totalEV == null ? "–" : Iddaa.formatPct(totalEV)),
        dep.length ? h("small", {}, "seçimler bağımsız sayıldı")
          : evLab ? h("small", { class: evCls || null }, anyModel ? Iddaa.MODEL_LABEL : Iddaa.BAND_NAMES[evLab.band]) : null)),
    unverified ? h("p", { class: "opt-sub" }, `${unverified} seçimde iddaa oranı yok; toplam oran ve beklenen değer o seçimlerde yurtdışı ya da adil oranla hesaplandı.`) : null,
    h("p", { class: "opt-sub" }, "Tutma ihtimali ve beklenen değer (Π olasılık × Π oran − 1) maçların bağımsız olduğu varsayımıyla."),
    h("div", { class: "hr" }),
    h("label", { class: "stake-row" }, h("span", {}, "Tutar"),
      h("span", { class: "inwrap" }, h("input", { type: "text", inputmode: "decimal", autocomplete: "off", enterkeyhint: "done", class: "inp wide",
        value: stakeText, "aria-label": "Tutar (TL)",
        oninput: (ev) => { stakeText = ev.target.value; const v = parseNum(stakeText); if (v > 0) payout.textContent = `${fmtMoney(Math.round(v * total * 100) / 100)} TL`; },
        onchange: (ev) => {
          const v = parseNum(ev.target.value);
          if (v > 0) state.stake = v; else toast("Tutar sıfırdan büyük olmalı");
          render();
        } }), "TL")),
    h("div", { class: "line-kv" }, h("span", {}, "Olası kazanç"), payout),
    h("button", { type: "button", class: state.playing ? "btn block" : "btn primary block", "aria-expanded": state.playing,
      onclick: () => { state.playing = !state.playing; state.playDraft = null; render(); } }, state.playing ? "Vazgeç" : "Oynadım"),
    state.playing && dep.length ? h("p", { class: "alert warn" }, DEP_TEXT) : null,
    state.playing ? playForm(legs, render) : null,
    h("div", { class: "btn-row" },
      h("a", { class: "btn sm", href: shareLink(legs, total, totalProb), target: "_blank", rel: "noopener" }, "WhatsApp'ta paylaş"),
      h("button", { type: "button", class: "btn sm danger", onclick: () => { state.kupon = []; state.playing = false; saveKupon(); render(); } }, "Kuponu temizle"))));
  kright.push(budgetSection(state.stake));
  kids.push(twoCol(kleft, kright));
  root.replaceChildren(...kids, note());
}
/* "Oynadım": tutar + kupon tipi (otomatik dolar, değiştirilebilir) → geçmişe kayıt. */
function playForm(legs, render) {
  const draft = state.playDraft || (state.playDraft = { stake: String(state.stake).replace(".", ","), type: History.detectType(legs),
    missing: legs.filter((l) => !legVerified(l)).map((l) => l.key) }); // form açılırken iddaa oranı olmayanlar
  const stakeVal = () => parseNum(draft.stake);
  const preview = h("div", {});
  const showBudget = () => {
    const v = stakeVal();
    preview.replaceChildren(...[budgetBanner(v > 0 ? v : 0)].filter(Boolean));
  };
  const missingLegs = legs.filter((l) => draft.missing.includes(l.key));
  const left = legs.filter((l) => !legVerified(l)).length;
  const form = h("form", { class: "play", onsubmit: (ev) => {
    ev.preventDefault();
    const v = stakeVal();
    if (!(v > 0) || !Number.isFinite(v)) { toast("Tutar sıfırdan büyük olmalı"); return; }
    const resolved = legs.map((l) => {
      const ok = legVerified(l);
      return { ...l, price: legPrice(l), fair: !ok && !!l.fair, verified: ok };
    });
    const c = History.makeCoupon(resolved, v, draft.type);
    History.applyResults({ coupons: [c] }, (DATA && DATA.results) || []);
    state.history.coupons.unshift(c);
    if (!saveHistory()) { state.history.coupons.shift(); return; }
    state.kupon = []; state.playing = false; state.playDraft = null; saveKupon();
    toast(c.unverified ? "Kupon kaydedildi — oran doğrulanmadı" : "Kupon geçmişe kaydedildi");
    location.hash = `#/gecmis/${encodeURIComponent(c.id)}`;
  } },
    h("h3", {}, "Oynadığın kuponu kaydet"),
    h("label", { class: "stake-row" }, h("span", {}, "Yatırılan tutar"),
      h("span", { class: "inwrap" }, h("input", { type: "text", inputmode: "decimal", autocomplete: "off", class: "inp wide", value: draft.stake, required: true,
        "aria-label": "Yatırılan tutar (TL)", oninput: (ev) => { draft.stake = ev.target.value; showBudget(); } }), "TL")),
    h("label", { class: "stake-row" }, h("span", {}, "Kupon tipi"),
      h("select", { class: "inp", "aria-label": "Kupon tipi", onchange: (ev) => { draft.type = ev.target.value; } },
        History.TYPES.map((t) => h("option", { value: t, selected: t === draft.type }, History.TYPE_NAMES[t])))),
    missingLegs.length ? h("div", { class: "card", style: "background:var(--surface-2)" },
      h("p", { class: "sec-h", style: "margin:12px 14px 4px" }, "iddaa oranını gir"),
      missingLegs.map((l) => h("label", { class: "kleg row", style: "grid-template-columns:minmax(0,1fr) 72px" },
        h("span", { class: "info" }, h("span", { class: "pick" }, l.pick), h("span", { class: "meta" }, l.match),
          legVerified(l) ? h("span", { class: "meta good-t" }, "✓ iddaa oranı girildi")
            : h("span", { class: "meta" }, `${l.fair ? "Adil" : "Yurtdışı"} oran ${odds(l.price)}`)),
        h("input", { type: "text", inputmode: "decimal", autocomplete: "off", class: "inp", placeholder: odds(l.price),
          value: legVerified(l) ? odds(legPrice(l)) : "", "aria-label": `${l.pick} iddaa oranı`,
          onchange: (ev) => {
            const t = ev.target.value.trim();
            const val = Iddaa.parseOdds(t);
            if (!t) setIddaa(l.matchId, l.kickoff, l.key, null);
            else if (val != null) setIddaa(l.matchId, l.kickoff, l.key, val);
            else { toast("Oran 1'den büyük bir sayı olmalı (1,85 ya da 1.85)"); return; }
            render();
          } })))) : null,
    left ? h("p", { class: "alert warn" }, `${left} seçimin iddaa oranı girilmedi. Böyle kaydedersen kupon "oran doğrulanmadı" olarak `,
      "işaretlenir; kazanç yurtdışı ya da adil orana göre hesaplanır.") : null,
    preview,
    h("p", { class: "opt-sub" }, "Tutar sadece bu cihazda saklanır; siteye ya da başka bir yere gönderilmez."),
    h("button", { type: "submit", class: "btn primary block" }, "Kaydet"));
  showBudget();
  return form;
}
function shareLink(legs, total, totalProb) {
  const lines = ["Kuponum (Maç Analiz)", ...legs.map((l) => `• ${l.pick} — ${l.match} @${odds(legPrice(l))}`
    + `${legVerified(l) ? "" : l.fair ? " (adil)" : " (yurtdışı)"}`),
    `Toplam oran: ${odds(total)}  Tutma ihtimali: ${pct(totalProb)}`];
  return `https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`;
}
/* Önerilenler: günün Düşük risk / Riskli / Market fişi kuponları (eski "Kuponlar" sekmesi). */
function viewSuggest(root) {
  const render = () => viewSuggest(root);
  if (state.sport === "minor") { state.sport = "football"; state.day = firstDay(); } // oran yok → kupon yok
  const day = days()[state.day];
  const chip = (sp, lab) => h("button", { type: "button", class: "chip", "aria-pressed": state.sport === sp,
    onclick: () => { if (state.sport !== sp) { state.sport = sp; state.day = firstDay(); render(); } } }, lab);
  const kids = [kuponHead("suggest"),
    h("div", { class: "chip-rows" },
      h("div", { class: "chips", role: "group", "aria-label": "Spor" }, chip("football", "Futbol"), chip("basketball", "Basketbol")),
      days().length > 1 ? h("div", { class: "chips", role: "group", "aria-label": "Gün" }, dayChipList(render)) : null,
      h("div", { style: "margin:2px 6px 0;text-align:left" }, oddsStamp()))];
  const warn = oddsWarning();
  if (warn) kids.push(warn);
  kids.push(h("div", { class: "cgrid" }, KINDS.map(([kind, title, desc]) => couponCard(day, kind, title, desc))));
  kids.push(note(), quotaLine());
  root.replaceChildren(...kids.filter(Boolean));
}
/* §35 Önerilen kupon iddaa'ya göre yeniden kurulur (Coupons.build): kapalı / bültende olmayan seçim düşer, yerine aynı
   kuralın sıradaki adayı girer; toplam oran, tutma ihtimali ve beklenen değer iddaa oranlarıyla. iddaa verisi yoksa ya da
   bülten bu günü henüz açmadıysa sunucunun kuponu yurtdışı oranlarla aynen gösterilir. */
const NOTE_NONE = "iddaa oranları yok; yurtdışı oranlarla kuruldu, bazı seçenekler iddaa'da kapalı olabilir.";
const NOTE_NOTYET = "iddaa henüz bu günü açmadı; kupon yurtdışı oranlarla kuruldu.";
function couponNotes(r, kind, n) {
  if (r.mode === "none") return [NOTE_NONE];
  if (r.mode === "notyet") return [NOTE_NOTYET];
  const out = [];
  if (r.closed) out.push(`Önerideki ${r.closed} seçim iddaa'da kapalı ya da yok; ${r.replaced ? `yerine ${r.replaced} yedek aday girdi` : "yedek aday kalmadı"}.`);
  else if (r.replaced) out.push(`iddaa oranlarıyla ${r.replaced} seçim değişti.`);
  if (r.unmatched) out.push(`${r.unmatched} maç iddaa bülteninde eşleşmedi.`);
  if (r.short && n) out.push(`Kurala uyan yeterli seçim kalmadı; kupon ${n} maçla (kural en az ${DATA.coupon_limits[kind].min}).`);
  if (r.legs.some((l) => l.src === "yurtdışı")) out.push("Bazı maçları iddaa henüz açmadı; onlarda yurtdışı oran.");
  return out;
}
function couponCard(day, kind, title, desc) {
  const c = day && day.coupons[kind];
  const headEl = (n) => h("div", { class: "chead" }, h("h3", {}, title), n != null ? badge(`${n} maç`, "plain muted") : null);
  if (!c) return h("section", { class: "card pad coupon-card", "aria-label": title }, headEl(null), h("p", { class: "opt-sub" }, desc),
    h("p", { class: "muted" }, "Bu güne bu kurala uygun maç yok."));
  const r = Coupons.build(kind, c, DATA.coupon_limits, { ...iddaaCtx(state.sport), dayStart: dayStartMs(day, state.sport) });
  const legs = r.legs.map((leg) => {
    const ref = byId.get(leg.match);
    const o = ref && ref.match.options.find((x) => x.key === leg.key);
    if (!o) return null;
    return h("div", { class: "cl" },
      h("div", { class: "info" }, h("span", { class: "pick" }, o.pick),
        h("span", { class: "meta" }, `${fmtTime(ref.match.kickoff)} · ${matchLabel(ref.match)}`),
        started(ref.match) ? h("span", { class: "meta warn-t", style: "font-weight:600" }, "Başladı") : null),
      h("div", { class: "r" }, h("b", {}, odds(leg.price)), h("small", {}, pct(leg.prob)),
        h("small", { class: leg.src === "yurtdışı" ? "src warn-t" : "src" }, leg.src === "elle" ? "iddaa (elle)" : leg.src)));
  }).filter(Boolean);
  const notes = couponNotes(r, kind, legs.length);
  const noteEl = notes.length ? h("div", { class: "alert warn", role: "status" }, notes.map((x) => h("p", {}, x))) : null;
  if (!legs.length) return h("section", { class: "card pad coupon-card", "aria-label": title }, headEl(0), h("p", { class: "opt-sub" }, desc),
    noteEl, h("p", { class: "muted" }, "iddaa'da bu kurala uygun seçim kalmadı."));
  const ev = r.mode === "iddaa" && r.legs.every((l) => l.src !== "yurtdışı") ? Iddaa.couponEV(r.legs) : null;
  const evLab = ev == null ? null : evText(ev, false);
  const evCls = !evLab ? "" : evLab.band === "value" ? "good-t" : evLab.band === "low" ? "bad-t" : "";
  return h("section", { class: "card pad coupon-card", "aria-label": title },
    headEl(legs.length), h("p", { class: "opt-sub" }, desc), noteEl,
    h("div", { class: "legs" }, legs),
    h("div", { class: "sum3", style: ev == null ? "grid-template-columns:repeat(2,minmax(0,1fr))" : null },
      h("div", {}, h("small", {}, "Toplam oran"), h("span", { class: "num" }, odds(r.total_odds))),
      h("div", {}, h("small", {}, "Tutma ihtimali"), h("span", { class: "num" }, pct(r.total_prob))),
      ev == null ? null : h("div", {}, h("small", {}, "Beklenen değer"), h("span", { class: `num ${evCls}` }, Iddaa.formatPct(ev)))),
    h("button", { type: "button", class: "btn secondary block", onclick: () => addCoupon(r, kind) }, "Kupona al"));
}

/* ---------- görünüm: Geçmiş (§27) ---------- */
const STATUS = { won: ["Tuttu", "good"], lost: ["Yattı", "bad"], void: ["İade", "plain"], pending: ["Bekliyor", "muted"] };
const RESULT_NAMES = { won: "Tuttu", lost: "Yattı", void: "İade" };
const statusBadge = (st) => badge(STATUS[st][0], STATUS[st][1]);
const rate = (x) => (x == null ? "–" : `%${Math.round(x * 100)}`);
const signedTL = (x) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${fmtMoney(Math.abs(Math.round(x * 100) / 100))} TL`;
const netCls = (x) => (x > 0 ? "good-t" : x < 0 ? "bad-t" : null);
const netText = (x) => h("b", { class: netCls(x) }, signedTL(x));
const manualNeeded = (c) => c.legs.some((l) => History.needsManual(l)
  || (History.legResult(l) === null && Date.now() - new Date(l.kickoff).getTime() > 7 * 86400 * 1000));
const fmtDay = (iso) => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, day: "numeric", month: "short" }).format(new Date(iso));
/* Son yedek zamanı (sadece bu cihazda, "Son yedek: …" yazısı için). */
const BSTORE = "macanaliz.yedek.v1";
function lastBackupText() {
  let t = null;
  try { t = localStorage.getItem(BSTORE); } catch { /* kayıt alanı kapalı */ }
  if (!t || isNaN(new Date(t))) return "henüz yok";
  const days = Math.floor((Date.now() - new Date(t).getTime()) / 86400000);
  return days <= 0 ? "bugün" : days === 1 ? "dün" : `${days} gün önce`;
}
function summaryCard(s, cal) {
  const decided = s.won + s.lost;
  return h("div", { class: "card pad lg" },
    h("div", {}, h("span", { class: "opt-sub" }, "Net sonuç"),
      h("div", { class: `net-big ${netCls(s.net) || ""}` }, signedTL(s.net))),
    h("div", { class: "sum3" },
      h("div", {}, h("small", {}, "Yatırılan"), h("span", { class: "plain" }, `${fmtMoney(s.staked)} TL`)),
      h("div", {}, h("small", {}, "Dönen"), h("span", { class: "plain" }, `${fmtMoney(s.returned)} TL`)),
      h("div", {}, h("small", {}, "Tutan"), h("span", { class: "plain" }, `${s.won} / ${decided}`))),
    cal.n ? h("div", { class: "rate-grid" },
      h("span", { class: "lbl" }, "Gerçekleşen"),
      h("div", { class: "track", "aria-hidden": "true" }, h("span", { class: "fill-text", style: `width:${cal.actualRate * 100}%` })),
      h("span", { class: "val" }, rate(cal.actualRate)),
      h("span", { class: "lbl" }, "Modelin beklediği"),
      h("div", { class: "track", "aria-hidden": "true" }, h("span", { class: "fill-market", style: `width:${cal.expectedRate * 100}%` })),
      h("span", { class: "val", style: "color:var(--muted);font-weight:400" }, rate(cal.expectedRate))) : null,
    h("p", { class: "opt-sub" }, `${s.won} tuttu, ${s.lost} yattı${s.void ? `, ${s.void} iade` : ""}`,
      s.pending ? ` · ${s.pending} kupon bekliyor (${tl(s.pendingStaked)}; net sonuca katılmaz)` : "",
      cal.n ? `. Tutma oranı ${cal.n} sonuçlanan kuponda, oynadığın andaki model ihtimaliyle karşılaştırılıyor.` : ""),
    cal.n ? h("details", { class: "more", style: "margin:0" }, h("summary", {}, "Tahmin ve gerçek ayrıntısı"),
      h("table", { class: "ttable" },
        h("thead", {}, h("tr", {}, ["Model ihtimali", "Kupon", "Tahmin", "Gerçek"].map((c) => h("th", {}, c)))),
        h("tbody", {}, cal.bins.map((b) => h("tr", {}, h("td", {}, `%${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}`),
          h("td", {}, b.n), h("td", {}, rate(b.pred)), h("td", {}, rate(b.obs)))))),
      h("p", { style: "margin-top:8px" }, cal.n < 30 ? `Sadece ${cal.n} kupon var; bu kadar az kuponda fark büyük ölçüde şanstır.`
        : "Elle girilen iddaa oranları değil, kuponu oynadığın andaki model ihtimali karşılaştırılır. İade seçimler sayılmaz.")) : null);
}
function typeRows(coupons) {
  const rows = History.byType(coupons).filter((r) => r.count);
  return card(rows.map((r) => h("div", { class: "trow row" }, h("span", { class: "nm" }, r.name),
    h("span", { class: "hit" }, `${r.won} / ${r.won + r.lost}`), h("span", { class: `net ${netCls(r.net) || ""}` }, signedTL(r.net)))));
}
function couponRow(c) {
  const r = History.settle(c);
  const manual = r.status === "pending" && manualNeeded(c);
  const net = r.status === "won" ? netText(r.payout - c.stake) : r.status === "lost" ? netText(-c.stake)
    : r.status === "void" ? h("b", {}, `${fmtMoney(r.payout)} TL iade`)
    : h("b", { class: "muted" }, `${fmtMoney(Math.round(c.stake * c.totalOdds * 100) / 100)} TL olası`);
  return h("a", { class: "hrow row", href: `#/gecmis/${encodeURIComponent(c.id)}` },
    h("div", { class: "info" },
      h("span", { class: "ttl" }, History.TYPE_NAMES[c.type] || c.type, c.unverified ? badge("Oran doğrulanmadı", "warn", "xs") : null),
      h("span", { class: "meta" }, `${fmtDay(c.playedAt)} · ${c.legs.length} seçim · oran ${odds(c.totalOdds)} · ${fmtMoney(c.stake)} TL`)),
    h("div", { class: "r" }, manual ? badge("Elle sonuçlandır", "warn") : statusBadge(r.status), net),
    h("span", { class: "chev" }, icon("chev", 16, 2.2)));
}
function settingsSection(render) {
  const b = History.budgetState(state.history, new Date());
  let val = state.history.budget ? String(state.history.budget).replace(".", ",") : "";
  const file = h("input", { type: "file", accept: ".json,application/json", hidden: true, onchange: async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { state.histMsg = { bad: true, text: "Dosya çok büyük; Maç Analiz yedeği değil." }; render(); return; }
    let text = "";
    try { text = await f.text(); } catch { state.histMsg = { bad: true, text: "Dosya okunamadı." }; render(); return; }
    const r = History.parseStore(text);
    if (!r.ok) { state.histMsg = { bad: true, text: `${r.error} Mevcut geçmişin değişmedi.` }; render(); return; }
    const before = state.history;
    const m = History.mergeStores(state.history, r.store);
    state.history = m.store;
    if (!saveHistory()) { state.history = before; state.histMsg = { bad: true, text: "Kaydedilemedi; mevcut geçmişin değişmedi." }; render(); return; }
    applyResults();
    state.historyError = null;
    state.histMsg = { bad: false, text: `Yedek yüklendi: ${m.added} yeni kupon${m.updated ? `, ${m.updated} güncellendi` : ""}. Mevcut kuponların silinmedi.` };
    render();
  } });
  const download = () => {
    try {
      const blob = new Blob([History.serialize(state.history)], { type: "application/json" });
      const a = h("a", { href: URL.createObjectURL(blob), download: `macanaliz-gecmis-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      try { localStorage.setItem(BSTORE, new Date().toISOString()); } catch { /* yok sayılır */ }
      render();
    } catch { toast("Yedek dosyası oluşturulamadı"); }
  };
  const theme = loadTheme();
  return sec("Ayarlar",
    state.histMsg ? h("p", { class: state.histMsg.bad ? "alert bad" : "alert good", role: "status" }, state.histMsg.text) : null,
    card(
      h("form", { class: "set-row row", onsubmit: (ev) => {
        ev.preventDefault();
        const v = parseNum(val);
        if (!val.trim()) { state.history.budget = null; saveHistory(); toast("Bütçe kaldırıldı"); render(); return; }
        if (!(v > 0) || !Number.isFinite(v)) { toast("Bütçe sıfırdan büyük olmalı"); return; }
        state.history.budget = Math.round(v * 100) / 100;
        if (saveHistory()) toast("Bütçe kaydedildi");
        render();
      } },
        h("label", { for: "budget-in" }, "Aylık bütçe"),
        h("span", { class: "inwrap", style: "display:flex;gap:8px;align-items:center" },
          h("input", { id: "budget-in", type: "text", inputmode: "decimal", autocomplete: "off", enterkeyhint: "done", class: "inp wide", value: val,
            placeholder: "yok", oninput: (ev) => { val = ev.target.value; } }),
          h("span", { class: "muted" }, "TL"),
          h("button", { type: "submit", class: "btn sm" }, "Kaydet"))),
      b ? h("p", { class: "opt-sub", style: "padding:0 14px 12px;margin-top:-4px" }, `Bu ay ${tl(b.spent)} / ${tl(b.budget)} (%${Math.round(b.ratio * 100)}). `,
        "%80'e gelince ve aşınca Kuponum'da uyarı çıkar. Kutuyu boşaltıp kaydedersen bütçe kalkar.") : null,
      h("div", { class: "set-row row" }, h("span", { id: "theme-l" }, "Tema"),
        segmented("Tema", [["system", "Sistem"], ["dark", "Koyu"], ["light", "Açık"]], theme, (v) => { setTheme(v); render(); }, "sm")),
      h("button", { type: "button", class: "link-btn row", disabled: !state.history.coupons.length, onclick: download }, "Yedekle"),
      h("button", { type: "button", class: "link-btn row", onclick: () => file.click() }, "Yedekten yükle"),
      h("button", { type: "button", class: "link-btn row upd", "aria-live": "polite", onclick: async (ev) => {
        const btn = ev.currentTarget, out = btn.querySelector(".upd-st");
        btn.disabled = true;
        out.textContent = "Denetleniyor…";
        const r = await updateApp();
        out.textContent = UPDATE_TEXT[r];
        if (r !== "activating") btn.disabled = false;
      } }, h("span", {}, "Uygulamayı güncelle"), h("span", { class: "upd-st muted" }))), file,
    h("p", { class: "sec-note" }, `Kayıtlar sadece bu cihazda. Son yedek: ${lastBackupText()}. `,
      "Tarayıcı verisi silinirse kaybolur; ara sıra yedek al. Yedekten yükleme mevcut kuponları silmez, birleştirir."));
}
function viewHistory(root) {
  const render = () => { const y = window.scrollY; viewHistory(root); window.scrollTo(0, y); };
  applyResults();
  const all = [...state.history.coupons].sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt));
  const mk = History.monthKey(new Date().toISOString());
  const month = all.filter((c) => History.monthKey(c.playedAt) === mk);
  const monthName = cap1(MONTHS_UP(new Date()));
  const period = state.hperiod || "month";
  const shown = period === "all" ? all : month;
  const kids = [screenHead("Geçmiş", segmented("Dönem", [["month", monthName], ["all", "Tüm zamanlar"]], period,
    (v) => { state.hperiod = v; render(); }))];
  if (state.historyError) kids.push(h("p", { class: "alert bad", role: "alert" }, state.historyError));
  const bb = budgetBanner();
  if (bb) kids.push(bb);
  if (!all.length) {
    kids.push(padCard(h("p", { style: "font-weight:600" }, "Henüz oynadığın kupon yok."),
      h("p", { class: "opt-sub" }, "Kupon sekmesinde kuponu kurup \"Oynadım\"a bas; burada net sonuç, tutma oranı ve kupon tiplerine göre döküm çıkar.")));
  } else if (!shown.length) {
    kids.push(padCard(h("p", { class: "muted" }, `${monthName} ayında oynanan kupon yok.`)));
  } else {
    const hleft = [summaryCard(History.summarize(shown), History.calibration(shown)), sec("Kupon tipine göre", typeRows(shown))];
    const unv = shown.filter((c) => c.unverified).length;
    kids.push(twoCol(hleft, [sec("Kuponlar", card(shown.map(couponRow)),
      unv ? h("p", { class: "sec-note" }, `${unv} kupon iddaa oranı girilmeden kaydedildi ("Oran doğrulanmadı"); kazançları gerçek iddaa oranıyla farklı olabilir.`) : null)]));
  }
  kids.push(iddaaFeedSection(render));
  kids.push(settingsSection(render));
  kids.push(h("p", { class: "foot" }, "Sonuçlar maç bittikten sonraki sabah güncellemesiyle gelir (son 7 gün). Ertelenen, iptal edilen ",
    "ya da uzatmaya giden maçlar ve LFA'da olmayan maçlar (NBA, Konferans Ligi, milli maçlar) elle sonuçlandırılır."));
  root.replaceChildren(...kids.filter(Boolean));
}
function legStatusText(l) {
  const auto = l.status === "finished" ? History.legFromScore(l.key, l.score) : null;
  if (l.manual) return `Elle: ${RESULT_NAMES[l.manual]}${auto ? ` (otomatik: ${RESULT_NAMES[auto]}, skor ${l.score})` : ""}`;
  if (l.status === "finished") return `Skor ${l.score} → ${auto ? RESULT_NAMES[auto] : "sonuçlandırılamadı"}`;
  if (l.status === "postponed") return "Ertelendi — iddaa kuralına göre elle sonuçlandır";
  if (l.status === "cancelled") return "İptal — iddaa kuralına göre elle sonuçlandır";
  if (l.status === "aet") return `Uzatmaya gitti (${l.score}) — 90 dakika sonucuna göre elle sonuçlandır`;
  return new Date(l.kickoff) <= new Date() ? "Sonuç bekleniyor" : "Oynanmadı";
}
function viewHistoryDetail(root, id) {
  const render = () => { const y = window.scrollY; viewHistoryDetail(root, id); window.scrollTo(0, y); };
  applyResults();
  const c = state.history.coupons.find((x) => x.id === id);
  const top = h("div", { class: "topnav" }, backLink("#/gecmis", "Geçmiş"));
  if (!c) { root.replaceChildren(top, h("p", { class: "empty" }, "Kupon bulunamadı.")); return; }
  const r = History.settle(c);
  const touch = () => { c.updatedAt = new Date().toISOString(); saveHistory(); render(); };
  const choice = (l, val, label) => h("button", { type: "button", "aria-pressed": (l.manual || null) === val,
    onclick: () => { l.manual = val; touch(); } }, label);
  const net = r.payout == null ? null : r.payout - c.stake;
  root.replaceChildren(top,
    h("header", { class: "hd tight", style: "padding-top:4px" }, h("h1", { class: "title" }, "Oynanan kupon"),
      h("div", { class: "title-row" }, h("span", { class: "lede" }, fmtDateTime(c.playedAt)), statusBadge(r.status))),
    c.unverified ? h("p", { class: "alert warn" }, h("b", {}, "Oran doğrulanmadı: "),
      "bazı seçimlerin iddaa oranı girilmeden kaydedildi; oran ve kazanç yurtdışı ya da adil orana göre.") : null,
    h("div", { class: "card pad" },
      h("div", { class: "sum3" },
        h("div", {}, h("small", {}, "Toplam oran"), h("span", { class: "num" }, odds(c.totalOdds))),
        h("div", {}, h("small", {}, "Tutma ihtimali"), h("span", { class: "num" }, pct(c.totalProb))),
        h("div", {}, h("small", {}, "Net"), h("span", { class: `num ${net == null ? "" : netCls(net) || ""}` }, net == null ? "–" : signedTL(net)))),
      h("div", { class: "hr" }),
      h("div", { class: "line-kv" }, h("span", {}, "Yatırılan"), h("b", {}, tl(c.stake))),
      h("div", { class: "line-kv" }, h("span", {}, "Dönen"), h("b", {}, r.payout == null ? "–" : tl(r.payout))),
      r.status === "won" && r.odds !== c.totalOdds ? h("p", { class: "opt-sub" }, `İade seçimler oran 1 sayıldı: geçerli oran ${odds(r.odds)}.`) : null,
      h("label", { class: "stake-row" }, h("span", {}, "Kupon tipi"),
        h("select", { class: "inp", onchange: (ev) => { c.type = ev.target.value; touch(); } },
          History.TYPES.map((t) => h("option", { value: t, selected: t === c.type }, History.TYPE_NAMES[t]))))),
    sec("Seçimler", card(c.legs.map((l) => h("div", { class: "hleg row" },
      h("div", { class: "info" }, h("span", { class: "pick" }, l.pick),
        h("span", { class: "meta" }, `${l.match} · ${fmtDateTime(l.kickoff)}`),
        h("span", { class: "meta" }, `Oran ${odds(l.price)}${l.fair ? " (adil)" : ""}${l.verified === false ? " (doğrulanmadı)" : ""} · olasılık ${pct(l.prob)}`),
        h("span", { class: History.needsManual(l) ? "meta warn-t" : "meta", style: History.needsManual(l) ? "font-weight:600" : null }, legStatusText(l))),
      h("div", { class: "seg sm", role: "group", "aria-label": `${l.pick} sonucu` },
        choice(l, null, "Otomatik"), choice(l, "won", "Tuttu"), choice(l, "lost", "Yattı"), choice(l, "void", "İade"))))),
      h("p", { class: "sec-note" }, "\"Otomatik\" maç skoruna göre sonuçlandırır; elle seçtiğin sonuç her zaman önce gelir. ",
        "Bir seçim yatınca kupon yatar; İade seçilen maçın oranı 1 sayılır.")),
    h("button", { type: "button", class: "btn danger block", onclick: () => {
      if (!confirm("Bu kupon geçmişten silinsin mi? Geri alınamaz (yedeğin yoksa).")) return;
      state.history.coupons = state.history.coupons.filter((x) => x.id !== c.id);
      if (saveHistory()) { toast("Kupon silindi"); location.hash = "#/gecmis"; }
    } }, "Kuponu sil"));
}

/* ---------- görünüm: Performans ---------- */
const brier = (x) => (x == null ? "–" : Number(x).toFixed(3).replace(".", ","));
const brier4 = (x) => (x == null ? "–" : Number(x).toFixed(4).replace(".", ","));
const fmtInt = (x) => Number(x).toLocaleString("tr-TR");
/* Kalibrasyon grafiği (TASARIM.md: köşegen kesikli, model çizgisi vurgu, nokta boyutu maç sayısıyla). */
function calibrationChart(bins, label) {
  const X = (v) => 40 + v * 240, Y = (v) => 260 - v * 240;
  const used = bins.filter((b) => b.n > 0 && b.pred != null && b.obs != null);
  const maxN = Math.max(1, ...used.map((b) => b.n));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const last = used[used.length - 1];
  return svg("svg", { viewBox: "0 0 330 290", class: "calib", role: "img", "aria-label": label },
    ticks.slice(1).map((t) => svg("line", { x1: 40, x2: 300, y1: Y(t), y2: Y(t), class: "grid" })),
    svg("line", { x1: 40, x2: 300, y1: 260, y2: 260, class: "axis" }),
    svg("line", { x1: X(0), y1: Y(0), x2: X(1), y2: Y(1), class: "diag" }),
    used.length > 1 ? svg("polyline", { points: used.map((b) => `${X(b.pred).toFixed(1)},${Y(b.obs).toFixed(1)}`).join(" "), class: "path" }) : null,
    used.map((b) => svg("circle", { cx: X(b.pred).toFixed(1), cy: Y(b.obs).toFixed(1), r: (3.5 + 3.5 * Math.sqrt(b.n / maxN)).toFixed(1), class: "dot" },
      svg("title", {}, `Tahmin ${pct(b.pred)}, gerçekleşen ${pct(b.obs)} (${fmtInt(b.n)} olay)`))),
    ticks.map((t) => [
      svg("text", { x: X(t), y: 278, class: "tick", "text-anchor": "middle" }, Math.round(t * 100)),
      svg("text", { x: 32, y: Y(t) + 4, class: "tick", "text-anchor": "end" }, Math.round(t * 100))]),
    last ? svg("text", { x: Math.min(X(last.pred) + 10, 290), y: Math.max(Y(last.obs) - 6, 34), class: "lab", "text-anchor": X(last.pred) + 10 > 260 ? "end" : "start" }, "model") : null,
    svg("text", { x: 236, y: 14, class: "lab m" }, "kusursuz"));
}
/* Kalibrasyon için tek cümle: en yüksek olasılık diliminde model ne dedi, ne oldu. */
function calibLead(bins) {
  const total = bins.reduce((a, b) => a + (b.n || 0), 0);
  const used = bins.filter((b) => b.n >= 30 && b.pred != null && b.obs != null);
  const top = used[used.length - 1];
  if (total < 300 || !top) return h("p", { class: "lead" }, `Henüz az veri (${fmtInt(total)} olay): noktalar büyük ölçüde şansa bağlı.`);
  const d = top.obs - top.pred;
  const head = d > 0.03 ? "Model favorileri hafife alıyor: " : d < -0.03 ? "Model favorileri abartıyor: " : "Yüksek olasılıklarda tahminler dürüst: ";
  return h("p", { class: "lead" }, head, h("b", {}, pct(top.pred)), " dediği seçenekler ", h("b", {}, pct(top.obs)), " tuttu.");
}
function liveRow(name, n, goal, unit, cap) {
  const p = goal ? Math.min(1, n / goal) : 0;
  return h("div", { class: "live row" },
    h("div", { class: "lt" }, h("span", {}, name), h("b", {}, fmtInt(n), h("small", {}, ` / ${fmtInt(goal)} ${unit}`))),
    h("div", { class: "track", role: "img", "aria-label": `${fmtInt(n)} / ${fmtInt(goal)} ${unit}` },
      h("span", { class: "fill-model", style: `width:${p * 100}%;min-width:6px` })),
    h("span", { class: "cap" }, cap));
}
function viewPerformance(root) {
  const render = () => { const y = window.scrollY; viewPerformance(root); window.scrollTo(0, y); };
  const p = DATA.performance, bl = DATA.blend, nb = DATA.performance_nba, v = DATA.value;
  const kids = [h("header", { class: "hd tight" }, h("h1", { class: "title" }, "Performans"),
    h("p", { class: "lede" }, "Model ne kadar isabetli, piyasayı geçiyor mu?"))];

  // CANLI ÖLÇÜM: karar sayaçları
  const live = [];
  if (p) live.push(liveRow("Futbol tahminleri", p.n || 0, p.min_reliable || 30, "maç",
    p.n ? `Favori tuttu ${pct(p.favorite_hit)}. ${p.n < p.min_reliable ? `${p.min_reliable} maçtan sonra daha anlamlı.` : "Ayrıntı aşağıda."}`
      : "Maçlar bittikçe başlamadan önceki son tahminler gerçek sonuçla karşılaştırılır."));
  if (bl) {
    const l = bl.live;
    live.push(liveRow("Futbol: harman ve piyasa", l ? l.n : 0, l ? l.min_n : 200, "maç",
      l && l.n ? `Brier harman ${brier(l.blend_brier)}, piyasa ${brier(l.market_brier)}. ${l.n < l.min_n ? `${l.min_n} maçta karar: harman kötüyse site piyasaya döner.`
        : bl.use_on_site ? "Harman canlıda piyasadan kötü değil; sitede harman." : "Sitede piyasa olasılığı gösteriliyor."}`
        : bl.use_on_site ? `${l ? l.min_n : 200} maçta karar: harman kötüyse site piyasaya döner.` : "Sitede piyasa olasılığı gösteriliyor."));
  }
  if (nb) {
    const b = nb.blend;
    live.push(liveRow("NBA: model ve piyasa", b.decided_at ? b.need : b.n, b.need, "maç", b.decided_at
      ? `${fmtDate(b.decided_at)} karar: son 100 maçta Brier harman ${brier(b.blend_brier)}, piyasa ${brier(b.market_brier)}; sitede ${b.use_on_site ? "harman" : "piyasa"}.`
      : `${b.need} maçta NBA harmanı öğrenilir; son 100 maçta piyasayı geçerse sitede gösterilir.`));
  }
  if (v && v.tracking) live.push(liveRow("Değerli takibi", v.tracking.settled, v.min_reliable, "seçenek",
    `${v.min_reliable} sonuçlanmış seçenekten sonra güvenilir.`));
  // Sıra mobildekiyle aynı (canlı, geçmiş test, kalibrasyon, NBA, diğer ligler); masaüstünde ikiye bölünür
  const pleft = [live.length ? sec("Canlı ölçüm", card(live)) : null, ...(p && p.n ? liveFootball(p) : []), ...backtestFootball()];
  const pright = [calibrationSection(render), ...(nb ? nbaPerf(nb) : []), ...minorPerf()];
  kids.push(twoCol(pleft, pright));
  kids.push(note());
  root.replaceChildren(...kids.filter(Boolean));
}
/* Canlı futbol: pazar bazında Brier (sitede gösterilen / kendi model / kıyas), son maçlar. */
function liveFootball(p) {
  const out = [];
  const hasModel = p.markets.some((m) => m.model_n > 0);
  out.push(sec(`Futbol · canlı (${p.n} maç)`, card(h("div", { class: "vtable", style: "padding:12px 14px" },
    h("span", {}, "Brier"), h("span", {}, "Sitede"), h("span", {}, hasModel ? "Model" : ""), h("span", {}, "Kıyas"),
    p.markets.flatMap((m) => [h("span", { class: "r" }, m.name),
      h("span", { class: m.brier != null && m.brier < m.baseline ? "r good-t" : "r", style: "font-weight:600" }, brier(m.brier)),
      h("span", {}, hasModel ? brier(m.model_brier) : ""), h("span", {}, brier(m.baseline))]))),
  h("p", { class: "sec-note" }, `${fmtDate(p.from)} – ${fmtDate(p.to)}. Brier: tahmin ile sonuç arasındaki farkın karesi; düşük daha iyi. `,
    "Kıyas: hiçbir bilgi olmadan tahmin (1X2'de her sonuca %33, diğerlerinde %50); kıyastan düşük (yeşil) tahminler işe yarıyor.")));
  const inj = p.injury;
  if (inj && inj.n) {
    out.push(h("p", { class: "foot" }, `Sakatlık düzeltmesi (deneme): ${inj.n} maçta kendi model Brier ${brier(inj.model_brier)}, eksik oyuncularla `,
      `${brier(inj.injury_brier)}. `, inj.proven ? "Düzeltme işe yarıyor."
        : `Kanıt için en az ${inj.min_n} maçta farkın standart hatasından büyük olması gerekiyor; o zamana kadar olasılıklara katılmaz.`));
  }
  if (p.recent && p.recent.length) {
    const WHO = { model: "Model haklı", market: "Piyasa haklı", equal: "Eşit" };
    out.push(sec("Son maçlar", card(
      h("div", { class: "recent-row kr head row", "aria-hidden": "true" }, h("span", {}, "MAÇ"), h("span", { class: "c" }, "SKOR"),
        h("span", { class: "c" }, "MODEL"), h("span", { class: "c" }, "KİM")),
      p.recent.map((r) => h("div", { class: "recent-row kr row", role: "group", "aria-label": `${r.home} – ${r.away} ${r.score}. `
          + (r.model_hit == null ? "Model yok." : `Model ${r.model_hit ? "bildi" : "bilemedi"}.`)
          + (r.verdict ? ` ${WHO[r.verdict]}: gerçekleşen sonuca model ${pct(r.p_actual_model)}, piyasa ${pct(r.p_actual_market)}.` : "") },
        h("span", { class: "m", "aria-hidden": "true" }, h("span", {}, `${r.home} – ${r.away}`), h("small", {}, fmtDate(r.kickoff))),
        h("span", { class: "c sc", "aria-hidden": "true" }, r.score),
        h("span", { class: "c", "aria-hidden": "true" }, r.model_hit == null ? "–" : hitBadge(r, true)),
        h("span", { class: "c who", "aria-hidden": "true" }, r.verdict ? WHO[r.verdict] : "–",
          r.verdict ? h("small", {}, `${pct(r.p_actual_model)} / ${pct(r.p_actual_market)}`) : null)))),
    h("p", { class: "sec-note" }, "Model ✓: modelin en yüksek olasılık verdiği sonuç oldu. Kim: gerçekleşen sonuca daha yüksek olasılık veren (log loss); altında model / piyasa.")));
  }
  return out;
}
/* Brier çubukları: eksen 0'dan değil, yazılı bir değerden başlar (farklar görünür olsun). */
function brierBars(rows) {
  const vals = rows.map((r) => r[1]).filter((x) => x != null);
  const lo = Math.floor((Math.min(...vals) - 0.004) * 200) / 200;
  const hi = Math.max(...vals) + (Math.max(...vals) - lo) * 0.06;
  return { lo, el: h("div", { class: "brier" }, rows.flatMap(([name, x, cls, strong]) => [
    h("span", { class: strong ? "lbl strong" : "lbl" }, name),
    h("div", { class: "track xl", "aria-hidden": "true" }, h("span", { class: cls, style: `width:${x == null ? 0 : Math.max(2, ((x - lo) / (hi - lo)) * 100)}%` })),
    h("span", { class: strong ? "val strong" : "val" }, brier4(x))])) };
}
function backtestFootball() {
  const b = DATA.backtest, bl = DATA.blend;
  if (!b) return [];
  const onSite = bl && bl.use_on_site;
  const rows = [["Piyasa (kapanış)", b.market.brier, "fill-market", !onSite], ["Kendi model", b.model.brier, "fill-dim"]];
  const marketBetter = b.market.brier <= b.model.brier;
  const bars = brierBars(rows);
  const out = [sec("Geçmiş test · futbol", padCard(
    h("p", { class: "lead" }, `${fmtInt(b.n)} maçta kapanış oranları kendi modelden `, h("b", {}, marketBetter ? "daha isabetli" : "geride"),
      marketBetter ? "; bu yüzden sitede piyasa (ya da harman) gösterilir, model yanında bilgi olarak durur." : "."),
    bars.el,
    h("div", { class: "line-kv" }, h("span", {}, "Favori tuttu"), h("b", {}, `piyasa ${pct(b.market.accuracy)} · model ${pct(b.model.accuracy)}`)),
    h("span", { class: "opt-sub" }, `Brier skoru, kısa çubuk daha iyi. Çubuklar ${fmtDec(bars.lo, 3)}'ten başlıyor. Süper Lig ve 5 büyük lig, `,
      `${fmtDate(b.from)} – ${fmtDate(b.to)}; model her hafta sadece o haftadan önceki maçlarla yeniden kuruldu.`)))];
  if (bl && bl.blend_brier != null) {
    const hb = brierBars([["Piyasa", bl.market_brier, "fill-market"], ["Harman", bl.blend_brier, "fill-model", true]]);
    out.push(sec("Harman (piyasa + model)", padCard(
      h("p", { class: "lead" }, `Geçen sezonla öğrenildi, bu sezonun ${fmtInt(bl.n_test)} maçında test edildi: harman `,
        h("b", {}, bl.blend_brier < bl.market_brier ? "piyasayı az farkla geçti" : "piyasayı geçemedi"), "."),
      hb.el,
      h("span", { class: "opt-sub" }, `Çubuklar ${fmtDec(hb.lo, 3)}'ten başlıyor. Fark ${bl.diff > 0 ? "+" : "−"}${fmtDec(Math.abs(bl.diff), 4)}`,
        bl.se != null ? ` ± ${fmtDec(bl.se, 4)}` : "", `. Sitede ${bl.use_on_site ? "harman" : "piyasa"} gösteriliyor`,
        bl.use_on_site ? " (fark standart hatasından büyük, ama küçük)." : "."))));
  }
  return out;
}
/* Kalibrasyon: canlı, geçmiş test (piyasa) ve diğer ligler (model) arasında seçim. */
function calibrationSection(render) {
  const srcs = [];
  const p = DATA.performance, b = DATA.backtest, mi = DATA.minor_info && DATA.minor_info.backtest;
  const onSite = DATA.blend && DATA.blend.use_on_site;
  if (p && p.n && p.calibration) srcs.push(["live", "Canlı", p.calibration,
    "Canlı ölçümdeki 1, X, 2, Üst 2,5 ve KG Var tahminlerinin hepsi.", "Kalibrasyon grafiği, canlı ölçüm"]);
  if (b && b.calibration && b.calibration.length && !onSite) srcs.push(["backtest", "Geçmiş test", b.calibration,
    "Geçmiş testteki sitede gösterilen 1, X, 2 olasılıkları.", "Kalibrasyon grafiği, geçmiş test"]);
  if (mi && mi.calibration && mi.calibration.length) srcs.push(["minor", "Diğer ligler", mi.calibration,
    "Diğer liglerde kendi modelin geçmiş testi.", "Kalibrasyon grafiği, diğer ligler"]);
  if (!srcs.length) return null;
  const events = (bins) => bins.reduce((a, x) => a + (x.n || 0), 0);
  if (srcs[0][0] === "live" && events(srcs[0][2]) < 300 && srcs.length > 1) srcs.push(srcs.shift()); // az veride önce geçmiş test
  const cur = srcs.find((s) => s[0] === state.calsrc) || srcs[0];
  return sec("Kalibrasyon",
    srcs.length > 1 ? segmented("Kalibrasyon kaynağı", srcs.map((s) => [s[0], s[1]]), cur[0], (x) => { state.calsrc = x; render(); }, "sm") : null,
    padCard(calibLead(cur[2]), calibrationChart(cur[2], cur[4]),
      h("span", { class: "opt-sub" }, "Yatay: tahmin (%). Dikey: gerçekleşen (%). Nokta büyüklüğü olay sayısı. Noktalar kesikli çizgiye yakınsa ",
        `olasılıklar dürüst: %70 denilenler 10'da 7 tutuyor. ${cur[3]}`),
      h("details", { class: "more", style: "margin:0" }, h("summary", {}, "Dilim tablosu"),
        h("table", { class: "ttable" }, h("thead", {}, h("tr", {}, ["Dilim", "Tahmin", "Gerçek", "Olay"].map((c) => h("th", {}, c)))),
          h("tbody", {}, cur[2].filter((x) => x.n).map((x) => h("tr", {},
            h("td", {}, `%${Math.round(x.lo * 100)}–${Math.round(x.hi * 100)}`), h("td", {}, pct(x.pred)),
            h("td", {}, pct(x.obs)), h("td", {}, fmtInt(x.n)))))))));
}
/* §28 NBA: geçmiş test (iki kutu), canlı ölçüm tablosu, son maçlar. */
function nbaPerf(p) {
  const out = [];
  const num = (x, d) => (x == null ? "–" : fmtDec(x, d));
  const b = p.backtest;
  if (b) {
    out.push(sec("Geçmiş test · NBA",
      h("div", { class: "tiles" },
        h("div", { class: "tile surface" }, h("span", { class: "cap" }, "İsabet"), h("span", { class: "big" }, `%${fmtDec(b.plain.accuracy * 100)}`),
          h("span", { class: "cap" }, `${b.season} · ${fmtInt(b.plain.n)} maç`)),
        h("div", { class: "tile surface" }, h("span", { class: "cap" }, "Fark hatası"), h("span", { class: "big" }, num(b.plain.mae_margin)),
          h("span", { class: "cap" }, "sayı, ortalama"))),
      h("p", { class: "sec-note" }, `Brier ${brier4(b.plain.brier)}; hep ev sahibini seçmek ${brier4(b.baseline_brier)}. Piyasayla karşılaştırma canlıda.`),
      h("details", { class: "more" }, h("summary", {}, "Eksik düzeltmesiyle karşılaştır"),
        h("div", { class: "card" }, h("div", { class: "scroll-x" }, h("table", { class: "ttable" },
          h("thead", {}, h("tr", {}, ["Model", "Brier", "Favori", "Fark h.", "Toplam h."].map((c) => h("th", {}, c)))),
          h("tbody", {}, [["Düzeltmesiz", b.plain], ["Eksik düzeltmeli", b.absence]].map(([name, r]) => h("tr", {},
            h("td", {}, name), h("td", {}, brier4(r.brier)), h("td", {}, pct(r.accuracy)), h("td", {}, num(r.mae_margin)), h("td", {}, num(r.mae_total)))))))),
        h("p", { style: "margin-top:8px" }, "Her gün sadece o günden önceki maçlarla yeniden kurulan model; ayarlar bir önceki sezonda seçildi. ",
          "Eksik düzeltmeli satırda eksikler maç kaydından çıkarıldı (biraz iyimser); canlıda resmi rapor kullanılır ve ayrı ölçülür."))));
  }
  const NAMES = { market: "Piyasa", model: "Kendi model", model_injury: "Model + rapor", blend: "Harman" };
  const rows = p.markets.filter((r) => r.n);
  if (rows.length) {
    out.push(sec(`NBA · canlı (${p.n} maç)`, card(h("div", { class: "vtable", style: "padding:12px 14px" },
      h("span", {}, ""), h("span", {}, "Brier"), h("span", {}, "Favori"), h("span", {}, "Fark h."),
      rows.flatMap((r) => [h("span", { class: "r" }, NAMES[r.key] || r.key), h("span", { class: "r", style: "font-weight:600" }, brier(r.brier)),
        h("span", {}, pct(r.accuracy)), h("span", {}, num(r.mae_margin))]))),
    h("p", { class: "sec-note" }, `Brier kıyası (her maça %50): 0,250. Fark hatası: ev sahibi sayı farkı tahmininin ortalama mutlak hatası.`,
      p.n < p.min_reliable ? ` Henüz az veri (${p.n} maç): sonuçlar şansa çok bağlı.` : "",
      p.injury && p.injury.n ? ` Resmi sakatlık raporu düzeltmesi: ${p.injury.n} maçın ${p.injury.with_report}'inde rapor vardı; Brier farkı ${p.injury.diff > 0 ? "+" : ""}${num(p.injury.diff, 4)}${p.injury.se != null ? ` ± ${num(p.injury.se, 4)}` : ""} (eksi = işe yarıyor).` : "")));
    if (p.recent && p.recent.length) {
      out.push(sec("NBA son maçlar", card(
        h("div", { class: "recent-row two head row", "aria-hidden": "true" }, h("span", {}, "MAÇ"), h("span", { class: "c" }, "SKOR"),
          h("span", { class: "c" }, "PİYASA"), h("span", { class: "c" }, "MODEL")),
        p.recent.map((r) => {
          const hw = Number(r.score.split("-")[0]) > Number(r.score.split("-")[1]);
          const cell = (q) => h("span", { class: q != null && (q > 0.5) === hw ? "c hit" : "c" }, pct(q), q != null && (q > 0.5) === hw ? " ✓" : "");
          return h("div", { class: "recent-row two row" }, h("span", { class: "m" }, h("span", {}, `${r.home} – ${r.away}`), h("small", {}, fmtDate(r.kickoff))),
            h("span", { class: "c sc" }, r.score), cell(r.k_home), cell(r.i_home));
        })),
      h("p", { class: "sec-note" }, "Olasılıklar ev sahibinin kazanması için. ✓ favori dediği takım kazandı.")));
    }
  }
  return out;
}
function minorPerf() {
  const b = DATA.minor_info && DATA.minor_info.backtest;
  if (!b) return [];
  return [sec("Diğer ligler · sadece model",
    h("div", { class: "tiles" },
      h("div", { class: "tile surface" }, h("span", { class: "cap" }, "Favori tuttu"), h("span", { class: "big" }, pct(b.accuracy)),
        h("span", { class: "cap" }, `${fmtInt(b.n)} maç`)),
      h("div", { class: "tile surface" }, h("span", { class: "cap" }, "Brier"), h("span", { class: "big" }, brier(b.brier)),
        h("span", { class: "cap" }, "kıyas 0,667"))),
    h("p", { class: "sec-note" }, "Oranı çekilmeyen 8 ligde kendi modelin geçmiş testi: her hafta sadece o haftadan önceki maçlarla kuruldu."),
    b.leagues && b.leagues.length ? h("details", { class: "more" }, h("summary", {}, "Lig lig"),
      h("ul", { class: "list-plain card" }, b.leagues.map((l) => h("li", {}, h("span", {}, l.name),
        h("span", { class: "muted" }, `${fmtInt(l.n)} maç · favori ${pct(l.accuracy)}`))))) : null)];
}
function blendNote() {
  const b = DATA.blend;
  const head = "Harman: piyasa ve modelin geçmiş maçlarla öğrenilmiş birleşimi. ";
  if (!b) return head;
  return head + (b.use_on_site ? "Testte piyasadan isabetli çıktığı için gösterilen olasılık harmandır. "
    : "Testte piyasayı belirgin geçemediği için gösterilen olasılık piyasadır. ");
}

/* Yönlendirme. Yeni adresler: #/ Bugün, #/mac/<id>, #/degerli, #/kupon (Kuponum), #/kupon/oneri (Önerilenler),
   #/gecmis, #/gecmis/<id>, #/performans. Eski adresler yenilerine yönlenir (#/maclar → #/; eski "Kuponlar" zaten #/'ti →
   Bugün); tanınmayan her adres Bugün'e gider, kırık bağlantı kalmaz. */
const REDIRECTS = { "#/maclar": "#/", "#/kuponlar": "#/kupon/oneri", "#/oneri": "#/kupon/oneri", "#/kuponum": "#/kupon" };
function resolveRoute(hash) {
  const raw = hash || "#/";
  const path = raw.split("?")[0];
  if (REDIRECTS[path]) return { redirect: REDIRECTS[path] };
  const dec = (x) => { try { return decodeURIComponent(x); } catch { return ""; } }; // bozuk adres → bulunamadı
  if (path === "#/" || path === "#" || path === "") return { view: "today", tab: "bugun" };
  if (path.startsWith("#/mac/")) return { view: "match", tab: "bugun", id: dec(path.slice(6)) };
  if (path === "#/degerli") return { view: "value", tab: "degerli" };
  if (path === "#/degerli/tum") return { view: "options", tab: "degerli" };
  if (path === "#/kupon") return { view: "kupon", tab: "kupon" };
  if (path === "#/kupon/oneri") return { view: "suggest", tab: "kupon" };
  if (path === "#/gecmis") return { view: "history", tab: "gecmis" };
  if (path.startsWith("#/gecmis/")) return { view: "historyDetail", tab: "gecmis", id: dec(path.slice(9)) };
  if (path === "#/performans") return { view: "performance", tab: "performans" };
  if (path.startsWith("#/lig/")) return { view: "league", tab: "bugun", id: dec(path.slice(6)) };
  if (path.startsWith("#/maclar/")) return { redirect: "#/" };
  return { redirect: "#/" };
}
const scrollMemo = {}; // liste ekranından detaya gidip geri dönünce kaldığı yer
let lastRoute = null;
function route() {
  const root = document.getElementById("view");
  let r = resolveRoute(location.hash);
  if (r.redirect) {
    history.replaceState(null, "", r.redirect);
    r = resolveRoute(r.redirect);
  }
  // Maç detayına hangi listeden gelindi: geri bağlantısı ve menüde seçili sekme ona göre
  if (r.view === "match") {
    r.from = lastRoute && (lastRoute.view === "value" || lastRoute.view === "options") ? lastRoute.view
      : lastRoute && lastRoute.view === "match" ? lastRoute.from : "today";
    if (r.from === "value" || r.from === "options") r.tab = "degerli";
  }
  const LISTS = ["today", "value", "options"];
  if (lastRoute && LISTS.includes(lastRoute.view) && !WIDE.matches) scrollMemo[lastRoute.view] = window.scrollY;
  const back = lastRoute && lastRoute.view === "match" && LISTS.includes(r.view);
  lastRoute = r;
  document.querySelectorAll(".tabbar a").forEach((a) => {
    if (a.dataset.tab === r.tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (!DATA) return;
  if (r.view === "match") {
    const ref = byId.get(r.id);
    if (ref) { // geri dönünce Bugün o maçın sporunu ve gününü göstersin
      state.sport = ref.sport;
      const i = days().findIndex((d) => d.matches.some((mm) => mm.id === r.id));
      if (i >= 0) state.day = i;
    }
  }
  // Masaüstü (≥ 1024 px): liste ortada, seçili maç sağda; diğer sekmeler orta + sağ alanda (desktop.js)
  const day = r.view === "today" || r.view === "match" ? days()[state.day] : null;
  const lay = Desktop.layoutFor(r, WIDE.matches, day && day.matches.length ? day.matches[0].id : null);
  setLayout(lay.layout);
  if (lay.layout === "split") { r.tab = lay.tab; if (r.view === "match") r.from = "today"; } // sonraki tıklamalar Değerli'yi miras almasın
  if (lay.layout !== "mobile") Desktop.renderSide(document.getElementById("side"), r.tab);
  if (lay.layout === "split") {
    if (lay.replaceHash) {
      history.replaceState(null, "", lay.replaceHash);
      r = lastRoute = { view: "match", tab: "bugun", id: lay.detailId, from: "today" };
    }
    routeSplit(root, lay.detailId, r.tab);
    return;
  }
  if (r.view === "match") viewMatch(root, r.id, r.from);
  else if (r.view === "today") viewToday(root);
  else if (r.view === "league") viewLeague(root, r.id);
  else if (r.view === "kupon") viewKupon(root);
  else if (r.view === "suggest") viewSuggest(root);
  else if (r.view === "performance") viewPerformance(root);
  else if (r.view === "value") viewValue(root);
  else if (r.view === "options") viewOptions(root);
  else if (r.view === "historyDetail") viewHistoryDetail(root, r.id);
  else if (r.view === "history") viewHistory(root);
  const nb = noticesBar();
  if (nb) { const hd = root.querySelector(":scope > header, :scope > .topnav"); if (hd) hd.after(nb); else root.prepend(nb); }
  if (WIDE.matches) root.scrollTop = 0;
  else window.scrollTo(0, back ? scrollMemo[r.view] || 0 : 0);
}
/* ---------- masaüstü düzeni (≥ 1024 px; mobilde hiçbiri çalışmaz) ---------- */
const WIDE = window.matchMedia("(min-width: 1024px)");
let listKey = null; // ortadaki listenin çizildiği spor|gün; aynıysa liste yeniden çizilmez (kaydırma yeri korunur)
function setLayout(layout) {
  if (document.body.dataset.layout === layout) return;
  document.body.dataset.layout = layout;
  document.getElementById("detail").dataset.id = ""; // başka sekmede kupon/iddaa değişmiş olabilir: detay yeniden çizilsin
  document.getElementById("detail").hidden = layout !== "split";
  document.getElementById("side").hidden = layout === "mobile";
  listKey = null;
}
function routeSplit(root, id, tab) {
  const key = `${state.sport}|${state.day}`;
  if (listKey !== key) {
    viewToday(root);
    const nb = noticesBar();
    if (nb) { const hd = root.querySelector(":scope > header"); if (hd) hd.after(nb); }
    root.scrollTop = 0;
    listKey = key;
  }
  const href = id == null ? null : `#/mac/${encodeURIComponent(id)}`;
  let sel = null;
  root.querySelectorAll("a.mrow").forEach((a) => {
    const on = a.getAttribute("href") === href;
    if (on) { a.setAttribute("aria-current", "true"); sel = a; } else a.removeAttribute("aria-current");
  });
  if (sel) sel.scrollIntoView({ block: "nearest" });
  const detail = document.getElementById("detail");
  if (detail.dataset.id !== String(id)) {
    if (id == null) detail.replaceChildren(h("p", { class: "empty" }, "Bu gün için maç yok."));
    else viewMatch(detail, id, "today", { wide: true });
    detail.dataset.id = String(id);
    detail.scrollTop = 0;
  }
}
/* Masaüstünde spor/gün çipi: liste yenilenir, ilk maç seçilir (adres yer değiştirir, geçmiş şişmez). */
function reselectFirst() {
  listKey = null;
  history.replaceState(null, "", "#/");
  route();
}
/* Kullanıcıya duyurular (ör. harman canlıda piyasadan kötü çıkınca piyasaya dönüldü); son 30 gün. */
function noticesBar() {
  const recent = (DATA.notices || []).filter((n) => Date.now() - new Date(n.at).getTime() < 30 * 86400 * 1000);
  if (!recent.length) return null;
  return h("div", { class: "sec notices", role: "status" }, recent.map((n) =>
    h("p", { class: "alert warn" }, h("b", {}, "Duyuru: "), n.text, h("small", {}, ` (${fmtDate(n.at)})`))));
}
async function init() {
  applyTheme(loadTheme());
  saveKupon();
  try {
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    DATA = await res.json();
    showNetBanner(res.headers.get("X-Macanaliz-Cache")); // service worker önbellekten verdiyse: "offline" | "slow"
  } catch {
    document.getElementById("view").replaceChildren(h("p", { class: "empty" }, "Veri yüklenemedi; sayfayı yenileyin."));
    return;
  }
  for (const sport of ["football", "basketball", "minor"]) {
    for (const d of DATA[sport] || []) for (const m of d.matches) byId.set(m.id, { match: m, sport });
  }
  state.day = firstDay();
  migrateKuponOdds(); // §29
  applyResults(); // §27 biten maçların skorları oynanan kuponlara
  updateHeader();
  window.addEventListener("hashchange", route);
  WIDE.addEventListener("change", route); // 1023 ↔ 1024 px: sayfa yenilenmeden düzen değişir
  route();
  refreshIddaaFeed(); // §34 beklemeden; en fazla 2 saatte bir
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshIddaaFeed(); });
}

/* ---------- PWA: bağlantı bandı ve service worker güncellemesi ---------- */
function showNetBanner(mode) {
  const banner = document.getElementById("net-banner");
  if (mode !== "offline" && mode !== "slow") { banner.hidden = true; document.body.classList.remove("net-on"); return; }
  document.body.classList.add("net-on");
  const when = DATA && DATA.generated_at ? fmtDateTime(DATA.generated_at) : "bilinmiyor";
  document.getElementById("net-text").textContent =
    `${mode === "slow" ? "Bağlantı yavaş" : "Çevrimdışı"} – son veri: ${when}`;
  banner.hidden = false;
}

/* Geçmiş > Ayarlar "Uygulamayı güncelle": bant görünmese de (ör. kapatıldı, çentiğe takıldı) bekleyen sürümü etkinleştirir.
   Sonuç: activating (controllerchange sayfayı yeniler) | current | offline | unsupported. */
let swReg = null;
async function updateApp() {
  if (!("serviceWorker" in navigator) || !swReg) return "unsupported";
  try { await swReg.update(); } catch { return "offline"; }
  const activate = (w) => { w.postMessage("SKIP_WAITING"); return "activating"; };
  if (swReg.waiting) return activate(swReg.waiting);
  const w = swReg.installing;
  if (!w) return "current";
  return new Promise((resolve) => {
    w.addEventListener("statechange", () => {
      if (w.state === "installed") resolve(swReg.waiting ? activate(swReg.waiting) : "current");
      else if (w.state === "redundant") resolve("current");
    });
  });
}
const UPDATE_TEXT = { activating: "Yükleniyor…", current: "Güncel", offline: "Bağlantı yok", unsupported: "Bu tarayıcıda desteklenmiyor" };
function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  document.getElementById("net-reload").addEventListener("click", () => location.reload());
  const hadController = !!navigator.serviceWorker.controller; // ilk kurulumda sayfa yenilenmesin
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  const banner = document.getElementById("sw-banner");
  const offer = (worker) => {
    banner.hidden = false;
    document.getElementById("sw-reload").onclick = () => {
      banner.querySelector("button").disabled = true;
      worker.postMessage("SKIP_WAITING");
    };
  };
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
    swReg = reg;
    // Önceki oturumda bildirilip uygulanmamış sürüm: açılışta hemen geçilir, eski sürüm takılı kalmaz
    if (reg.waiting && hadController) { reg.waiting.postMessage("SKIP_WAITING"); return; }
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) offer(w);
      });
    });
    const check = () => reg.update().catch(() => { /* çevrimdışı */ });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
    setInterval(check, 30 * 60 * 1000);
  }).catch(() => { /* service worker desteklenmiyor / engelli: site normal çalışır */ });
}

setupServiceWorker();
init();
