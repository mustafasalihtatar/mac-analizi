/* Maç Analiz — arkadaş sitesi. Veri: data.json (yerel uygulamadan yayınlanır).
   Tüm metinler textContent ile yazılır; kupon bu cihazın tarayıcısında saklanır. */
"use strict";

const TZ = "Europe/Istanbul";
const STORE = "macanaliz.kupon.v1";
const KINDS = [
  ["safe", "Garanti", "Tutma olasılığı yüksek, oranı düşük."],
  ["risky", "Riskli", "Risk almayan viski içemez."],
  ["slip", "Market fişi", "Çok maçlı, tamamen keyif."],
];
const GROUPS = {
  h2h: "Maç sonucu", double_chance: "Çifte şans", totals: "Alt / üst", btts: "Karşılıklı gol", spreads: "Handikap",
};

let DATA = null;
const state = { sport: "football", day: 0, kupon: loadKupon(), stake: 10 };
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

/* Takım arması (futbol): yoksa ya da yüklenemezse baş harfler. */
const NOISE = /^(fc|sk|cf|ac|as|sc|afc|ssc|fk|sv|tsg|vfb|vfl|rc|bv|\d+)$/i;
function initials(name) {
  const w = String(name).split(/[\s.\-/]+/).filter((x) => x && !NOISE.test(x));
  const s = w.length > 1 ? w[0][0] + w[1][0] : (w[0] || "?").slice(0, 2);
  return s.toUpperCase(); // "Milan" → "MI" (tr-TR kuralı "Mİ" yapardı)
}
function crest(m, side, size) {
  if (m.sport !== "football" && !isMinor(m)) return null;
  const cls = `crest${size ? ` ${size}` : ""}`;
  const fallback = () => h("span", { class: `${cls} ini`, "aria-hidden": "true" }, initials(m[side]));
  const src = m.logos && m.logos[side];
  if (!src) return fallback();
  const img = h("img", { class: cls, src, alt: "", loading: "lazy", decoding: "async",
    onerror: () => img.replaceWith(fallback()) });
  return img;
}

