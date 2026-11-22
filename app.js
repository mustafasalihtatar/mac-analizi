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
const pct = (p) => (p == null ? "–" : p >= 0.01 ? `%${Math.round(p * 100)}` : `%${(p * 100).toFixed(1)}`);
const odds = (x) => (x == null ? "–" : Number(x).toFixed(2));
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

/* Model ile piyasa farkı (olasılık puanı). EDGE puan ve üstü işaretlenir. Listede sadece 1X2: model gol sayısını
   piyasadan sistematik düşük görüyor (2026-11 ölçümü), alt/üst farkları çoğunlukla bu eğilim. */
const EDGE = 0.08;
const diffOf = (o) => (o.model_prob == null || o.market_prob == null ? null : o.model_prob - o.market_prob);
const pts = (d) => `${d > 0 ? "+" : "−"}${Math.round(Math.abs(d) * 100)}`;
function bestEdge(m) { // modelin piyasadan en çok yüksek gördüğü, kupona eklenebilir seçenek
  let best = null;
  for (const o of m.options) {
    const d = diffOf(o);
    if (o.market === "h2h" && d != null && d >= EDGE && o.addable && (!best || d > diffOf(best))) best = o;
  }
  return best;
}

/* Takım arması (futbol, diğer ligler, NBA): yoksa ya da yüklenemezse baş harfler. */
const NOISE = /^(fc|sk|cf|ac|as|sc|afc|ssc|fk|sv|tsg|vfb|vfl|rc|bv|\d+)$/i;
function initials(name) {
  const w = String(name).split(/[\s.\-/]+/).filter((x) => x && !NOISE.test(x));
  const s = w.length > 1 ? w[0][0] + w[1][0] : (w[0] || "?").slice(0, 2);
  return s.toUpperCase(); // "Milan" → "MI" (tr-TR kuralı "Mİ" yapardı)
}
function crest(m, side, size) {
  if (m.sport !== "football" && m.sport !== "basketball" && !isMinor(m)) return null;
  const cls = `crest${size ? ` ${size}` : ""}`;
  const fallback = () => h("span", { class: `${cls} ini`, "aria-hidden": "true" }, initials(m[side]));
  const src = m.logos && m.logos[side];
  if (!src) return fallback();
  const img = h("img", { class: cls, src, alt: "", loading: "lazy", decoding: "async",
    onerror: () => img.replaceWith(fallback()) });
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
function pbar(vals, thin) {
  const outs = vals.length === 2 ? ["home", "away"] : OUT3;
  return h("div", { class: thin ? "pbar thin" : "pbar", "aria-hidden": "true" }, vals.map((p, i) =>
    h("span", { class: `seg-${outs[i]}`, style: `flex-grow:${Math.max(p, 0.001)}` }, !thin && p >= 0.12 ? pct(p) : null)));
}
/* Sitede gösterilen MS olasılığı harman mı (futbol §26-5, NBA §28 ayrı karar). */
const nbaBlend = () => (DATA.performance_nba && DATA.performance_nba.blend) || null;
const blendOn = (m) => (m.sport === "basketball" ? !!(nbaBlend() && nbaBlend().use_on_site) : !!(DATA.blend && DATA.blend.use_on_site));

const STALE_MS = 12 * 3600 * 1000;
const PROGRAM_STALE_MS = 36 * 3600 * 1000; // diğer liglerin maç programı günde bir yenilenir
function updateHeader() {
  const el = document.getElementById("updated");
  if (!DATA) return;
  if (state.sport === "minor") {
    const t = DATA.minor_info && DATA.minor_info.fixtures_updated;
    const stale = t && Date.now() - new Date(t).getTime() > PROGRAM_STALE_MS;
    el.textContent = t ? `Maç programı: ${fmtDateTime(t)}${stale ? " (eski olabilir)" : ""}` : "Maç programı: henüz yok";
    el.classList.toggle("stale", Boolean(stale));
    return;
  }
  const name = state.sport === "football" ? "Futbol" : "NBA";
  const t = DATA.odds_updated && DATA.odds_updated[state.sport];
  const stale = t && Date.now() - new Date(t).getTime() > STALE_MS;
  el.textContent = t ? `${name} oranları: ${fmtDateTime(t)}${stale ? " (eski olabilir)" : ""}` : `${name} oranları: henüz yok`;
  el.classList.toggle("stale", Boolean(stale));
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
/* Beklenen değer rozeti: renk + yazı (değerli / adil / düşük). model: olasılık doğrulanmamış model (diğer ligler) →
   renk yok (nötr), "doğrulanmamış model" yazar. */
function evBadge(ev, model, long) {
  const lab = Iddaa.evLabel(ev, model);
  if (!lab) return null;
  return h("span", { class: `ev ev-${lab.band}`, title: long ? null : "Beklenen değer = olasılık × iddaa oranı − 1" },
    `${long ? "Beklenen değer" : "BD"} ${lab.text}`);
}
/* Maç detayında seçeneğin altındaki iddaa oranı kutusu. onLive: yazarken (kar payı satırı için). */
function iddaaRow(m, o, model, onLive) {
  const saved = iddaaOf(m.id, o.key);
  const out = h("span", { class: "ev-out", "aria-live": "polite" });
  let input = null;
  const show = (text) => { // → oran | null (boş) | undefined (geçersiz)
    const t = String(text).trim();
    input.removeAttribute("aria-invalid");
    if (!t) { out.replaceChildren(); return null; }
    const v = Iddaa.parseOdds(t);
    if (v == null) {
      input.setAttribute("aria-invalid", "true");
      out.replaceChildren(h("span", { class: "ev ev-bad" }, "Geçersiz: 1'den büyük oran yaz"));
      return undefined;
    }
    out.replaceChildren(evBadge(Iddaa.expectedValue(o.prob, v), model) || "");
    return v;
  };
  input = h("input", { type: "text", inputmode: "decimal", autocomplete: "off", class: "iddaa-in", placeholder: "oran",
    value: saved == null ? "" : odds(saved), "aria-label": `${o.pick} iddaa oranı`,
    oninput: (ev) => { show(ev.target.value); if (onLive) onLive(); },
    onchange: (ev) => {
      const v = show(ev.target.value);
      if (v === undefined) { toast("Oran 1'den büyük bir sayı olmalı (1,85 ya da 1.85)"); return; }
      setIddaa(m.id, m.kickoff, o.key, v);
      if (v != null) ev.target.value = odds(v);
      if (onLive) onLive();
    } });
  show(input.value);
  return { el: h("label", { class: "iddaa-row" }, h("span", { class: "iddaa-lbl" }, "iddaa"), input, out), input, o };
}
const pctPlain = (x) => Iddaa.formatPct(x).replace(/^\+/, "");
/* MS kar payı: maçın tüm MS sonuçlarının iddaa oranı girilince (futbol 1-X-2, NBA 1-2). */
function marginLine(m, rows) {
  const el = h("p", { class: "small muted iddaa-margin", "aria-live": "polite" });
  const update = () => {
    const vals = rows.map((r) => Iddaa.parseOdds(r.input.value));
    const mg = Iddaa.margin(vals);
    if (mg == null || vals.length !== outsOf(m).length) {
      el.replaceChildren(m.sport === "basketball" ? "İki takımın iddaa oranını girince iddaa'nın bu maçtaki kar payı hesaplanır."
        : "MS1, MSX ve MS2'nin üçünü girince iddaa'nın bu maçtaki kar payı hesaplanır.");
      return;
    }
    el.replaceChildren("iddaa kar payı (MS): ", h("b", {}, pctPlain(mg)),
      m.sport === "basketball" ? " — 1/o1 + 1/o2 − 1" : " — 1/o1 + 1/oX + 1/o2 − 1", "; kar payı yüksekse oranlar düşüktür.");
  };
  update();
  return { el, update };
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
const STATUS = { won: ["Tuttu", "st-won"], lost: ["Yattı", "st-lost"], void: ["İade", "st-void"], pending: ["Bekliyor", "st-pend"] };
const RESULT_NAMES = { won: "Tuttu", lost: "Yattı", void: "İade" };
function budgetBanner(extra) {
  const b = History.budgetState(state.history, new Date(), extra);
  if (!b || b.level === "ok") return null;
  const used = `Bu ay ${tl(b.spent)} yatırdın, aylık bütçen ${tl(b.budget)} (%${Math.round(b.ratio * 100)}).`;
  return h("div", { class: b.level === "over" ? "budget-warn over" : "budget-warn", role: "alert" },
    h("b", {}, b.level === "over" ? "Aylık bütçeni aştın. " : "Aylık bütçenin %80'ine geldin. "), used,
    b.level === "over" ? ` ${tl(-b.left)} fazla.` : ` Kalan ${tl(b.left)}.`);
}

/* ---------- ortak parçalar ---------- */
function sportSwitch(onChange, withMinor) {
  const b = (sport, label) => h("button", { type: "button", "aria-pressed": state.sport === sport,
    onclick: () => { state.sport = sport; state.day = firstDay(); updateHeader(); onChange(); } }, label);
  return h("div", { class: "seg", role: "group", "aria-label": "Spor" }, b("football", "Futbol"), b("basketball", "NBA"),
    withMinor && DATA && DATA.minor ? b("minor", "Diğer ligler") : null);
}
/* Odds API aylık kota satırı (futbol/NBA sayfalarında). */
function quotaLine() {
  const q = DATA && DATA.odds_quota;
  if (!q || state.sport === "minor") return null;
  return h("p", { class: "quota small muted" }, `Bu ay kalan: ${q.remaining} kredi, günlük güvenli harcama: ${q.daily_safe}`,
    h("span", { class: "quota-reset" }, ` · ${fmtDateTime(q.resets_at)}'te yenilenir`));
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
  return h("p", { class: "odds-warn", role: "status" }, h("b", {}, "Oranlar güncellenemedi"),
    ` (${ODDS_REASON[st.reason] || "bilinmeyen hata"}). `,
    t ? `Gösterilen oranlar ${fmtDateTime(t)} tarihli; iddaa'daki güncel oranla karşılaştır.` : "Oran yok.");
}
function minorNote() {
  return h("p", { class: "small muted minor-note" }, "Bu liglerin bahis oranı çekilmiyor: olasılıklar sadece kendi ",
    "modelimizden (geçmiş maçlar, gol ve xG). Adil oran = 1 / olasılık; iddaa oranı bundan yüksekse model o seçeneği ",
    "daha olası görüyor. Geçmiş testte model kapanış oranlarının biraz gerisinde kaldı — fikir verir, garanti değildir.");
}
function dayChips(onChange) {
  return h("div", { class: "chips", role: "group", "aria-label": "Gün" },
    days().map((d, i) => h("button", { type: "button", class: "chip", "aria-pressed": state.day === i,
      onclick: () => { state.day = i; onChange(); } }, d.label, h("span", { class: "n" }, d.matches.length))));
}
function note(minor) {
  return h("p", { class: "note" }, minor
    ? "Bu liglerde olasılıklar sadece kendi modelden; hiçbir tahmin garanti değildir."
    : "Oranlar uluslararası bahis şirketlerinden; iddaa oranları farklı olabilir. Olasılıklar oranlardan hesaplanır, hiçbir kupon garanti değildir.",
    DATA ? ` Site yayını: ${fmtDateTime(DATA.generated_at)}.` : "");
}

/* ---------- görünüm: kuponlar ---------- */
function viewCoupons(root) {
  const render = () => viewCoupons(root);
  if (state.sport === "minor") { state.sport = "football"; state.day = firstDay(); updateHeader(); } // oran yok → kupon yok
  const day = days()[state.day];
  root.replaceChildren(
    h("h1", {}, "Günün kuponları"),
    sportSwitch(render), quotaLine() || "", oddsWarning() || "", dayChips(render),
    h("div", { class: "grid" }, KINDS.map(([kind, title, desc]) => couponCard(day, kind, title, desc))),
    note(),
  );
}
function couponCard(day, kind, title, desc) {
  const c = day && day.coupons[kind];
  if (!c) {
    return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", {}, title)),
      h("p", { class: "card-note" }, desc), h("p", { class: "empty" }, "Bu güne bu kurala uygun maç yok."));
  }
  const legs = c.legs.map((leg) => {
    const ref = byId.get(leg.match);
    const o = ref && ref.match.options.find((x) => x.key === leg.key);
    if (!o) return null;
    return h("li", { class: "leg" },
      h("div", { class: "leg-text" }, h("span", { class: "leg-pick" }, o.pick),
        h("span", { class: "leg-meta" }, `${fmtTime(ref.match.kickoff)}  `, crest(ref.match, "home", "sm"),
          ` ${matchLabel(ref.match)} `, crest(ref.match, "away", "sm")),
        started(ref.match) ? h("span", { class: "started" }, "Başladı") : null),
      h("div", { class: "leg-num" }, h("span", { class: "odds" }, odds(o.price)), h("span", { class: "prob" }, pct(o.prob))));
  });
  const shown = legs.filter(Boolean);
  return h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h3", {}, title), h("span", { class: "pill" }, `${shown.length} maç`)),
    h("p", { class: "card-note" }, desc),
    h("ol", { class: "legs" }, shown),
    h("div", { class: "total" },
      h("div", {}, h("span", { class: "small muted" }, "Toplam oran"), h("span", { class: "big" }, odds(c.total_odds))),
      h("div", { class: "r" }, h("span", { class: "small muted" }, "Tutma ihtimali"), h("span", { class: "mid" }, pct(c.total_prob)))),
    h("button", { type: "button", class: "btn block", onclick: () => addCoupon(c, kind) }, "Kupona ekle"));
}

/* ---------- görünüm: maçlar ---------- */
function headline(m) {
  const get = (o) => m.options.find((x) => x.market === "h2h" && x.outcome === o && (x.price || isMinor(m)));
  return ["home", "draw", "away"].map(get).filter(Boolean);
}
function viewMatches(root) {
  const render = () => viewMatches(root);
  const day = days()[state.day];
  const kids = [h("h1", {}, "Maçlar"), sportSwitch(render, true), quotaLine(), oddsWarning(), dayChips(render)]
    .filter(Boolean);
  if (state.sport === "minor") kids.push(minorNote());
  if (!day || !day.matches.length) {
    kids.push(h("p", { class: "empty" }, "Bu gün için maç yok."));
  } else {
    let comp = null;
    for (const m of day.matches) {
      if (m.competition !== comp) { comp = m.competition; kids.push(h("p", { class: "comp" }, comp)); }
      const short = { home: "1", draw: "X", away: "2" };
      const edge = bestEdge(m), bar = probs3(m, "prob");
      kids.push(h("a", { class: "match", href: `#/mac/${encodeURIComponent(m.id)}` },
        h("span", { class: "time" }, fmtTime(m.kickoff)),
        h("span", { class: "teams" },
          h("span", { class: "tm" }, crest(m, "home"), h("span", { class: "nm" }, m.home)),
          h("span", { class: "tm" }, crest(m, "away"), h("span", { class: "nm" }, m.away)),
          started(m) ? h("span", { class: "started" }, "Başladı") : null),
        h("span", { class: isMinor(m) ? "mini model-only" : "mini" }, headline(m).map((o) => isMinor(m)
          ? h("div", {}, h("b", {}, pct(o.prob)), h("small", {}, `${short[o.outcome]} ${odds(o.fair)}`))
          : h("div", {}, h("b", {}, odds(o.price)), h("small", {}, `${short[o.outcome]} ${pct(o.prob)}`)))),
        bar ? pbar(bar, true) : null,
        edge ? h("span", { class: "edge" }, h("span", { class: "edge-tag" }, `Model ${pts(diffOf(edge))}`),
          ` ${edge.pick}`) : null));
    }
  }
  kids.push(note(state.sport === "minor"));
  root.replaceChildren(...kids);
}

/* ---------- görünüm: maç detayı ---------- */
function viewMatch(root, id) {
  const ref = byId.get(id);
  if (!ref) { root.replaceChildren(h("a", { class: "back", href: "#/maclar" }, "‹ Maçlar"), h("p", { class: "empty" }, "Maç bulunamadı; veriler güncellenmiş olabilir.")); return; }
  const m = ref.match;
  const render = () => viewMatch(root, id);
  const kids = [
    h("a", { class: "back", href: "#/maclar" }, "‹ Maçlar"),
    h("div", { class: "vs" }, crest(m, "home", "lg"), h("span", { class: "vs-x" }, "–"), crest(m, "away", "lg")),
    h("h1", {}, matchLabel(m)),
    h("p", { class: "muted small" }, `${m.competition}  ${fmtDateTime(m.kickoff)}`, started(m) ? "  (başladı)" : ""),
  ];
  const warn = !isMinor(m) && oddsWarning();
  if (warn) kids.push(warn);
  const e = m.expected;
  kids.push(m.sport !== "basketball"
    ? h("div", { class: "expected" }, h("div", {}, h("span", { class: "small muted" }, `${m.home} beklenen gol`), h("b", {}, e.home.toFixed(2))),
        h("div", {}, h("span", { class: "small muted" }, `${m.away} beklenen gol`), h("b", {}, e.away.toFixed(2))))
    : nbaExpected(m));

  const minor = isMinor(m);
  const pm = minor ? null : probs3(m, "market_prob"), pmod = probs3(m, minor ? "prob" : "model_prob");
  const pbl = minor ? null : probs3(m, "blend_prob");
  if (pm || pmod) {
    const names = m.sport === "basketball" ? [m.home, m.away] : [m.home, "Beraberlik", m.away];
    const outs = outsOf(m);
    kids.push(h("div", { class: "pbars" },
      pm ? h("div", { class: "pbar-row" }, h("span", { class: "lbl" }, "Piyasa"), pbar(pm)) : null,
      pmod ? h("div", { class: "pbar-row" }, h("span", { class: "lbl" }, "Model"), pbar(pmod)) : null,
      pbl ? h("div", { class: "pbar-row" }, h("span", { class: "lbl" }, "Harman"), pbar(pbl)) : null,
      h("div", { class: "pbar-legend" }, names.map((n, i) =>
        h("span", {}, h("i", { class: `dot seg-${outs[i]}` }), n)))));
  }
  if (minor) kids.push(minorNote(), h("p", { class: "small muted" },
    "Seçeneğe dokununca kupona eklenir; iddaa oranını seçeneğin altına yazarsan kupona o oranla geçer, yoksa adil oranla."));
  else if (m.sport === "basketball") kids.push(h("p", { class: "small muted" }, "Seçeneğe dokununca kupona eklenir; tekrar dokununca çıkar. ",
    "Piyasa: oranlardan bahis şirketi payı ayıklanmış olasılık. Model: oranlara bakmadan son 3 sezonun NBA maçlarından ",
    "kurduğumuz model (hücum/savunma rating'i, pace, ev avantajı, dinlenme ve resmi sakatlık raporundaki eksikler). ",
    `Model piyasadan ${Math.round(EDGE * 100)}+ puan ayrılınca işaretlenir. `,
    "NBA'de geçmiş oran olmadığı için model ile piyasa canlıda karşılaştırılıyor; 300 maç dolunca harman denenecek (Performans). ",
    "Maç sonucu uzatmalar dahildir."));
  else kids.push(h("p", { class: "small muted" }, "Seçeneğe dokununca kupona eklenir; tekrar dokununca çıkar. ",
    "Piyasa: oranlardan bahis şirketi payı ayıklanmış olasılık. Model: oranlara bakmadan geçmiş maçlardan (gol ve xG) ",
    "kurduğumuz model; Süper Lig, 5 büyük lig ve Avrupa kupalarında, diğerlerinde –. ",
    `Model piyasadan ${Math.round(EDGE * 100)}+ puan ayrılınca işaretlenir (yeşil: model daha yüksek görüyor). `,
    "Geçmiş testte piyasa daha isabetli çıktı; fark bir fikir verir, kesin değer değildir. ",
    pbl ? blendNote() : "",
    "Model gol sayısını genelde piyasadan az bekliyor; alt/üst farklarına bu gözle bakın."));
  kids.push(h("p", { class: "small muted iddaa-note" },
    `iddaa oranını seçeneğin altındaki kutuya yaz (1,85 ya da 1.85): beklenen değer (BD) = olasılık × oran − 1. `,
    minor ? "" : `+%${bandPct()} üstü değerli, −%${bandPct()} altı düşük, arası adil. `,
    minor ? "Bu ligde piyasa yok ve model doğrulanmamış: BD renklendirilmez, \"doğrulanmamış model\" diye yazılır. " : "Olasılık, sitede gösterilen olasılıktır (MS'de harman ya da piyasa, diğer pazarlarda piyasa). ",
    "Oran sadece bu cihazda saklanır, Kuponum'a da geçer; maç başladıktan 24 saat sonra silinir."));
  for (const [market, title] of Object.entries(GROUPS)) {
    const opts = m.options.filter((o) => o.market === market);
    if (!opts.length) continue;
    kids.push(h("h2", {}, title));
    const rows = [];
    let margin = null;
    const live = market === "h2h" ? () => margin && margin.update() : null;
    kids.push(h("div", { class: "options" }, opts.map((o) => {
      const row = iddaaRow(m, o, minor, live);
      rows.push(row);
      return h("div", { class: "optcell" }, optButton(o), row.el);
    })));
    if (market === "h2h") { margin = marginLine(m, rows); kids.push(margin.el); }
  }
  kids.push(...statsBlock(m));
  kids.push(...injuryBlock(m));
  kids.push(...nbaBlock(m));
  if (m.info) kids.push(...infoBlock(m));
  kids.push(note(minor));
  root.replaceChildren(...kids);

  function optButton(o) {
      if (minor) {
        return h("button", { type: "button", class: "opt", "aria-pressed": inKupon(o.key),
          onclick: () => { toggleOption(m, o); render(); } },
          h("span", { class: "p" }, h("span", {}, o.pick), h("span", { class: "prob model" }, `Model ${pct(o.prob)}`)),
          h("span", { class: "fairbox" }, h("span", { class: "odds fair" }, odds(o.fair)), h("small", {}, "adil")));
      }
      const d = diffOf(o);
      const flag = d != null && Math.abs(d) >= EDGE;
      return h("button", { type: "button", class: flag ? (d > 0 ? "opt up" : "opt down") : "opt", disabled: !o.addable,
        "aria-pressed": inKupon(o.key),
        title: o.price && !o.addable ? "Çeyrek çizgi: yarım kazanç/iade kuralı nedeniyle kupona eklenemez" : null,
        onclick: () => { toggleOption(m, o); render(); } },
        h("span", { class: "p" }, h("span", {}, o.pick),
          h("span", { class: "prob" }, blendOn(m) && o.market_prob != null && Math.abs(o.prob - o.market_prob) > 0.0005
            ? `Harman ${pct(o.prob)} adil ${odds(o.fair)} (piyasa ${pct(o.market_prob)})`
            : `Piyasa ${pct(o.market_prob ?? o.prob)} adil ${odds(o.fair)}`),
          h("span", { class: "prob model" }, `Model ${pct(o.model_prob)}`,
            flag ? h("span", { class: d > 0 ? "diff up" : "diff down" }, pts(d)) : null)),
        h("span", { class: "odds" }, o.price ? odds(o.price) : "–"));
  }
}
/* Maç öncesi ek istatistikler (LFA özetleri): en olası skorlar + iki takım karşılaştırma tablosu. */
const XG_GAP = 0.4; // son 5 maçta maç başı gol − xG farkı bu kadarsa not düş
function statsBlock(m) {
  const s = m.stats;
  if (!s) return [];
  const out = [h("h2", {}, "İstatistikler")];
  if (s.top_scores && s.top_scores.length) {
    out.push(h("p", { class: "small muted" }, minorOrModel(m)),
      h("div", { class: "scores" }, s.top_scores.map((t) => h("span", { class: "score" }, h("b", {}, t.score), pct(t.p)))));
  }
  const H = s.home, A = s.away;
  if (H || A) {
    const two = (x, k1, k2, dp) => (x && x[k1] != null ? `${x[k1].toFixed(dp)} – ${x[k2].toFixed(dp)}` : "–");
    const rows = [
      ["Üst 2.5", (t) => pct(t && t.venue.over25)],
      ["KG Var", (t) => pct(t && t.venue.btts)],
      ["Gol yemedi", (t) => pct(t && t.venue.clean_sheet)],
      ["Gol atamadı", (t) => pct(t && t.venue.failed_to_score)],
      ["xG (son 5, ort.)", (t) => two(t && t.xg_form, "xg_for", "xg_against", 2)],
      ["Gol (son 5, ort.)", (t) => two(t && t.xg_form, "goals_for", "goals_against", 2)],
      ["Korner (maç başı)", (t) => two(t && t.corners, "for", "against", 1)],
      ["Sarı kart (maç başı)", (t) => two(t && t.yellow, "for", "against", 1)],
    ];
    const head = (name, t, where) => h("th", { class: "num" }, h("span", { class: "th-team" }, name),
      h("small", { class: "muted" }, t ? `${where}, ${t.venue.n} maç` : "veri yok"));
    out.push(h("div", { class: "table-wrap" }, h("table", { class: "stats-table" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), head(m.home, H, "iç saha"), head(m.away, A, "dış saha"))),
      h("tbody", {}, rows.map(([label, f], i) => h("tr", { class: i === 4 ? "sep" : null },
        h("td", {}, label), h("td", { class: "num" }, f(H)), h("td", { class: "num" }, f(A))))))));
    const notes = [[m.home, H], [m.away, A]].flatMap(([name, t]) => {
      const x = t && t.xg_form;
      if (!x) return [];
      const att = x.goals_for - x.xg_for, def = x.goals_against - x.xg_against;
      const n = [];
      if (att >= XG_GAP) n.push(`${name} son maçlarda xG'sinin üstünde gol atıyor (şanslı gidiyor olabilir).`);
      if (att <= -XG_GAP) n.push(`${name} son maçlarda xG'sinin altında gol atıyor (fırsatları değerlendiremiyor).`);
      if (def >= XG_GAP) n.push(`${name} rakiplerin xG'sinden fazla gol yiyor.`);
      if (def <= -XG_GAP) n.push(`${name} rakiplerin xG'sinden az gol yiyor (kalecisi/şansı iyi gidiyor).`);
      return n;
    });
    out.push(h("p", { class: "small muted" }, "İlk 4 satır bu sezonun maçlarından: ev sahibinin iç saha, deplasman ",
      "takımının dış saha maçları. 'a – b' = lehine – aleyhine. xG: atılması beklenen gol (pozisyon kalitesi)."));
    if (notes.length) out.push(h("ul", { class: "xg-notes" }, notes.map((t) => h("li", {}, t))));
  }
  return out;
}
/* Sakat/cezalı oyuncular (§26-4): sadece eksik adları ve hesaplanan beklenen gol farkı; olasılıklara dahil değil. */
function injuryBlock(m) {
  const j = m.injuries;
  if (!j) return [];
  const sign = (x) => (x > 0 ? "+" : x < 0 ? "−" : "±") + Math.abs(x).toFixed(1).replace(".", ",") + "%";
  const side = (name, t) => h("div", {}, h("h3", {}, name),
    t && t.missing.length ? h("p", { class: "small" }, t.missing.join(", ")) : h("p", { class: "small muted" }, "Bildirilen eksik yok."),
    t && (t.attack_pct || t.defence_pct) ? h("p", { class: "small muted" },
      `Tahmini etki: attığı gol ${sign(t.attack_pct)}, yediği gol ${sign(t.defence_pct)}`) : null);
  return [h("h2", {}, "Eksikler (sakat / cezalı)"),
    h("div", { class: "two" }, side(m.home, j.home), side(m.away, j.away)),
    h("p", { class: "small muted" }, "Etki, oyuncunun son 10 maçtaki süresi ve gol+asist payından hesaplanır. ",
      "Bu düzeltme şimdilik sadece ölçülüyor; yukarıdaki olasılıklara dahil değil.")];
}
/* §28 NBA: beklenen fark/toplam (piyasa ve model yan yana). */
const signed = (x) => (x > 0 ? "+" : x < 0 ? "−" : "±") + Math.abs(x).toFixed(1);
function nbaExpected(m) {
  const e = m.expected, me = m.model_expected;
  const cell = (label, mk, md) => h("div", {}, h("span", { class: "small muted" }, label), h("b", {}, mk),
    md != null ? h("small", { class: "muted" }, ` model ${md}`) : null);
  return h("div", { class: "expected" },
    cell(`${m.home} beklenen fark`, signed(e.margin), me ? signed(me.margin) : null),
    e.total != null || me ? cell("Beklenen toplam", e.total != null ? e.total.toFixed(1) : "–", me ? me.total.toFixed(1) : null) : null);
}
/* §28 NBA maç detayı: son 5 maç, rating ve pace, dinlenme, eksikler (türetilmiş özet). */
function nbaBlock(m) {
  if (m.sport !== "basketball") return [];
  const i = m.nba_info;
  if (!i) return [h("p", { class: "small muted" }, "Kendi model bu maç için kurulamadı (takım verisi yok); olasılıklar piyasadan.")];
  const form = (rows) => (rows && rows.length ? h("div", {},
    h("div", { class: "form", "aria-label": "Son 5 maç" }, rows.map((r) => h("span", { class: `res res-${r.result}`, title: `${r.opp} ${r.score}` }, r.result))),
    h("table", {}, h("tbody", {}, rows.map((r) => h("tr", {}, h("td", {}, fmtDate(r.date)), h("td", {}, r.opp),
      h("td", { class: "muted" }, r.home ? "iç saha" : "dış saha"), h("td", { class: "num" }, r.score))))))
    : h("p", { class: "muted small" }, "Bu sezon maç yok."));
  const out = [h("h2", {}, "Son 5 maç"),
    h("div", { class: "two" }, h("div", {}, h("h3", {}, m.home), form(i.form.home)), h("div", {}, h("h3", {}, m.away), form(i.form.away)))];
  const R = i.ratings || {}, H = R.home, A = R.away;
  if (H || A) {
    const v = (t, k, rk) => (t ? h("span", {}, t[k].toFixed(1), rk ? h("small", { class: "muted" }, ` (${t[rk]}.)`) : null) : "–");
    const rows = [["Hücum rating'i", (t) => v(t, "ortg")], ["Savunma rating'i", (t) => v(t, "drtg")],
      ["Net rating", (t) => (t ? h("span", {}, signed(t.net), h("small", { class: "muted" }, ` (${t.rank_net}.)`)) : "–")],
      ["Pace", (t) => v(t, "pace", "rank_pace")]];
    out.push(h("h2", {}, "Rating ve tempo"), h("div", { class: "table-wrap" }, h("table", { class: "stats-table" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", { class: "num" }, h("span", { class: "th-team" }, m.home)),
        h("th", { class: "num" }, h("span", { class: "th-team" }, m.away)))),
      h("tbody", {}, rows.map(([label, f]) => h("tr", {}, h("td", {}, label), h("td", { class: "num" }, f(H)), h("td", { class: "num" }, f(A))))))),
      h("p", { class: "small muted" }, "Rating: 100 hücumda atılan (hücum) ve yenen (savunma) sayı, rakip gücüne göre düzeltilmiş, ",
        "son maçlar daha ağırlıklı. Net = hücum − savunma; parantez içi lig sırası. Pace: 48 dakikadaki hücum sayısı."));
  }
  const rest = (t) => (!t || t.days == null ? "Sezonun ilk maçı" : t.b2b ? "Art arda ikinci gece (dün oynadı)"
    : `${t.days - 1} gün dinlendi`);
  out.push(h("h2", {}, "Dinlenme"), h("div", { class: "two" },
    h("div", {}, h("h3", {}, m.home), h("p", { class: i.rest.home && i.rest.home.b2b ? "small warn-text" : "small" }, rest(i.rest.home))),
    h("div", {}, h("h3", {}, m.away), h("p", { class: i.rest.away && i.rest.away.b2b ? "small warn-text" : "small" }, rest(i.rest.away)))));
  const j = i.injuries;
  const STAT = { Out: "Oynamayacak", Doubtful: "Şüpheli (zayıf ihtimal)" };
  const side = (name, list) => h("div", {}, h("h3", {}, name), list && list.length
    ? h("ul", { class: "small" }, list.map((x) => h("li", {}, `${x.name} – ${STAT[x.status] || x.status}`)))
    : h("p", { class: "small muted" }, j.status === "no_report" ? "Rapor alınamadı." : "Bildirilen eksik yok."));
  out.push(h("h2", {}, "Eksikler (resmi sakatlık raporu)"), h("div", { class: "two" }, side(m.home, j.home), side(m.away, j.away)),
    h("p", { class: "small muted" }, j.status === "no_report"
      ? "NBA resmi sakatlık raporu bu maç için henüz yok ya da okunamadı; model eksik düzeltmesi yapmadı."
      : `Oynamayacak ve şüpheli oyuncular, son 15 maçtaki süre ve +/- katkısına göre takım rating'inden düşüldü. `
        + `Ev sahibi beklenen farka etkisi: ${signed(j.effect)} sayı. Bu düzeltmenin işe yarayıp yaramadığı Performans'ta ayrı ölçülüyor.`));
  return out;
}
function minorOrModel(m) {
  return isMinor(m) ? "En olası skorlar (kendi model):" : "En olası skorlar (sitede gösterilen olasılıklarla):";
}
function formRow(rows) {
  if (!rows || !rows.length) return h("p", { class: "muted small" }, "Geçmiş veri yok.");
  return h("div", {},
    h("div", { class: "form", "aria-label": "Son 5 maç" }, rows.map((r) => h("span", { class: `res res-${r.result}`, title: `${r.opponent} ${r.score}` }, r.result))),
    h("table", {}, h("tbody", {}, rows.map((r) => h("tr", {},
      h("td", {}, fmtDate(r.date)), h("td", {}, r.opponent), h("td", { class: "muted" }, r.venue), h("td", { class: "num" }, r.score))))));
}
function infoBlock(m) {
  const i = m.info;
  const out = [h("h2", {}, "Maç öncesi bilgi"),
    h("div", { class: "two" },
      h("div", {}, h("h3", {}, `${m.home}, son 5 maç`), formRow(i.home_form)),
      h("div", {}, h("h3", {}, `${m.away}, son 5 maç`), formRow(i.away_form)))];
  if (i.h2h && i.h2h.length) {
    out.push(h("h2", {}, "Aralarındaki son maçlar"), h("table", {}, h("tbody", {}, i.h2h.map((x) =>
      h("tr", {}, h("td", {}, fmtDate(x.date)), h("td", {}, x.home), h("td", { class: "num" }, x.score), h("td", {}, x.away))))));
  }
  if (i.table && i.table.length) {
    const cols = ["Sıra", "Takım", "O", "G", "B", "M", "Av", "P"];
    out.push(h("h2", {}, "Puan durumu"), h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, cols.map((c) => h("th", { class: c === "Takım" ? null : "num" }, c)))),
      h("tbody", {}, i.table.map((r) => h("tr", { class: r["Takım"] === i.home_src || r["Takım"] === i.away_src ? "hl" : null },
        cols.map((c) => h("td", { class: c === "Takım" ? null : "num" }, r[c]))))))));
  }
  return out;
}

