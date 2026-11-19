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
const days = () => (DATA ? DATA[state.sport] : []);
const matchLabel = (m) => `${m.home} – ${m.away}`;

const STALE_MS = 12 * 3600 * 1000;
function updateHeader() {
  const el = document.getElementById("updated");
  if (!DATA) return;
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
  return { key: o.key, matchId: m.id, pick: o.pick, match: matchLabel(m), competition: m.competition,
    kickoff: m.kickoff, price: o.price, prob: o.prob };
}
function toggleOption(m, o) {
  if (inKupon(o.key)) {
    state.kupon = state.kupon.filter((l) => l.key !== o.key);
    toast("Kupondan çıkarıldı");
  } else {
    state.kupon.push(legFrom(m, o));
    toast(started(m) ? "Kupona eklendi — uyarı: maç başladı" : "Kupona eklendi");
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
function sportSwitch(onChange) {
  const b = (sport, label) => h("button", { type: "button", "aria-pressed": state.sport === sport,
    onclick: () => { state.sport = sport; state.day = 0; updateHeader(); onChange(); } }, label);
  return h("div", { class: "seg", role: "group", "aria-label": "Spor" }, b("football", "Futbol"), b("basketball", "NBA"));
}
function dayChips(onChange) {
  return h("div", { class: "chips", role: "group", "aria-label": "Gün" },
    days().map((d, i) => h("button", { type: "button", class: "chip", "aria-pressed": state.day === i,
      onclick: () => { state.day = i; onChange(); } }, d.label, h("span", { class: "n" }, d.matches.length))));
}
function note() {
  return h("p", { class: "note" }, "Oranlar uluslararası bahis şirketlerinden; iddaa oranları farklı olabilir. ",
    "Olasılıklar oranlardan hesaplanır, hiçbir kupon garanti değildir.",
    DATA ? ` Site yayını: ${fmtDateTime(DATA.generated_at)}.` : "");
}

/* ---------- görünüm: kuponlar ---------- */
function viewCoupons(root) {
  const render = () => viewCoupons(root);
  const day = days()[state.day];
  root.replaceChildren(
    h("h1", {}, "Günün kuponları"),
    sportSwitch(render), dayChips(render),
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
        h("span", { class: "leg-meta" }, `${fmtTime(ref.match.kickoff)}  ${matchLabel(ref.match)}`),
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
  const get = (o) => m.options.find((x) => x.market === "h2h" && x.outcome === o && x.price);
  return ["home", "draw", "away"].map(get).filter(Boolean);
}
function viewMatches(root) {
  const render = () => viewMatches(root);
  const day = days()[state.day];
  const kids = [h("h1", {}, "Maçlar"), sportSwitch(render), dayChips(render)];
  if (!day || !day.matches.length) {
    kids.push(h("p", { class: "empty" }, "Bu gün için maç yok."));
  } else {
    let comp = null;
    for (const m of day.matches) {
      if (m.competition !== comp) { comp = m.competition; kids.push(h("p", { class: "comp" }, comp)); }
      const short = { home: "1", draw: "X", away: "2" };
      kids.push(h("a", { class: "match", href: `#/mac/${encodeURIComponent(m.id)}` },
        h("span", { class: "time" }, fmtTime(m.kickoff)),
        h("span", { class: "teams" }, h("span", {}, m.home), h("span", {}, m.away),
          started(m) ? h("span", { class: "started" }, "Başladı") : null),
        h("span", { class: "mini" }, headline(m).map((o) =>
          h("div", {}, h("b", {}, odds(o.price)), h("small", {}, `${short[o.outcome]} ${pct(o.prob)}`))))));
    }
  }
  kids.push(note());
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
    h("h1", {}, matchLabel(m)),
    h("p", { class: "muted small" }, `${m.competition}  ${fmtDateTime(m.kickoff)}`, started(m) ? "  (başladı)" : ""),
  ];
  const e = m.expected;
  kids.push(m.sport === "football"
    ? h("div", { class: "expected" }, h("div", {}, h("span", { class: "small muted" }, `${m.home} beklenen gol`), h("b", {}, e.home.toFixed(2))),
        h("div", {}, h("span", { class: "small muted" }, `${m.away} beklenen gol`), h("b", {}, e.away.toFixed(2))))
    : h("div", { class: "expected" }, h("div", {}, h("span", { class: "small muted" }, `${m.home} beklenen fark`), h("b", {}, (e.margin > 0 ? "+" : "") + e.margin.toFixed(1))),
        e.total != null ? h("div", {}, h("span", { class: "small muted" }, "Beklenen toplam"), h("b", {}, e.total.toFixed(1))) : null));

  kids.push(h("p", { class: "small muted" }, "Seçeneğe dokununca kupona eklenir; tekrar dokununca çıkar. ",
    "Piyasa: oranlardan bahis şirketi payı ayıklanmış olasılık. Model: oranlara bakmadan geçmiş maçlardan (gol ve xG) ",
    "kurduğumuz model; Süper Lig, 5 büyük lig ve Avrupa kupalarında, diğerlerinde –."));
  for (const [market, title] of Object.entries(GROUPS)) {
    const opts = m.options.filter((o) => o.market === market);
    if (!opts.length) continue;
    kids.push(h("h2", {}, title));
    kids.push(h("div", { class: "options" }, opts.map((o) =>
      h("button", { type: "button", class: "opt", disabled: !o.addable, "aria-pressed": inKupon(o.key),
        title: o.price && !o.addable ? "Çeyrek çizgi: yarım kazanç/iade kuralı nedeniyle kupona eklenemez" : null,
        onclick: () => { toggleOption(m, o); render(); } },
        h("span", { class: "p" }, h("span", {}, o.pick),
          h("span", { class: "prob" }, `Piyasa ${pct(o.market_prob ?? o.prob)} adil ${odds(o.fair)}`),
          h("span", { class: "prob model" }, `Model ${pct(o.model_prob)}`)),
        h("span", { class: "odds" }, o.price ? odds(o.price) : "–")))));
  }
  if (m.info) kids.push(...infoBlock(m));
  kids.push(note());
  root.replaceChildren(...kids);
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
        h("span", { class: "leg-meta" }, `${fmtTime(l.kickoff)}  ${l.match}`), h("span", { class: "prob" }, `Olasılık ${pct(l.prob)}`)),
      h("input", { type: "text", inputmode: "decimal", autocomplete: "off", value: odds(l.price), "aria-label": `${l.pick} oranı`,
        onchange: (ev) => {
          const v = parseNum(ev.target.value);
          if (v > 1) { l.price = Math.round(v * 100) / 100; saveKupon(); } else toast("Oran 1'den büyük olmalı");
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
  const lines = ["Kuponum (Maç Analiz)", ...legs.map((l) => `• ${l.pick} — ${l.match} @${odds(l.price)}`),
    `Toplam oran: ${odds(total)}  Tutma ihtimali: ${pct(totalProb)}`];
  return `https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`;
}

/* ---------- görünüm: performans ---------- */
const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
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
    kids.push(h("p", { class: "empty" }, "Henüz sonuçlanmış maç yok. Maçlar bittikçe burada görünecek."), note());
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
  kids.push(note());
  root.replaceChildren(...kids);
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
  for (const sport of ["football", "basketball"]) {
    for (const d of DATA[sport]) for (const m of d.matches) byId.set(m.id, { match: m, sport });
  }
  updateHeader();
  window.addEventListener("hashchange", route);
  route();
}
init();