/* 1X2 olasılık çubuğu: ev / beraberlik / deplasman. */
const OUT3 = ["home", "draw", "away"];
function probs3(m, field) {
  const get = (k) => { const o = m.options.find((x) => x.market === "h2h" && x.outcome === k); return o ? o[field] : null; };
  const v = OUT3.map(get);
  return v.every((x) => x != null) ? v : null;
}
function pbar(vals, thin) {
  return h("div", { class: thin ? "pbar thin" : "pbar", "aria-hidden": "true" }, vals.map((p, i) =>
    h("span", { class: `seg-${OUT3[i]}`, style: `flex-grow:${Math.max(p, 0.001)}` }, !thin && p >= 0.12 ? pct(p) : null)));
}

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
function legFrom(m, o) {
  const fair = o.price == null; // oranı çekilmeyen lig: adil oranla girer, kullanıcı iddaa oranını yazar
  return { key: o.key, matchId: m.id, pick: o.pick, match: matchLabel(m), competition: m.competition,
    kickoff: m.kickoff, price: fair ? o.fair : o.price, prob: o.prob, fair };
}
function toggleOption(m, o) {
  if (inKupon(o.key)) {
    state.kupon = state.kupon.filter((l) => l.key !== o.key);
    toast("Kupondan çıkarıldı");
  } else {
    state.kupon.push(legFrom(m, o));
    toast(started(m) ? "Kupona eklendi — uyarı: maç başladı"
      : o.price == null ? "Adil oranla eklendi — iddaa oranını Kuponum'da gir" : "Kupona eklendi");
  }
  saveKupon();
}
function addCoupon(c) {
  let added = 0, late = 0;
  for (const leg of c.legs) {
    const ref = byId.get(leg.match);
    const o = ref && ref.match.options.find((x) => x.key === leg.key);
    if (o && !inKupon(o.key)) {
      state.kupon.push(legFrom(ref.match, o)); added++;
      if (started(ref.match)) late++;
    }
  }
  saveKupon();
  const warn = late ? ` — uyarı: ${late} maç başladı` : "";
  toast(added ? `${added} seçim kupona eklendi${warn}` : "Bu seçimler zaten kuponda");
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
    h("button", { type: "button", class: "btn block", onclick: () => addCoupon(c) }, "Kupona ekle"));
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
    m.sport !== "basketball" ? h("div", { class: "vs" }, crest(m, "home", "lg"), h("span", { class: "vs-x" }, "–"),
      crest(m, "away", "lg")) : null,
    h("h1", {}, matchLabel(m)),
    h("p", { class: "muted small" }, `${m.competition}  ${fmtDateTime(m.kickoff)}`, started(m) ? "  (başladı)" : ""),
  ];
  const warn = !isMinor(m) && oddsWarning();
  if (warn) kids.push(warn);
  const e = m.expected;
  kids.push(m.sport !== "basketball"
    ? h("div", { class: "expected" }, h("div", {}, h("span", { class: "small muted" }, `${m.home} beklenen gol`), h("b", {}, e.home.toFixed(2))),
        h("div", {}, h("span", { class: "small muted" }, `${m.away} beklenen gol`), h("b", {}, e.away.toFixed(2))))
    : h("div", { class: "expected" }, h("div", {}, h("span", { class: "small muted" }, `${m.home} beklenen fark`), h("b", {}, (e.margin > 0 ? "+" : "") + e.margin.toFixed(1))),
        e.total != null ? h("div", {}, h("span", { class: "small muted" }, "Beklenen toplam"), h("b", {}, e.total.toFixed(1))) : null));

  const minor = isMinor(m);
  const pm = minor ? null : probs3(m, "market_prob"), pmod = probs3(m, minor ? "prob" : "model_prob");
  const pbl = minor ? null : probs3(m, "blend_prob");
  if (pm || pmod) {
    const names = [m.home, "Beraberlik", m.away];
    kids.push(h("div", { class: "pbars" },
      pm ? h("div", { class: "pbar-row" }, h("span", { class: "lbl" }, "Piyasa"), pbar(pm)) : null,
      pmod ? h("div", { class: "pbar-row" }, h("span", { class: "lbl" }, "Model"), pbar(pmod)) : null,
      pbl ? h("div", { class: "pbar-row" }, h("span", { class: "lbl" }, "Harman"), pbar(pbl)) : null,
      h("div", { class: "pbar-legend" }, names.map((n, i) =>
        h("span", {}, h("i", { class: `dot seg-${OUT3[i]}` }), n)))));
  }
  if (minor) kids.push(minorNote(), h("p", { class: "small muted" },
    "Seçeneğe dokununca adil oranla kupona eklenir; Kuponum'da iddaa oranını yazabilirsin."));
  else kids.push(h("p", { class: "small muted" }, "Seçeneğe dokununca kupona eklenir; tekrar dokununca çıkar. ",
    "Piyasa: oranlardan bahis şirketi payı ayıklanmış olasılık. Model: oranlara bakmadan geçmiş maçlardan (gol ve xG) ",
    "kurduğumuz model; Süper Lig, 5 büyük lig ve Avrupa kupalarında, diğerlerinde –. ",
    `Model piyasadan ${Math.round(EDGE * 100)}+ puan ayrılınca işaretlenir (yeşil: model daha yüksek görüyor). `,
    "Geçmiş testte piyasa daha isabetli çıktı; fark bir fikir verir, kesin değer değildir. ",
    pbl ? blendNote() : "",
    "Model gol sayısını genelde piyasadan az bekliyor; alt/üst farklarına bu gözle bakın."));
  for (const [market, title] of Object.entries(GROUPS)) {
    const opts = m.options.filter((o) => o.market === market);
    if (!opts.length) continue;
    kids.push(h("h2", {}, title));
    kids.push(h("div", { class: "options" }, opts.map((o) => {
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
          h("span", { class: "prob" }, DATA.blend && DATA.blend.use_on_site && o.market_prob != null && Math.abs(o.prob - o.market_prob) > 0.0005
            ? `Harman ${pct(o.prob)} adil ${odds(o.fair)} (piyasa ${pct(o.market_prob)})`
            : `Piyasa ${pct(o.market_prob ?? o.prob)} adil ${odds(o.fair)}`),
          h("span", { class: "prob model" }, `Model ${pct(o.model_prob)}`,
            flag ? h("span", { class: d > 0 ? "diff up" : "diff down" }, pts(d)) : null)),
        h("span", { class: "odds" }, o.price ? odds(o.price) : "–"));
    })));
  }
  kids.push(...statsBlock(m));
  kids.push(...injuryBlock(m));
  if (m.info) kids.push(...infoBlock(m));
  kids.push(note(minor));
  root.replaceChildren(...kids);
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
  const kids = [h("h1", {}, "Kuponum")];
  if (!legs.length) {
    kids.push(h("p", { class: "empty" }, "Kuponun boş. Kuponlar ya da Maçlar bölümünden seçim ekle."));
    root.replaceChildren(...kids, note());
    return;
  }
  const total = legs.reduce((a, l) => a * (Number(l.price) || 1), 1);
  const probs = legs.map((l) => l.prob);
  const totalProb = probs.every((p) => p != null) ? probs.reduce((a, p) => a * p, 1) : null;
  const counts = {};
  legs.forEach((l) => { counts[l.matchId] = (counts[l.matchId] || 0) + 1; });
  const dup = [...new Set(legs.filter((l) => counts[l.matchId] > 1).map((l) => l.match))];
  const late = [...new Set(legs.filter((l) => new Date(l.kickoff) <= new Date()).map((l) => l.match))];

  const card = h("div", { class: "card" },
    legs.map((l) => h("div", { class: "kleg" },
      h("div", { class: "leg-text" }, h("span", { class: "leg-pick" }, l.pick),
        h("span", { class: "leg-meta" }, `${fmtTime(l.kickoff)}  ${l.match}`), h("span", { class: "prob" }, `Olasılık ${pct(l.prob)}`),
        l.fair ? h("span", { class: "warn" }, "Adil oran — iddaa oranını yaz") : null),
      h("input", { type: "text", inputmode: "decimal", autocomplete: "off", value: odds(l.price), "aria-label": `${l.pick} oranı`,
        onchange: (ev) => {
          const v = parseNum(ev.target.value);
          if (v > 1) { l.price = Math.round(v * 100) / 100; l.fair = false; saveKupon(); } else toast("Oran 1'den büyük olmalı");
          render();
        } }),
      h("button", { type: "button", class: "icon", "aria-label": `${l.pick} seçimini çıkar`,
        onclick: () => { state.kupon = state.kupon.filter((x) => x.key !== l.key); saveKupon(); render(); } }, "×"))),
    h("div", { class: "total" },
      h("div", {}, h("span", { class: "small muted" }, "Toplam oran"), h("span", { class: "big" }, odds(total))),
      h("div", { class: "r" }, h("span", { class: "small muted" }, "Tutma ihtimali"), h("span", { class: "mid" }, pct(totalProb)))),
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
    h("p", { class: "small muted" }, "Oranları iddaa'da gördüğün değerlerle değiştirebilirsin. Tutma ihtimali maçların bağımsız olduğu varsayımıyla hesaplanır."),
    h("div", { class: "actions" },
      h("a", { class: "btn primary", href: shareLink(legs, total, totalProb), target: "_blank", rel: "noopener" }, "WhatsApp'ta paylaş"),
      h("button", { type: "button", class: "btn", onclick: () => { state.kupon = []; saveKupon(); render(); } }, "Kuponu temizle")));
  root.replaceChildren(...kids, card, note());
}
function shareLink(legs, total, totalProb) {
  const lines = ["Kuponum (Maç Analiz)", ...legs.map((l) => `• ${l.pick} — ${l.match} @${odds(l.price)}${l.fair ? " (adil)" : ""}`),
    `Toplam oran: ${odds(total)}  Tutma ihtimali: ${pct(totalProb)}`];
  return `https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`;
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
      ...backtestBlock(), ...minorBlock(), note());
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
  kids.push(...backtestBlock(), ...minorBlock(), note());
  root.replaceChildren(...kids);
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
    : hash.startsWith("#/performans") ? "performans" : "kuponlar";
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
  else viewCoupons(root);
  window.scrollTo(0, 0);
}

async function init() {
  saveKupon();
  try {
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    DATA = await res.json();
  } catch {
    document.getElementById("updated").textContent = "";
    document.getElementById("view").replaceChildren(h("p", { class: "empty" }, "Veri yüklenemedi; sayfayı yenileyin."));
    return;
  }
  for (const sport of ["football", "basketball", "minor"]) {
    for (const d of DATA[sport] || []) for (const m of d.matches) byId.set(m.id, { match: m, sport });
  }
  state.day = firstDay();
  updateHeader();
  window.addEventListener("hashchange", route);
  route();
}
init();