/* ---------- görünüm: kuponum ---------- */
function viewKupon(root) {
  const render = () => viewKupon(root);
  const legs = state.kupon;
  const kids = [h("h1", {}, "Kuponum"), budgetBanner()].filter(Boolean);
  if (!legs.length) {
    kids.push(h("p", { class: "empty" }, "Kuponun boş. Kuponlar ya da Maçlar bölümünden seçim ekle."));
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

  const card = h("div", { class: "card" },
    legs.map((l) => h("div", { class: "kleg" },
      h("div", { class: "leg-text" }, h("span", { class: "leg-pick" }, l.pick),
        h("span", { class: "leg-meta" }, `${fmtTime(l.kickoff)}  ${l.match}`),
        h("span", { class: "prob" }, `Olasılık ${pct(l.prob)}${legModel(l) ? " (model tahmini)" : ""}`),
        legVerified(l) ? h("span", { class: "leg-ev" }, h("span", { class: "small muted" }, "iddaa oranı "),
          evBadge(Iddaa.expectedValue(l.prob, legPrice(l)), legModel(l)))
          : h("span", { class: "warn" }, l.fair ? "Adil oran — iddaa oranını yaz" : "Yurtdışı oran — iddaa oranını yaz")),
      h("input", { type: "text", inputmode: "decimal", autocomplete: "off", value: odds(legPrice(l)), "aria-label": `${l.pick} iddaa oranı`,
        onchange: (ev) => {
          const t = ev.target.value.trim();
          const v = Iddaa.parseOdds(t);
          if (!t) setIddaa(l.matchId, l.kickoff, l.key, null); // boş: iddaa oranı silinir, eklendiği oran geri gelir
          else if (v != null) setIddaa(l.matchId, l.kickoff, l.key, v);
          else toast("Oran 1'den büyük bir sayı olmalı (1,85 ya da 1.85)");
          render();
        } }),
      h("button", { type: "button", class: "icon", "aria-label": `${l.pick} seçimini çıkar`,
        onclick: () => { state.kupon = state.kupon.filter((x) => x.key !== l.key); saveKupon(); render(); } }, "×"))),
    h("div", { class: "total" },
      h("div", {}, h("span", { class: "small muted" }, "Toplam oran"), h("span", { class: "big" }, odds(total))),
      h("div", { class: "r" }, h("span", { class: "small muted" }, "Tutma ihtimali"), h("span", { class: "mid" }, pct(totalProb)))),
    h("div", { class: "kupon-ev" }, totalEV == null ? h("span", { class: "small muted" }, "Beklenen değer: –")
      : evBadge(totalEV, anyModel, true)),
    unverified ? h("p", { class: "small muted" }, `${unverified} seçimde iddaa oranı yok; beklenen değer ve toplam oran o seçimlerde `,
      "yurtdışı ya da adil oranla hesaplandı.") : null,
    h("label", { class: "stake" }, h("span", {}, "Tutar (TL)"),
      h("input", { type: "text", inputmode: "decimal", autocomplete: "off", value: String(state.stake).replace(".", ","),
        "aria-label": "Tutar (TL)",
        onchange: (ev) => {
          const v = parseNum(ev.target.value);
          if (v > 0) state.stake = v; else toast("Tutar sıfırdan büyük olmalı");
          render();
        } }),
      h("span", { class: "muted" }, "Olası kazanç ", h("b", {}, tl(state.stake * total)))),
    dup.length ? h("p", { class: "warn" }, `Aynı maçtan birden fazla seçim: ${dup.join(", ")}. Bahis siteleri kabul etmeyebilir.`) : null,
    late.length ? h("p", { class: "warn" }, `Başlamış maç: ${late.join(", ")}`) : null,
    h("p", { class: "small muted" }, "Oranları iddaa'da gördüğün değerlerle değiştirebilirsin; maç detayındaki iddaa oranıyla aynı kayıttır ",
      "(kutuyu boşaltırsan seçimin eklendiği orana döner). Tutma ihtimali ve beklenen değer (Π olasılık × Π oran − 1) maçların ",
      "bağımsız olduğu varsayımıyla hesaplanır."),
    h("div", { class: "actions" },
      h("a", { class: "btn primary", href: shareLink(legs, total, totalProb), target: "_blank", rel: "noopener" }, "WhatsApp'ta paylaş"),
      h("button", { type: "button", class: "btn primary", "aria-expanded": state.playing,
        onclick: () => { state.playing = !state.playing; state.playDraft = null; render(); } }, "Oynadım"),
      h("button", { type: "button", class: "btn", onclick: () => { state.kupon = []; state.playing = false; saveKupon(); render(); } }, "Kuponu temizle")),
    state.playing ? playForm(legs, render) : null);
  root.replaceChildren(...kids, card, note());
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
    h("label", { class: "stake" }, h("span", {}, "Yatırılan tutar (TL)"),
      h("input", { type: "text", inputmode: "decimal", autocomplete: "off", value: draft.stake, required: true,
        "aria-label": "Yatırılan tutar (TL)", oninput: (ev) => { draft.stake = ev.target.value; showBudget(); } })),
    h("label", { class: "stake" }, h("span", {}, "Kupon tipi"),
      h("select", { "aria-label": "Kupon tipi", onchange: (ev) => { draft.type = ev.target.value; } },
        History.TYPES.map((t) => h("option", { value: t, selected: t === draft.type }, History.TYPE_NAMES[t])))),
    missingLegs.length ? h("div", { class: "play-missing" },
      h("h4", {}, "iddaa oranını gir"),
      missingLegs.map((l) => h("label", { class: "kleg play-leg" },
        h("span", { class: "leg-text" }, h("span", { class: "leg-pick" }, l.pick), h("span", { class: "leg-meta" }, l.match),
          legVerified(l) ? h("span", { class: "ok-text small" }, "✓ iddaa oranı girildi")
            : h("span", { class: "small muted" }, `${l.fair ? "Adil" : "Yurtdışı"} oran ${odds(l.price)}`)),
        h("input", { type: "text", inputmode: "decimal", autocomplete: "off", placeholder: odds(l.price),
          value: legVerified(l) ? odds(legPrice(l)) : "", "aria-label": `${l.pick} iddaa oranı`,
          onchange: (ev) => {
            const t = ev.target.value.trim();
            const val = Iddaa.parseOdds(t);
            if (!t) setIddaa(l.matchId, l.kickoff, l.key, null);
            else if (val != null) setIddaa(l.matchId, l.kickoff, l.key, val);
            else { toast("Oran 1'den büyük bir sayı olmalı (1,85 ya da 1.85)"); return; }
            render();
          } })))) : null,
    left ? h("p", { class: "warn" }, `${left} seçimin iddaa oranı girilmedi. Böyle kaydedersen kupon "oran doğrulanmadı" olarak `,
      "işaretlenir; kazanç yurtdışı ya da adil orana göre hesaplanır.") : null,
    preview,
    h("p", { class: "small muted" }, "Tutar sadece bu cihazda saklanır; siteye ya da başka bir yere gönderilmez."),
    h("div", { class: "actions" },
      h("button", { type: "submit", class: "btn primary" }, "Kaydet"),
      h("button", { type: "button", class: "btn", onclick: () => { state.playing = false; state.playDraft = null; render(); } }, "Vazgeç")));
  showBudget();
  return form;
}
function shareLink(legs, total, totalProb) {
  const lines = ["Kuponum (Maç Analiz)", ...legs.map((l) => `• ${l.pick} — ${l.match} @${odds(legPrice(l))}`
    + `${legVerified(l) ? "" : l.fair ? " (adil)" : " (yurtdışı)"}`),
    `Toplam oran: ${odds(total)}  Tutma ihtimali: ${pct(totalProb)}`];
  return `https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`;
}

