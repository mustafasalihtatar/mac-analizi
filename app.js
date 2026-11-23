/* Maç Analiz — arkadaş sitesi. Veri: data.json (yerel uygulamadan yayınlanır).
   Tüm metinler textContent ile yazılır; kupon ve kupon geçmişi (tutarlar dahil) sadece bu cihazın tarayıcısında
   saklanır, hiçbir yere gönderilmez. Geçmiş hesapları history.js'te (History), elle girilen iddaa oranları ve
   beklenen değer iddaa.js'te (Iddaa, §29). */
"use strict";

const TZ = "Europe/Istanbul";
const STORE = "macanaliz.kupon.v1";
const HSTORE = "macanaliz.gecmis.v1"; // §27 oynanan kuponlar + aylık bütçe
const ISTORE = "macanaliz.iddaa.v1"; // §29 elle girilen iddaa oranları (maç detayı, Kuponum, Oynadım ortak)
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
  plus: ["M12 5v14M5 12h14"], check: ["M5 12.5l4.5 4.5L19 7.5"], trend: ["M3 17l5-5 4 3 8-9"],
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
}
const inKupon = (key) => state.kupon.some((l) => l.key === key);
function legFrom(m, o, src) {
  const fair = o.price == null; // oranı çekilmeyen lig: adil oranla girer, kullanıcı iddaa oranını yazar
  return { key: o.key, matchId: m.id, pick: o.pick, match: matchLabel(m), competition: m.competition,
    kickoff: m.kickoff, price: fair ? o.fair : o.price, prob: o.prob, fair, src, model: isMinor(m) }; // src: safe|risky|slip|own
}
function toggleOption(m, o) {
  if (inKupon(o.key)) {
    state.kupon = state.kupon.filter((l) => l.key !== o.key);
    toast("Kupondan çıkarıldı");
  } else {
    state.kupon.push(legFrom(m, o, "own"));
    toast(started(m) ? "Kupona eklendi — uyarı: maç başladı"
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
  return true;
}
const iddaaOf = (matchId, key) => Iddaa.get(state.iddaa, matchId, key);
const legPrice = (l) => iddaaOf(l.matchId, l.key) ?? Number(l.price);
const legVerified = (l) => iddaaOf(l.matchId, l.key) != null;
const legModel = (l) => !!l.model || String(l.matchId).startsWith("lfa-"); // diğer ligler: olasılık model tahmini
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
  const render = () => viewToday(root);
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
      kids.push(h("section", { class: "league", "aria-label": g.comp },
        h("div", { class: "cols", "aria-hidden": "true", style: two ? "grid-template-columns:minmax(0,1fr) 40px 40px" : null },
          h("span", { class: "lg-name", lang: "en" }, g.comp), /* veri adları İngilizce: SPAIN, SPAİN değil */ (two ? ["1", "2"] : ["1", "X", "2"]).map((c) => h("span", {}, c))),
        card(g.list.map(matchRow))));
    }
  }
  kids.push(h("p", { class: "foot" }, state.sport === "minor" ? "Sayılar yüzde, sadece kendi modelden."
    : `Sayılar yüzde${state.sport === "basketball" ? " (uzatmalar dahil)" : ""}. Rozet: model piyasadan en az ${Math.round(EDGE * 100)} puan ayrılıyor.`),
    note(state.sport === "minor"), quotaLine());
  root.replaceChildren(...kids.filter(Boolean));
}
function matchRow(m) {
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
function viewMatch(root, id, from) {
  const back = from === "value" ? backLink("#/degerli", "Değerli") : backLink("#/", "Bugün");
  const ref = byId.get(id);
  const top = h("div", { class: "topnav" }, back, ref ? shareBtn(ref.match) : null);
  if (!ref) { root.replaceChildren(top, h("p", { class: "empty" }, "Maç bulunamadı; veriler güncellenmiş olabilir.")); return; }
  const m = ref.match, nba = m.sport === "basketball";
  if (!state.mtab || state.mtab.id !== id) state.mtab = { id, tab: "result" };
  const render = () => { const y = window.scrollY; viewMatch(root, id, from); window.scrollTo(0, y); };
  const rank = (side) => {
    const t = m.info && m.info.table, src = m.info && m.info[`${side}_src`];
    const r = t && src && t.find((x) => x["Takım"] === src);
    return r ? `${r["Sıra"]}. sıra` : null;
  };
  const e = m.expected;
  const mid = nba
    ? h("div", { class: "mid" }, h("small", {}, "Ev sahibi farkı"), h("span", { class: "xg sm" }, e.margin == null ? "–" : signedC(e.margin)),
        e.total != null ? h("small", {}, `toplam ${fmtDec(e.total)}`) : null)
    : h("div", { class: "mid" }, h("small", {}, "Beklenen gol"),
        h("span", { class: "xg", "aria-label": `${m.home} ${fmtDec(e.home)}, ${m.away} ${fmtDec(e.away)}` }, `${fmtDec(e.home)}–${fmtDec(e.away)}`));
  const side = (s) => h("div", { class: "side" }, crest(m, s, "lg"), h("b", {}, m[s]), rank(s) ? h("small", {}, rank(s)) : null);
  const tabs = MTABS[nba ? "basketball" : "football"];
  const tab = tabs.some(([k]) => k === state.mtab.tab) ? state.mtab.tab : "result";
  const head = h("header", { class: "mhead" },
    h("p", { class: "meta" }, `${m.competition} · ${fmtWhen(m.kickoff)}`, started(m) ? " · başladı" : ""),
    h("h1", { class: "sr" }, matchLabel(m)),
    h("div", { class: "versus" }, side("home"), mid, side("away")),
    segmented("Bölüm", tabs, tab, (v) => { state.mtab.tab = v; render(); }));
  const body = tab === "goals" ? goalsTab(m, render) : tab === "points" ? pointsTab(m, render)
    : tab === "teams" ? teamsTab(m) : resultTab(m, render);
  root.replaceChildren(top, head, ...body.filter(Boolean), note(isMinor(m)));
}

/* Seçenek satırı: seçim, adil / yurtdışı oran, beklenen değer yazısı, kupona ekle, iddaa oranı kutusu.
   big: MS için büyük "1 / X / 2" etiketi. onLive: yazarken (kar payı satırı için). */
const cap1 = (s) => s.charAt(0).toLocaleUpperCase("tr-TR") + s.slice(1);
function evText(ev, model) {
  const lab = Iddaa.evLabel(ev, model);
  if (!lab) return null;
  return { band: lab.band, text: model ? `${cap1(Iddaa.MODEL_LABEL)} · ${Iddaa.formatPct(ev)}` : `${cap1(Iddaa.BAND_NAMES[lab.band])} · ${Iddaa.formatPct(ev)}` };
}
/* iddaa oranı kutusu + beklenen değer yazısı (maç detayı ve Değerli ortak). minor: doğrulanmamış model → renk yok. */
function iddaaField(m, o, minor, onLive) {
  const saved = iddaaOf(m.id, o.key);
  const evEl = h("span", { class: "opt-ev", "aria-live": "polite" });
  let input = null;
  const show = (text) => { // → oran | null (boş) | undefined (geçersiz)
    const t = String(text).trim();
    input.removeAttribute("aria-invalid");
    input.classList.remove("good");
    evEl.className = "opt-ev";
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
    return v;
  };
  input = h("input", { type: "text", inputmode: "decimal", autocomplete: "off", enterkeyhint: "done", class: "inp", placeholder: "iddaa",
    value: saved == null ? "" : odds(saved),
    oninput: (ev) => { show(ev.target.value); if (onLive) onLive(); },
    onchange: (ev) => {
      const v = show(ev.target.value);
      if (v === undefined) { toast("Oran 1'den büyük bir sayı olmalı (1,85 ya da 1.85)"); return; }
      setIddaa(m.id, m.kickoff, o.key, v);
      if (v != null) ev.target.value = odds(v);
      if (onLive) onLive();
    } });
  show(input.value);
  return { input, evEl };
}
function optRow(m, o, render, opts) {
  const { big, onLive } = opts || {};
  const minor = isMinor(m);
  const { input, evEl } = iddaaField(m, o, minor, onLive);
  const d = diffOf(o);
  const flag = !minor && !big && d != null && Math.abs(d) >= EDGE;
  const blendDiff = !minor && o.market === "h2h" && blendOn(m) && o.market_prob != null && Math.abs(o.prob - o.market_prob) > 0.0005;
  // MS'de olasılık yukarıdaki büyük rakamlarda; diğer pazarlarda satırda yazılır
  const sub = minor ? `Model ${pct(o.prob)} · Adil ${odds(o.fair)}`
    : `${big ? "" : `${blendDiff ? `Harman ${pct(o.prob)}` : pct(o.prob)}${o.model_prob != null ? ` (model ${pct(o.model_prob)})` : ""} · `}Adil ${odds(o.fair)} · Yurtdışı ${o.price ? odds(o.price) : "–"}`;
  const can = o.addable || minor;
  const inK = inKupon(o.key);
  // Kupona eklenemeyen seçenek (çifte şans, çeyrek çizgi): düğme yok, iddaa oranı ve beklenen değer yine çalışır
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
  const h2h = m.options.filter((o) => o.market === "h2h");
  if (h2h.length) {
    let margin = null;
    const rows = h2h.map((o) => optRow(m, o, render, { big: SHORT[o.outcome], onLive: () => margin && margin.update() }));
    margin = marginLine(m, rows);
    out.push(sec("İddaa oranların", card(rows.map((r) => r.el), margin.el),
      h("p", { class: "sec-note" }, "iddaa'da gördüğün oranı kutuya yaz: beklenen değer = olasılık × oran − 1. ",
        minor ? "Bu ligde model doğrulanmamış; renk verilmez." : `+%${bandPct()} üstü değerli, −%${bandPct()} altı düşük, arası adil.`,
        " Oran bu cihazda kalır, Kuponum'a da geçer.")));
  }
  const dc = m.options.filter((o) => o.market === "double_chance");
  if (dc.length) out.push(sec("Çifte şans", optionsCard(m, dc, render).el));
  out.push(explain(m));
  return out;
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
  const sp = m.options.filter((o) => o.market === "spreads");
  out.push(lineGroup(m, "Handikap", sp, render, (o) => Math.abs(o.line), fmtLine, Math.abs(e.margin || 0)));
  const tot = m.options.filter((o) => o.market === "totals");
  out.push(lineGroup(m, "Alt / üst", tot, render, (o) => o.line, fmtLine, e.total || 0));
  out.push(h("p", { class: "foot" }, "Handikap ve alt/üst olasılıkları piyasadan; uzatmalar dahil."));
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
  const head = (seg) => h("header", { class: "hd" }, h("h1", { class: "title" }, "Değerli"),
    h("p", { class: "lede" }, `Modelin piyasadan en az ${thr} puan ayrıldığı seçenekler. Kazanç garantisi değildir.`), seg);
  if (!v) { root.replaceChildren(head(null), h("p", { class: "empty" }, "Bu yayında liste yok."), note()); return; }
  const { rows, minor } = Value.build(v.picks, state.iddaa, (id) => (byId.get(id) || {}).match, new Date());
  const fb = rows.filter((r) => r.sport !== "basketball"), nb = rows.filter((r) => r.sport === "basketball");
  if (!state.vsport) state.vsport = !fb.length && !minor.length && nb.length ? "basketball" : "football";
  const cur = state.vsport;
  const kids = [head(segmented("Spor", [["football", `Futbol · ${fb.length}`], ["basketball", `NBA · ${nb.length}`]], cur,
    (x) => { state.vsport = x; render(); }))];
  const list = cur === "basketball" ? nb : fb;
  kids.push(sec("Seçenekler", list.length ? card(list.map(valueRow))
    : padCard(h("p", { class: "muted" }, "Şu an eşiği geçen seçenek yok.")),
  h("p", { class: "sec-note" }, "Beklenen değeri pozitif olanlar (iddaa oranı girdiklerin) en üstte, sonra farka göre. ",
    "Adil oran = 1 ÷ model olasılığı; beklenen değer sitede gösterilen olasılıkla. iddaa oranı girdiğin ama eşik altında kalan ",
    "seçenekler \"eşik altı\" etiketiyle görünür.")));
  if (cur === "football" && minor.length) {
    kids.push(sec("Diğer ligler · doğrulanmamış model", card(minor.map(valueRow)),
      h("p", { class: "sec-note" }, "Bu liglerde piyasa olasılığı yok; sadece iddaa oranı girdiğin seçenekler, model olasılığıyla. Takibe girmez.")));
  }
  kids.push(valueTracking(v), h("p", { class: "foot" }, VALUE_NOTE), note());
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
  const counts = {};
  legs.forEach((l) => { counts[l.matchId] = (counts[l.matchId] || 0) + 1; });
  const dup = [...new Set(legs.filter((l) => counts[l.matchId] > 1).map((l) => l.match))];
  const late = [...new Set(legs.filter((l) => new Date(l.kickoff) <= new Date()).map((l) => l.match))];

  kids.push(sec("Seçimler", card(legs.map((l) => {
    const lab = legVerified(l) ? evText(Iddaa.expectedValue(l.prob, legPrice(l)), legModel(l)) : null;
    return h("div", { class: "kleg row" },
      h("div", { class: "info" }, h("span", { class: "pick" }, l.pick),
        h("span", { class: "meta" }, `${l.match} · ${fmtShortWhen(l.kickoff)}`),
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
  })), h("p", { class: "sec-note" }, "Oranlar iddaa'da gördüğün değerler; maç detayıyla ortak. Kutuyu boşaltırsan seçimin eklendiği orana döner.")));
  if (dup.length) kids.push(h("p", { class: "alert warn" }, h("b", {}, "Aynı maçtan birden fazla seçim: "), `${dup.join(", ")}. Bahis siteleri kabul etmeyebilir.`));
  if (late.length) kids.push(h("p", { class: "alert warn" }, h("b", {}, "Başlamış maç: "), late.join(", ")));

  const evLab = totalEV == null ? null : evText(totalEV, anyModel);
  const evCls = !evLab || anyModel ? "" : evLab.band === "value" ? "good-t" : evLab.band === "low" ? "bad-t" : "";
  let stakeText = String(state.stake).replace(".", ",");
  const payout = h("b", {}, `${fmtMoney(Math.round(state.stake * total * 100) / 100)} TL`);
  kids.push(h("div", { class: "card pad" },
    h("div", { class: "sum3" },
      h("div", {}, h("small", {}, "Toplam oran"), h("span", { class: "num" }, odds(total))),
      h("div", {}, h("small", {}, "Tutma ihtimali"), h("span", { class: "num" }, totalProb == null ? "–" : `%${fmtDec(totalProb * 100)}`)),
      h("div", {}, h("small", {}, "Beklenen değer"), h("span", { class: `num ${evCls}` }, totalEV == null ? "–" : Iddaa.formatPct(totalEV)),
        evLab ? h("small", { class: evCls || null }, anyModel ? Iddaa.MODEL_LABEL : Iddaa.BAND_NAMES[evLab.band]) : null)),
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
    state.playing ? playForm(legs, render) : null,
    h("div", { class: "btn-row" },
      h("a", { class: "btn sm", href: shareLink(legs, total, totalProb), target: "_blank", rel: "noopener" }, "WhatsApp'ta paylaş"),
      h("button", { type: "button", class: "btn sm danger", onclick: () => { state.kupon = []; state.playing = false; saveKupon(); render(); } }, "Kuponu temizle"))));
  kids.push(budgetSection(state.stake));
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
  for (const [kind, title, desc] of KINDS) kids.push(couponCard(day, kind, title, desc));
  kids.push(note(), quotaLine());
  root.replaceChildren(...kids.filter(Boolean));
}
function couponCard(day, kind, title, desc) {
  const c = day && day.coupons[kind];
  const headEl = (n) => h("div", { class: "chead" }, h("h3", {}, title), n != null ? badge(`${n} maç`, "plain muted") : null);
  if (!c) return h("section", { class: "card pad coupon-card", "aria-label": title }, headEl(null), h("p", { class: "opt-sub" }, desc),
    h("p", { class: "muted" }, "Bu güne bu kurala uygun maç yok."));
  const legs = c.legs.map((leg) => {
    const ref = byId.get(leg.match);
    const o = ref && ref.match.options.find((x) => x.key === leg.key);
    if (!o) return null;
    return h("div", { class: "cl" },
      h("div", { class: "info" }, h("span", { class: "pick" }, o.pick),
        h("span", { class: "meta" }, `${fmtTime(ref.match.kickoff)} · ${matchLabel(ref.match)}`),
        started(ref.match) ? h("span", { class: "meta warn-t", style: "font-weight:600" }, "Başladı") : null),
      h("div", { class: "r" }, h("b", {}, odds(o.price)), h("small", {}, pct(o.prob))));
  }).filter(Boolean);
  return h("section", { class: "card pad coupon-card", "aria-label": title },
    headEl(legs.length), h("p", { class: "opt-sub" }, desc),
    h("div", { class: "legs" }, legs),
    h("div", { class: "sum3", style: "grid-template-columns:repeat(2,minmax(0,1fr))" },
      h("div", {}, h("small", {}, "Toplam oran"), h("span", { class: "num" }, odds(c.total_odds))),
      h("div", {}, h("small", {}, "Tutma ihtimali"), h("span", { class: "num" }, pct(c.total_prob)))),
    h("button", { type: "button", class: "btn secondary block", onclick: () => addCoupon(c, kind) }, "Kupona al"));
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
      h("button", { type: "button", class: "link-btn row", onclick: () => file.click() }, "Yedekten yükle")), file,
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
    kids.push(summaryCard(History.summarize(shown), History.calibration(shown)));
    kids.push(sec("Kupon tipine göre", typeRows(shown)));
    const unv = shown.filter((c) => c.unverified).length;
    kids.push(sec("Kuponlar", card(shown.map(couponRow)),
      unv ? h("p", { class: "sec-note" }, `${unv} kupon iddaa oranı girilmeden kaydedildi ("Oran doğrulanmadı"); kazançları gerçek iddaa oranıyla farklı olabilir.`) : null));
  }
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
  if (live.length) kids.push(sec("Canlı ölçüm", card(live)));

  if (p && p.n) kids.push(...liveFootball(p));
  kids.push(...backtestFootball());
  kids.push(calibrationSection(render));
  if (nb) kids.push(...nbaPerf(nb));
  kids.push(...minorPerf());
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
    const OUT = ["home", "draw", "away"];
    out.push(sec("Son maçlar", card(
      h("div", { class: "recent-row head row", "aria-hidden": "true" }, h("span", {}, "MAÇ"), h("span", { class: "c" }, "SKOR"),
        ["1", "X", "2"].map((x) => h("span", { class: "c" }, x))),
      p.recent.map((r) => {
        const won = outcomeOf(r.score);
        const fav = OUT.reduce((a, k) => (r[`p_${k}`] > r[`p_${a}`] ? k : a), "home");
        return h("div", { class: "recent-row row" },
          h("span", { class: "m" }, h("span", {}, `${r.home} – ${r.away}`), h("small", {}, fmtDate(r.kickoff))),
          h("span", { class: "c sc" }, r.score),
          OUT.map((k) => h("span", { class: k === won ? (k === fav ? "c hit" : "c act") : "c" },
            pct(r[`p_${k}`]), k === won ? (k === fav ? " ✓" : " •") : "")));
      })),
    h("p", { class: "sec-note" }, "✓ favori dediğimiz sonuç oldu. • gerçekleşen sonuç (favori değildi).")));
  }
  return out;
}
function outcomeOf(score) {
  const [a, b] = score.split("-").map(Number);
  return a > b ? "home" : a < b ? "away" : "draw";
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
  if (path === "#/kupon") return { view: "kupon", tab: "kupon" };
  if (path === "#/kupon/oneri") return { view: "suggest", tab: "kupon" };
  if (path === "#/gecmis") return { view: "history", tab: "gecmis" };
  if (path.startsWith("#/gecmis/")) return { view: "historyDetail", tab: "gecmis", id: dec(path.slice(9)) };
  if (path === "#/performans") return { view: "performance", tab: "performans" };
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
    r.from = lastRoute && lastRoute.view === "value" ? "value" : lastRoute && lastRoute.view === "match" ? lastRoute.from : "today";
    if (r.from === "value") r.tab = "degerli";
  }
  if (lastRoute && (lastRoute.view === "today" || lastRoute.view === "value")) scrollMemo[lastRoute.view] = window.scrollY;
  const back = lastRoute && lastRoute.view === "match" && (r.view === "today" || r.view === "value");
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
    viewMatch(root, r.id, r.from);
  }
  else if (r.view === "today") viewToday(root);
  else if (r.view === "kupon") viewKupon(root);
  else if (r.view === "suggest") viewSuggest(root);
  else if (r.view === "performance") viewPerformance(root);
  else if (r.view === "value") viewValue(root);
  else if (r.view === "historyDetail") viewHistoryDetail(root, r.id);
  else if (r.view === "history") viewHistory(root);
  const nb = noticesBar();
  if (nb) { const hd = root.querySelector(":scope > header, :scope > .topnav"); if (hd) hd.after(nb); else root.prepend(nb); }
  window.scrollTo(0, back ? scrollMemo[r.view] || 0 : 0);
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
  route();
}

/* ---------- PWA: bağlantı bandı ve service worker güncellemesi ---------- */
function showNetBanner(mode) {
  const banner = document.getElementById("net-banner");
  if (mode !== "offline" && mode !== "slow") { banner.hidden = true; return; }
  const when = DATA && DATA.generated_at ? fmtDateTime(DATA.generated_at) : "bilinmiyor";
  document.getElementById("net-text").textContent =
    `${mode === "slow" ? "Bağlantı yavaş" : "Çevrimdışı"} – son veri: ${when}`;
  banner.hidden = false;
}

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