/* ---------- görünüm: geçmiş (§27) ---------- */
const statusBadge = (st) => h("span", { class: `st ${STATUS[st][1]}` }, STATUS[st][0]);
const rate = (x) => (x == null ? "–" : `%${Math.round(x * 100)}`);
const netText = (x) => h("b", { class: x > 0 ? "pos" : x < 0 ? "neg" : null }, `${x > 0 ? "+" : ""}${tl(x)}`);
const manualNeeded = (c) => c.legs.some((l) => History.needsManual(l)
  || (History.legResult(l) === null && Date.now() - new Date(l.kickoff).getTime() > 7 * 86400 * 1000));
function summaryCard(title, s) {
  return h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h3", {}, title), h("span", { class: "pill" }, `${s.count} kupon`)),
    h("div", { class: "stats hstats" },
      h("div", {}, h("span", { class: "small muted" }, "Yatırılan"), h("b", {}, tl(s.staked))),
      h("div", {}, h("span", { class: "small muted" }, "Dönen"), h("b", {}, tl(s.returned))),
      h("div", {}, h("span", { class: "small muted" }, "Net"), netText(s.net)),
      h("div", {}, h("span", { class: "small muted" }, "Tutan"),
        h("b", {}, rate(s.hitRate)))),
    h("p", { class: "small muted" }, `${s.won} tuttu, ${s.lost} yattı${s.void ? `, ${s.void} iade` : ""}`,
      s.pending ? ` · ${s.pending} kupon bekliyor (${tl(s.pendingStaked)}; net sonuca katılmaz)` : ""));
}
function typeTable(coupons) {
  const rows = History.byType(coupons).filter((r) => r.count);
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "Kupon tipi"), h("th", { class: "num" }, "Sayı"),
      h("th", { class: "num" }, "Yatırılan"), h("th", { class: "num" }, "Net"), h("th", { class: "num" }, "Tutan"))),
    h("tbody", {}, rows.map((r) => h("tr", {}, h("td", {}, r.name), h("td", { class: "num" }, r.count),
      h("td", { class: "num" }, tl(r.staked)), h("td", { class: "num" }, netText(r.net)),
      h("td", { class: "num" }, r.hitRate == null ? "–" : `${rate(r.hitRate)} (${r.won}/${r.won + r.lost})`))))));
}
function calibrationBlock(coupons) {
  const c = History.calibration(coupons);
  const out = [h("h2", {}, "Tahmin ve gerçek")];
  if (!c.n) {
    out.push(h("p", { class: "empty" }, "Sonuçlanan kupon oldukça modelin verdiği tutma ihtimali ile gerçekleşen burada karşılaştırılır."));
    return out;
  }
  out.push(h("p", {}, `Sonuçlanan ${c.n} kuponda modelin ortalama tutma ihtimali `, h("b", {}, rate(c.expectedRate)),
      `, gerçekleşen `, h("b", {}, rate(c.actualRate)), `. Beklenen tutan kupon ${c.expectedWins.toFixed(1)}, tutan ${c.actualWins}.`),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Model ihtimali"), h("th", { class: "num" }, "Kupon"),
        h("th", { class: "num" }, "Tahmin"), h("th", { class: "num" }, "Gerçek"))),
      h("tbody", {}, c.bins.map((b) => h("tr", {}, h("td", {}, `%${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}`),
        h("td", { class: "num" }, b.n), h("td", { class: "num" }, rate(b.pred)), h("td", { class: "num" }, rate(b.obs))))))),
    h("p", { class: "small muted" }, c.n < 30
      ? `Sadece ${c.n} kupon var; bu kadar az kuponda fark büyük ölçüde şanstır.`
      : "Elle girilen iddaa oranları değil, kuponu oynadığın andaki model ihtimali karşılaştırılır. İade seçimler sayılmaz."));
  return out;
}
function budgetCard(render) {
  const b = History.budgetState(state.history, new Date());
  let val = state.history.budget ? String(state.history.budget).replace(".", ",") : "";
  return h("div", { class: "card" },
    h("h3", {}, "Aylık bütçe"),
    h("p", { class: "small muted" }, b ? `Bu ay ${tl(b.spent)} / ${tl(b.budget)} (%${Math.round(b.ratio * 100)}). `
      + "%80'e gelince ve aşınca Kuponum'da uyarı çıkar." : "İsteğe bağlı. Girersen %80'e gelince ve aşınca Kuponum'da uyarı çıkar."),
    b ? h("div", { class: "meter", role: "img", "aria-label": `Bütçenin %${Math.round(b.ratio * 100)}'i kullanıldı` },
      h("span", { class: b.level === "over" ? "over" : b.level === "near" ? "near" : null,
        style: `width:${Math.min(100, Math.round(b.ratio * 100))}%` })) : null,
    h("form", { class: "stake", onsubmit: (ev) => {
      ev.preventDefault();
      const v = parseNum(val);
      if (!(v > 0) || !Number.isFinite(v)) { toast("Bütçe sıfırdan büyük olmalı"); return; }
      state.history.budget = Math.round(v * 100) / 100;
      if (saveHistory()) toast("Bütçe kaydedildi");
      render();
    } },
      h("input", { type: "text", inputmode: "decimal", autocomplete: "off", value: val, placeholder: "TL", "aria-label": "Aylık bütçe (TL)",
        oninput: (ev) => { val = ev.target.value; } }),
      h("button", { type: "submit", class: "btn" }, "Kaydet"),
      state.history.budget ? h("button", { type: "button", class: "btn", onclick: () => {
        state.history.budget = null; saveHistory(); render();
      } }, "Kaldır") : null));
}
function backupCard(render) {
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
    } catch { toast("Yedek dosyası oluşturulamadı"); }
  };
  return h("div", { class: "card" },
    h("h3", {}, "Yedek"),
    h("p", { class: "small muted" }, "Geçmiş sadece bu tarayıcıda durur; tarayıcı verisi silinirse kaybolur. Ara sıra yedek al. ",
      "Yedekten yükleme mevcut kuponları silmez, birleştirir."),
    state.histMsg ? h("p", { class: state.histMsg.bad ? "odds-warn" : "ok-msg", role: "status" }, state.histMsg.text) : null,
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn", disabled: !state.history.coupons.length, onclick: download }, "Yedekle"),
      h("button", { type: "button", class: "btn", onclick: () => file.click() }, "Yedekten yükle"), file));
}
function viewHistory(root) {
  const render = () => viewHistory(root);
  applyResults();
  const all = [...state.history.coupons].sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt));
  const mk = History.monthKey(new Date().toISOString());
  const month = all.filter((c) => History.monthKey(c.playedAt) === mk);
  const monthName = new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, month: "long" }).format(new Date());
  const kids = [h("h1", {}, "Geçmiş")];
  if (state.historyError) kids.push(h("p", { class: "odds-warn", role: "alert" }, state.historyError));
  kids.push(budgetBanner() || "");
  if (!all.length) {
    kids.push(h("p", { class: "empty" }, "Henüz oynadığın kupon yok. Kuponum'da kuponu kurup \"Oynadım\"a bas."));
  } else {
    kids.push(h("div", { class: "grid" }, summaryCard(`Bu ay (${monthName})`, History.summarize(month)),
      summaryCard("Tüm zamanlar", History.summarize(all))));
    kids.push(h("h2", {}, "Kupon tipine göre"), typeTable(all));
    kids.push(...calibrationBlock(all));
    const unv = all.filter((c) => c.unverified).length;
    kids.push(h("h2", {}, "Kuponlar"));
    if (unv) kids.push(h("p", { class: "small muted" }, `${unv} kupon iddaa oranı girilmeden kaydedildi (`,
      h("span", { class: "pill unv" }, "Oran doğrulanmadı"), "); kazançları gerçek iddaa oranıyla farklı olabilir."));
    kids.push(h("div", { class: "hlist" }, all.map((c) => {
      const r = History.settle(c);
      const manual = r.status === "pending" && manualNeeded(c);
      return h("a", { class: "hrow", href: `#/gecmis/${encodeURIComponent(c.id)}` },
        h("span", { class: "hrow-main" },
          h("span", { class: "hrow-top" }, h("span", {}, fmtDateTime(c.playedAt)), h("span", { class: "pill" }, History.TYPE_NAMES[c.type]),
            c.unverified ? h("span", { class: "pill unv" }, "Oran doğrulanmadı") : null),
          h("span", { class: "leg-meta" }, `${c.legs.length} seçim · oran ${odds(c.totalOdds)} · ihtimal ${pct(c.totalProb)}`)),
        h("span", { class: "hrow-num" }, h("b", {}, tl(c.stake)),
          manual ? h("span", { class: "st st-manual" }, "Elle sonuçlandır") : statusBadge(r.status),
          r.status === "won" || r.status === "void" ? h("small", { class: "muted" }, tl(r.payout)) : null));
    })));
  }
  kids.push(h("h2", {}, "Ayarlar"), h("div", { class: "grid" }, budgetCard(render), backupCard(render)));
  kids.push(h("p", { class: "note" }, "Sonuçlar maç bittikten sonraki sabah güncellemesiyle gelir (son 7 gün). Ertelenen, iptal edilen ",
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
  const render = () => viewHistoryDetail(root, id);
  applyResults();
  const c = state.history.coupons.find((x) => x.id === id);
  const back = h("a", { class: "back", href: "#/gecmis" }, "‹ Geçmiş");
  if (!c) { root.replaceChildren(back, h("p", { class: "empty" }, "Kupon bulunamadı.")); return; }
  const r = History.settle(c);
  const touch = () => { c.updatedAt = new Date().toISOString(); saveHistory(); render(); };
  const choice = (l, val, label) => h("button", { type: "button", "aria-pressed": (l.manual || null) === val,
    onclick: () => { l.manual = val; touch(); } }, label);
  root.replaceChildren(back,
    h("h1", {}, "Oynanan kupon"),
    h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h3", {}, fmtDateTime(c.playedAt)), statusBadge(r.status)),
      c.unverified ? h("p", { class: "odds-warn" }, h("b", {}, "Oran doğrulanmadı: "),
        "bazı seçimlerin iddaa oranı girilmeden kaydedildi; oran ve kazanç yurtdışı ya da adil orana göre.") : null,
      h("label", { class: "stake" }, h("span", {}, "Kupon tipi"),
        h("select", { "aria-label": "Kupon tipi", onchange: (ev) => { c.type = ev.target.value; touch(); } },
          History.TYPES.map((t) => h("option", { value: t, selected: t === c.type }, History.TYPE_NAMES[t])))),
      c.legs.map((l) => h("div", { class: "hleg" },
        h("div", { class: "leg-text" }, h("span", { class: "leg-pick" }, l.pick),
          h("span", { class: "leg-meta" }, `${fmtDateTime(l.kickoff)}  ${l.match}`),
          h("span", { class: "prob" }, `Oran ${odds(l.price)}${l.fair ? " (adil)" : ""}${l.verified === false ? " (doğrulanmadı)" : ""}`,
            ` · olasılık ${pct(l.prob)}`),
          h("span", { class: History.needsManual(l) ? "warn" : "small muted" }, legStatusText(l))),
        h("div", { class: "seg small-seg", role: "group", "aria-label": `${l.pick} sonucu` },
          choice(l, null, "Otomatik"), choice(l, "won", "Tuttu"), choice(l, "lost", "Yattı"), choice(l, "void", "İade")))),
      h("div", { class: "total" },
        h("div", {}, h("span", { class: "small muted" }, "Toplam oran"), h("span", { class: "big" }, odds(c.totalOdds))),
        h("div", { class: "r" }, h("span", { class: "small muted" }, "Tutma ihtimali"), h("span", { class: "mid" }, pct(c.totalProb)))),
      h("div", { class: "stats hstats" },
        h("div", {}, h("span", { class: "small muted" }, "Yatırılan"), h("b", {}, tl(c.stake))),
        h("div", {}, h("span", { class: "small muted" }, "Dönen"), h("b", {}, r.payout == null ? "–" : tl(r.payout))),
        h("div", {}, h("span", { class: "small muted" }, "Net"), r.payout == null ? h("b", {}, "–") : netText(r.payout - c.stake))),
      r.status === "won" && r.odds !== c.totalOdds ? h("p", { class: "small muted" }, `İade seçimler oran 1 sayıldı: geçerli oran ${odds(r.odds)}.`) : null,
      h("p", { class: "small muted" }, "\"Otomatik\" maç skoruna göre sonuçlandırır; elle seçtiğin sonuç her zaman önce gelir. ",
        "Bir seçim yatınca kupon yatar; İade seçilen maçın oranı 1 sayılır."),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn danger", onclick: () => {
          if (!confirm("Bu kupon geçmişten silinsin mi? Geri alınamaz (yedeğin yoksa).")) return;
          state.history.coupons = state.history.coupons.filter((x) => x.id !== c.id);
          if (saveHistory()) { toast("Kupon silindi"); location.hash = "#/gecmis"; }
        } }, "Kuponu sil"))));
}
/* ---------- görünüm: performans ---------- */
const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  for (const kid of kids.flat(Infinity)) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const brier = (x) => (x == null ? "–" : Number(x).toFixed(3));
function calibrationChart(bins) {
  const W = 320, P = 36, I = W - P - 12; // iç alan
  const X = (v) => P + v * I, Y = (v) => 12 + (1 - v) * I;
  const maxN = Math.max(1, ...bins.map((b) => b.n));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const used = bins.filter((b) => b.n > 0);
  return svg("svg", { viewBox: `0 0 ${W} ${W}`, class: "calib", role: "img",
    "aria-label": "Kalibrasyon grafiği: yatay eksen tahmin edilen olasılık, dikey eksen gerçekleşme oranı" },
    ticks.map((t) => [
      svg("line", { x1: X(0), x2: X(1), y1: Y(t), y2: Y(t), class: "grid" }),
      svg("text", { x: P - 6, y: Y(t) + 4, class: "tick", "text-anchor": "end" }, `%${t * 100}`),
      svg("text", { x: X(t), y: W - 6, class: "tick", "text-anchor": "middle" }, `%${t * 100}`),
    ]),
    svg("line", { x1: X(0), y1: Y(0), x2: X(1), y2: Y(1), class: "diag" }),
    used.length > 1 ? svg("polyline", { points: used.map((b) => `${X(b.pred)},${Y(b.obs)}`).join(" "), class: "path" }) : null,
    used.map((b) => svg("circle", { cx: X(b.pred), cy: Y(b.obs), r: 3 + 7 * Math.sqrt(b.n / maxN), class: "dot" },
      svg("title", {}, `Tahmin ${pct(b.pred)}, gerçekleşen ${pct(b.obs)} (${b.n} olay)`))));
}
const OUT = ["home", "draw", "away"];
function outcomeOf(score) {
  const [a, b] = score.split("-").map(Number);
  return a > b ? "home" : a < b ? "away" : "draw";
}
function viewPerformance(root) {
  const p = DATA.performance;
  const kids = [h("h1", {}, "Performans"),
    h("p", { class: "muted" }, "Maç başlamadan önceki son tahminlerimiz gerçek sonuçlarla karşılaştırılıyor. ",
      "Süper Lig, 5 büyük lig, Şampiyonlar Ligi ve Avrupa Ligi; sonuçlar maçtan sonraki ilk güncellemede eklenir.")];
  if (!p || !p.n) {
    kids.push(h("p", { class: "empty" }, "Canlı ölçüm: henüz sonuçlanmış maç yok. Maçlar bittikçe burada görünecek."),
      ...blendLiveBlock(), ...backtestBlock(), ...minorBlock(), ...nbaPerfBlock(), note());
    root.replaceChildren(...kids);
    return;
  }
  kids.push(h("div", { class: "stats" },
    h("div", {}, h("span", { class: "small muted" }, "Ölçülen maç"), h("b", {}, p.n)),
    h("div", {}, h("span", { class: "small muted" }, "Favori tuttu"), h("b", {}, pct(p.favorite_hit))),
    h("div", {}, h("span", { class: "small muted" }, "Dönem"), h("span", { class: "range" }, `${fmtDate(p.from)} – ${fmtDate(p.to)}`))));
  if (p.n < p.min_reliable) {
    kids.push(h("p", { class: "warn" }, `Henüz az veri (${p.n} maç): sonuçlar şansa çok bağlı, ${p.min_reliable}+ maçtan sonra daha anlamlı.`));
  }

  const hasModel = p.markets.some((m) => m.model_n > 0);
  kids.push(h("h2", {}, "Brier skoru"),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Pazar"), h("th", { class: "num" }, "Brier"), h("th", { class: "num" }, "Kıyas"),
        hasModel ? h("th", { class: "num" }, "Kendi model") : null)),
      h("tbody", {}, p.markets.map((m) => h("tr", {},
        h("td", {}, m.name),
        h("td", { class: m.brier != null && m.brier < m.baseline ? "num good" : "num" }, h("b", {}, brier(m.brier))),
        h("td", { class: "num muted" }, brier(m.baseline)),
        hasModel ? h("td", { class: "num" }, brier(m.model_brier), m.model_n ? h("small", { class: "muted" }, ` (${m.model_n})`) : null) : null))))),
    h("p", { class: "small muted" }, "Brier: tahmin ile sonuç arasındaki farkın karesi; 0 kusursuz, düşük daha iyi. ",
      "Kıyas: hiçbir bilgi olmadan tahmin etmek (1X2'de her sonuca %33, diğerlerinde %50). Kıyastan düşükse tahminler işe yarıyor."));

  kids.push(h("h2", {}, "Kalibrasyon"),
    h("div", { class: "card calib-card" }, calibrationChart(p.calibration)),
    h("p", { class: "small muted" }, "Her nokta bir olasılık dilimi (1, X, 2, Üst 2.5 ve KG Var tahminlerinin hepsi): ",
      "yatayda ortalama tahminimiz, dikeyde gerçekte ne sıklıkla olduğu. Noktalar kesikli çizgiye yakınsa olasılıklar dürüst: ",
      "%70 dediğimiz olaylar 10'da 7 tutuyor. Büyük nokta = daha çok olay."),
    h("details", {}, h("summary", { class: "small" }, "Dilim tablosu"),
      h("table", {}, h("thead", {}, h("tr", {}, ["Dilim", "Tahmin", "Gerçekleşen", "Olay"].map((c, i) => h("th", { class: i ? "num" : null }, c)))),
        h("tbody", {}, p.calibration.filter((b) => b.n).map((b) => h("tr", {},
          h("td", {}, `%${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}`), h("td", { class: "num" }, pct(b.pred)),
          h("td", { class: "num" }, pct(b.obs)), h("td", { class: "num" }, b.n)))))));

  kids.push(h("h2", {}, "Son maçlar"),
    h("div", { class: "table-wrap" }, h("table", { class: "recent" },
      h("thead", {}, h("tr", {}, h("th", {}, "Maç"), h("th", { class: "num" }, "Skor"),
        ["1", "X", "2"].map((c) => h("th", { class: "num" }, c)))),
      h("tbody", {}, p.recent.map((r) => {
        const won = outcomeOf(r.score);
        const fav = OUT.reduce((a, k) => (r[`p_${k}`] > r[`p_${a}`] ? k : a), "home");
        return h("tr", {},
          h("td", {}, h("span", { class: "rm" }, `${r.home} – ${r.away}`), h("small", { class: "muted" }, fmtDate(r.kickoff))),
          h("td", { class: "num" }, h("b", {}, r.score)),
          OUT.map((k) => h("td", { class: k === won ? (k === fav ? "num hit" : "num act") : "num" }, pct(r[`p_${k}`]))));
      })))),
    h("p", { class: "small muted" }, "Yeşil: favori dediğimiz sonuç oldu. Sarı: gerçekleşen sonuç (favori değildi)."));
  const inj = p.injury;
  if (inj && inj.n) {
    kids.push(h("h2", {}, "Sakatlık düzeltmesi (deneme)"),
      h("p", { class: "small" }, `${inj.n} maçta kendi model Brier ${brier(inj.model_brier)}, eksik oyuncularla düzeltilmiş `,
        `${brier(inj.injury_brier)}. `, inj.proven ? "Düzeltme işe yarıyor."
          : `Kanıt için en az ${inj.min_n} maçta, farkın standart hatasından büyük olması gerekiyor; o zamana kadar olasılıklara katılmaz.`));
  }
  kids.push(...blendLiveBlock(), ...backtestBlock(), ...minorBlock(), ...nbaPerfBlock(), note());
  root.replaceChildren(...kids);
}
/* §28 NBA: canlı ölçüm (piyasa, model, resmi raporla düzeltilmiş model, harman), 300 maç harman sayacı, geçmiş test. */
function nbaPerfBlock() {
  const p = DATA.performance_nba;
  if (!p) return [];
  const NAMES = { market: "Piyasa (sitede gösterilen)", model: "Kendi model", model_injury: "Model + resmi sakatlık raporu", blend: "Harman" };
  const num = (x, d) => (x == null ? "–" : x.toFixed(d));
  const out = [h("h2", { class: "sport-head" }, "NBA"),
    h("p", { class: "muted" }, "NBA maç sonucu (uzatmalar dahil) tahminleri; sonuçlar ertesi sabah eklenir. ",
      "Geçmiş oran olmadığı için piyasa ile model sadece canlıda karşılaştırılabiliyor.")];
  const bl = p.blend;
  out.push(h("p", { class: "small" }, bl.decided_at
    ? `Harman ${fmtDate(bl.decided_at)} tarihinde ${bl.need} maçla karara bağlandı: son 100 maçta Brier harman ${brier(bl.blend_brier)}, `
      + `piyasa ${brier(bl.market_brier)}, model ${brier(bl.model_brier)}. Sitede ${bl.use_on_site ? "harman" : "piyasa"} gösteriliyor.`
    : `Harman kararı için: ${bl.n}/${bl.need} maç. Dolunca ilk 200 maçla harman öğrenilecek, son 100 maçta piyasayı geçerse sitede gösterilecek.`));
  const rows = p.markets.filter((r) => r.n);
  if (!rows.length) out.push(h("p", { class: "empty" }, "Canlı ölçüm: henüz sonuçlanmış NBA maçı yok."));
  else {
    if (p.n < p.min_reliable) out.push(h("p", { class: "warn" }, `Henüz az veri (${p.n} maç): sonuçlar şansa çok bağlı.`));
    out.push(h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Tahmin", "Maç", "Brier", "Log loss", "Favori tuttu", "Fark hatası"].map((c, i) => h("th", { class: i ? "num" : null }, c)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, h("td", {}, NAMES[r.key] || r.key), h("td", { class: "num" }, r.n),
        h("td", { class: "num" }, h("b", {}, brier(r.brier))), h("td", { class: "num" }, num(r.logloss, 3)),
        h("td", { class: "num" }, pct(r.accuracy)), h("td", { class: "num" }, num(r.mae_margin, 1))))))),
      h("p", { class: "small muted" }, "Brier kıyası (her maça %50): 0.250. Fark hatası: ev sahibi sayı farkı tahmininin ortalama mutlak hatası."));
    const inj = p.injury;
    if (inj && inj.n) out.push(h("p", { class: "small" }, `Resmi sakatlık raporu düzeltmesi: ${inj.n} maçın ${inj.with_report}'inde rapor vardı; `,
      `Brier farkı ${inj.diff > 0 ? "+" : ""}${num(inj.diff, 4)}${inj.se != null ? ` ± ${num(inj.se, 4)}` : ""} (eksi = düzeltme işe yarıyor).`));
    out.push(h("div", { class: "table-wrap" }, h("table", { class: "recent" },
      h("thead", {}, h("tr", {}, h("th", {}, "Maç"), h("th", { class: "num" }, "Skor"), h("th", { class: "num" }, "Piyasa"), h("th", { class: "num" }, "Model"))),
      h("tbody", {}, p.recent.map((r) => {
        const hw = Number(r.score.split("-")[0]) > Number(r.score.split("-")[1]);
        const cls = (q) => (q == null ? "num" : (q > 0.5) === hw ? "num hit" : "num");
        return h("tr", {}, h("td", {}, h("span", { class: "rm" }, `${r.home} – ${r.away}`), h("small", { class: "muted" }, fmtDate(r.kickoff))),
          h("td", { class: "num" }, h("b", {}, r.score)), h("td", { class: cls(r.k_home) }, pct(r.k_home)), h("td", { class: cls(r.i_home) }, pct(r.i_home)));
      })))), h("p", { class: "small muted" }, "Olasılıklar ev sahibinin kazanması için. Yeşil: favori dediği takım kazandı."));
  }
  const b = p.backtest;
  if (b) {
    out.push(h("h3", { class: "sub" }, `Geçmiş test (${b.season} sezonu, sadece model)`),
      h("p", { class: "small muted" }, "Her gün sadece o günden önceki maçlarla yeniden kurulan model, o günün maçlarını tahmin etti. ",
        "Ayarlar bir önceki sezonda seçildi; test sezonu bir kez kullanıldı."),
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, ["Model", "Maç", "Brier", "Log loss", "Favori tuttu", "Fark hatası", "Toplam hatası"].map((c, i) => h("th", { class: i ? "num" : null }, c)))),
        h("tbody", {}, [["Eksik düzeltmesiz", b.plain], ["Eksik düzeltmeli", b.absence]].map(([name, r]) => h("tr", {},
          h("td", {}, name), h("td", { class: "num" }, r.n.toLocaleString("tr-TR")), h("td", { class: "num" }, h("b", {}, brier(r.brier))),
          h("td", { class: "num" }, num(r.logloss, 3)), h("td", { class: "num" }, pct(r.accuracy)),
          h("td", { class: "num" }, num(r.mae_margin, 1)), h("td", { class: "num" }, num(r.mae_total, 1))))))),
      h("p", { class: "small muted" }, `Kıyas (hep ev sahibi oranı): Brier ${brier(b.baseline_brier)}. `,
        "Eksik düzeltmeli satırda eksikler maç kaydından (o maçta oynamayan düzenli oyuncular) çıkarıldı; bu, son dakika ",
        "kararlarını ve dinlendirmeyi de bildiği için biraz iyimserdir. Canlıda resmi rapor kullanılır ve ayrı ölçülür."));
  }
  return out;
}
function minorBlock() {
  const b = DATA.minor_info && DATA.minor_info.backtest;
  if (!b) return [];
  const out = [h("h2", {}, "Diğer ligler (sadece model)"),
    h("p", { class: "muted" }, "Oranı çekilmeyen 8 ligde kendi modelin geçmiş testi: her hafta sadece o haftadan önceki ",
      "maçlarla kuruldu, gerçek sonuçlarla karşılaştırıldı."),
    h("div", { class: "stats" },
      h("div", {}, h("span", { class: "small muted" }, "Test edilen maç"), h("b", {}, b.n.toLocaleString("tr-TR"))),
      h("div", {}, h("span", { class: "small muted" }, "Favori tuttu"), h("b", {}, pct(b.accuracy))),
      h("div", {}, h("span", { class: "small muted" }, "Brier (kıyas 0.667)"), h("b", {}, brier(b.brier)))),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Lig"), h("th", { class: "num" }, "Maç"), h("th", { class: "num" }, "Favori tuttu"))),
      h("tbody", {}, (b.leagues || []).map((l) => h("tr", {}, h("td", {}, l.name), h("td", { class: "num" }, l.n),
        h("td", { class: "num" }, pct(l.accuracy)))))))];
  if (b.calibration && b.calibration.length) {
    out.push(h("h3", { class: "sub" }, "Modelin olasılıkları ne kadar dürüst?"),
      h("div", { class: "card calib-card" }, calibrationChart(b.calibration)),
      h("p", { class: "small muted" }, "Orta aralıkta noktalar çizgiye yakın. Uçlarda model temkinli: çok güçlü favoriler ",
        "dediğinden biraz daha sık kazanıyor, sürprizler biraz daha seyrek oluyor."));
  }
  return out;
}
function blendNote() {
  const b = DATA.blend;
  const head = "Harman: piyasa ve modelin geçmiş maçlarla öğrenilmiş birleşimi. ";
  if (!b) return head;
  return head + (b.use_on_site ? "Testte piyasadan isabetli çıktığı için gösterilen olasılık harmandır. "
    : "Testte piyasayı belirgin geçemediği için gösterilen olasılık piyasadır. ");
}
function backtestBlock() {
  const b = DATA.backtest;
  if (!b) return [];
  const onSite = DATA.blend && DATA.blend.use_on_site;
  const rows = [[onSite ? "Piyasa (kapanış)" : "Piyasa (sitede gösterilen)", b.market], ["Kendi model", b.model]];
  const better = (k, lowGood) => (lowGood ? (b.market[k] <= b.model[k] ? 0 : 1) : (b.market[k] >= b.model[k] ? 0 : 1));
  const cell = (r, i, k, lowGood, fmt) =>
    h("td", { class: better(k, lowGood) === i ? "num good" : "num" }, h("b", {}, fmt(r[k])));
  const out = [h("h2", {}, "Geçmiş test"),
    h("p", { class: "muted" }, "Süper Lig ve 5 büyük ligde geçmiş maçlar: model her hafta sadece o haftadan önceki maçlarla ",
      "yeniden kuruldu ve o haftanın maçlarını tahmin etti; piyasa olarak kapanış oranları kullanıldı."),
    h("div", { class: "stats" },
      h("div", {}, h("span", { class: "small muted" }, "Test edilen maç"), h("b", {}, b.n.toLocaleString("tr-TR"))),
      h("div", {}, h("span", { class: "small muted" }, "Dönem"), h("span", { class: "range" }, `${fmtDate(b.from)} – ${fmtDate(b.to)}`))),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Maç sonucu (1X2)"), h("th", { class: "num" }, "Favori tuttu"),
        h("th", { class: "num" }, "Brier"))),
      h("tbody", {}, rows.map(([name, r], i) => h("tr", {}, h("td", {}, name),
        cell(r, i, "accuracy", false, pct), cell(r, i, "brier", true, brier)))))),
    h("p", { class: "small muted" }, "Yeşil: daha iyi olan. Brier kıyası (her sonuca %33): 0.667. ",
      onSite ? "Kapanış oranlarını yenmek çok zordur; model tek başına geride kalıyor. Sitede piyasa ve modelin harmanı gösterilir (aşağıda)."
        : "Kapanış oranlarını yenmek çok zordur; bu yüzden sitede piyasa olasılığı gösterilir, model yanında bilgi olarak durur.")];
  const bl = DATA.blend;
  if (bl && bl.blend_brier != null) {
    out.push(h("h3", { class: "sub" }, "Harman (piyasa + model)"),
      h("p", { class: "small" }, `Geçen sezonla öğrenildi, bu sezonun ${bl.n_test} maçında test edildi: Brier piyasa `,
        `${brier(bl.market_brier)}, harman ${brier(bl.blend_brier)}. `,
        bl.use_on_site ? "Fark standart hatasından büyük olduğu için sitede harman gösteriliyor (fark küçük)."
          : "Fark belirgin olmadığı için sitede piyasa gösteriliyor."));
  }
  if (onSite) return out;  // aşağıdaki kalibrasyon grafiği piyasa içindir
  if (b.calibration && b.calibration.length) {
    out.push(h("h3", { class: "sub" }, "Sitedeki olasılıklar ne kadar dürüst?"),
      h("div", { class: "card calib-card" }, calibrationChart(b.calibration)),
      h("p", { class: "small muted" }, "Geçmiş testteki tüm 1, X, 2 olasılıkları: yatayda tahmin, dikeyde gerçekleşme. ",
        "Noktalar kesikli çizgiye yakınsa %40 dediğimiz sonuçlar gerçekten 10'da 4 civarı oluyor."));
  }
  return out;
}

/* ---------- yönlendirme ---------- */
function route() {
  const root = document.getElementById("view");
  const hash = location.hash || "#/";
  const tab = hash.startsWith("#/kupon") ? "kupon" : hash.startsWith("#/mac") ? "maclar"
    : hash.startsWith("#/performans") ? "performans" : hash.startsWith("#/gecmis") ? "gecmis" : "kuponlar";
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (!DATA) return;
  if (hash.startsWith("#/mac/")) {
    const ref = byId.get((() => { try { return decodeURIComponent(hash.slice(6)); } catch { return ""; } })());
    if (ref) { state.sport = ref.sport; updateHeader(); } // maç detayında o sporun oran zamanı
  }
  if (hash.startsWith("#/mac/")) {
    let id = "";
    try { id = decodeURIComponent(hash.slice(6)); } catch { /* bozuk adres → bulunamadı */ }
    viewMatch(root, id);
  }
  else if (hash.startsWith("#/maclar")) viewMatches(root);
  else if (hash.startsWith("#/kupon")) viewKupon(root);
  else if (hash.startsWith("#/performans")) viewPerformance(root);
  else if (hash.startsWith("#/gecmis/")) {
    let id = "";
    try { id = decodeURIComponent(hash.slice(9)); } catch { /* bozuk adres */ }
    viewHistoryDetail(root, id);
  }
  else if (hash.startsWith("#/gecmis")) viewHistory(root);
  else viewCoupons(root);
  const nb = noticesBar();
  if (nb) root.prepend(nb);
  window.scrollTo(0, 0);
}
/* Kullanıcıya duyurular (ör. harman canlıda piyasadan kötü çıkınca piyasaya dönüldü); son 30 gün. */
function noticesBar() {
  const recent = (DATA.notices || []).filter((n) => Date.now() - new Date(n.at).getTime() < 30 * 86400 * 1000);
  if (!recent.length) return null;
  return h("div", { class: "notices", role: "status" }, recent.map((n) =>
    h("p", { class: "odds-warn" }, h("b", {}, "Duyuru: "), n.text, h("small", { class: "muted" }, `  (${fmtDate(n.at)})`))));
}
/* Harman ve piyasa canlıda ayrı ayrı (§26-5): aynı maçlarda Brier; 200 maçta harman kötüyse site piyasaya döner. */
function blendLiveBlock() {
  const b = DATA.blend;
  if (!b) return [];
  const l = b.live;
  const out = [h("h2", {}, "Canlı: harman ve piyasa")];
  if (!l || !l.n) {
    out.push(h("p", { class: "small muted" }, b.use_on_site
      ? `Sitede harman gösteriliyor. Maçlar sonuçlandıkça harman ve piyasa burada ayrı ayrı ölçülecek; ${l ? l.min_n : 200} maçtan sonra harman piyasadan kötüyse site kendiliğinden piyasaya döner.`
      : "Sitede piyasa olasılığı gösteriliyor."));
    return out;
  }
  const better = l.blend_brier < l.market_brier;
  out.push(h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, `Maç sonucu (1X2), ${l.n} maç`), h("th", { class: "num" }, "Brier"))),
      h("tbody", {},
        h("tr", {}, h("td", {}, "Piyasa"), h("td", { class: better ? "num" : "num good" }, h("b", {}, brier(l.market_brier)))),
        h("tr", {}, h("td", {}, "Harman"), h("td", { class: better ? "num good" : "num" }, h("b", {}, brier(l.blend_brier))))))),
    h("p", { class: "small muted" }, l.n < l.min_n
      ? `Karar için ${l.min_n} maç gerekiyor (şu an ${l.n}); o zamana kadar fark şansa çok bağlı.`
      : (b.use_on_site ? "Harman canlıda piyasadan kötü değil; sitede harman gösterilmeye devam ediyor."
        : "Sitede piyasa olasılığı gösteriliyor.")));
  return out;
}

async function init() {
  saveKupon();
  try {
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    DATA = await res.json();
    showNetBanner(res.headers.get("X-Macanaliz-Cache")); // service worker önbellekten verdiyse: "offline" | "slow"
  } catch {
    document.getElementById("updated").textContent = "";
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
