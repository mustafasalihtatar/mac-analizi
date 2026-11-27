/* Maç Analiz — "Önce karar" (§40): TAHMİN başlığı, KARAR bandı, en iyi seçenekler, günün özeti. DOM'a dokunmaz; app.js ve
   testler (tests/js/decide_test.html) kullanır. Değer (BD) = sitede gösterilen olasılık × iddaa oranı − 1. Türetilmiş KG,
   diğer liglerin doğrulanmamış modeli ve NBA'in piyasasız (unverified) çizgileri karara ve değer sıralamasına girmez. */
"use strict";

const Decide = (() => {
  const PLAY = 0.02;   // ≥ +%2 → "Oynanabilir"
  const CLOSE = -0.10; // −%10 … +%2 (kullanıcı kararı 2026-11-27) → "Yakın ama eksi"; altı "iddaa'da oynama"
  const EPS = 1e-9;
  const BAND_TEXT = { play: "oynanabilir", close: "yakın ama eksi", skip: "oynama", none: "oranı yok" };

  const isDerived = (o) => o.market === "btts" && o.market_src === "derived";
  const bandOf = (ev) => (ev >= PLAY - EPS ? "play" : ev >= CLOSE - EPS ? "close" : "skip");
  /* Değerin sıfırlandığı oran (1 ÷ olasılık), iki ondalık, yukarı yuvarlanır: 1/0,32 = 3,125 → 3,13. */
  const breakEven = (p) => (p > 0 ? Math.ceil(Math.round(10000 / p) / 100 - EPS) / 100 : null);
  const dec = (x, d) => Number(x).toFixed(d).replace(".", ",");

  /* Şu an canlı (oynanan ya da devre arası) maç sayısı. liveOf(id) → live.js durumu | null. */
  function liveCount(matches, liveOf) {
    return (matches || []).filter((m) => { const v = liveOf(m.id); return !!v && (v.state === "live" || v.state === "ht"); }).length;
  }
  const isLive = (v) => !!v && (v.state === "live" || v.state === "ht");

  /* TAHMİN başlığı. probs: futbol [1, X, 2], NBA [ev, dep] (sitede gösterilen). Kurallar sırayla, ilk uyan:
     NBA → favori kazanır; en yüksek ≥ %50 → kazanır; üçü 6 puan içinde → dengeli; ev+X ≥ %65 ve ev > dep → ev kaybetmez
     (dep için tersi); hiçbiri → en olası taraf biraz önde. Karşılaştırmalar ekranda görünen tam yüzdelerle. */
  function headline({ sport, home, away, probs, expected }) {
    if (!probs || !probs.length) return null;
    const p = probs.map((x) => Math.round(x * 100));
    if (sport === "basketball") {
      const fav = p[0] >= p[1] ? home : away;
      const e = expected || {};
      const parts = [];
      if (e.margin != null) parts.push(`Beklenen fark ${e.margin > 0 ? "+" : e.margin < 0 ? "−" : "±"}${dec(Math.abs(e.margin), 1)}`);
      if (e.total != null) parts.push(`toplam ${dec(e.total, 1)}`);
      return { kind: "win", title: `${fav} kazanır`, sub: parts.length ? parts.join(" · ") : `${fav} %${Math.max(p[0], p[1])} ile favori` };
    }
    const [h, d, a] = p;
    const max = Math.max(h, d, a), min = Math.min(h, d, a);
    const top = h === max ? "home" : a === max ? "away" : "draw";
    const name = { home, away, draw: "Beraberlik" }[top];
    if (max >= 50) {
      return top === "draw" ? { kind: "win", title: "Beraberlik önde", sub: `Beraberlik %${d}` }
        : { kind: "win", title: `${name} kazanır`, sub: `${name} %${max} ile favori` };
    }
    if (max - min <= 6) return { kind: "even", title: "Dengeli maç", sub: "Taraflar eşit, beraberlik olasılığı yüksek" };
    if (h + d >= 65 && h > a) return { kind: "nolose", title: `${home} kaybetmez`, sub: `Kaybetmeme olasılığı %${h + d}` };
    if (a + d >= 65 && a > h) return { kind: "nolose", title: `${away} kaybetmez`, sub: `Kaybetmeme olasılığı %${a + d}` };
    return { kind: "lean", title: `${name} biraz önde`, sub: "Üç sonuç da açık" };
  }

  /* Maçın seçenekleri, iddaa oranı ve değeriyle. ctx: {price(matchId, key) → iddaa oranı|null, options(m) → seçenekler,
     minor(m) → bool}. counts: değer hesabına girer mi (türetilmiş KG / doğrulanmamış değil). */
  function rated(m, ctx) {
    const minor = !!(ctx.minor && ctx.minor(m));
    return (ctx.options(m) || []).filter((o) => o.prob > 0).map((o) => {
      const price = ctx.price(m.id, o.key);
      const counts = !minor && !o.unverified && !isDerived(o);
      const ev = price != null && counts ? o.prob * price - 1 : null;
      return { option: o, prob: o.prob, price: price ?? null, ev, counts, src: price != null ? "iddaa" : null };
    });
  }

  /* KARAR: iddaa oranı olan (değer hesabına giren) seçenekler arasında en yüksek değerli. Eşitlikte yüksek olasılık.
     band: play | close | skip | none (hiç iddaa oranı yok) | started (başlamış/bitmiş) | minor (doğrulanmamış model). */
  function verdict(m, ctx) {
    if (m.score != null || ctx.started(m)) return { band: "started" };
    if (ctx.minor && ctx.minor(m)) return { band: "minor" };
    const c = rated(m, ctx).filter((r) => r.ev != null);
    if (!c.length) return { band: "none" };
    c.sort((x, y) => y.ev - x.ev || y.prob - x.prob);
    const b = c[0];
    return { band: bandOf(b.ev), option: b.option, prob: b.prob, price: b.price, ev: b.ev, required: 1 / b.price,
      breakEven: breakEven(b.prob) };
  }
  /* Listedeki karar noktası: verdict bandı; başlamış, bitmiş ve diğer lig maçında nokta yok (null). */
  function matchBand(m, ctx) {
    const b = verdict(m, ctx).band;
    return b === "started" || b === "minor" ? null : b;
  }

  /* En iyi n seçenek (bütün pazarlar). sort: "value" (değeri olanlar değere göre önce, sonra olasılık), "prob", "odds"
     (iddaa, yoksa yurtdışı). */
  function bestOptions(m, ctx, sort, n) {
    const rows = rated(m, ctx);
    const odds = (r) => r.price ?? r.option.price ?? 0;
    const cmp = sort === "prob" ? (x, y) => y.prob - x.prob
      : sort === "odds" ? (x, y) => odds(y) - odds(x) || y.prob - x.prob
        : (x, y) => (x.ev == null) - (y.ev == null) || (x.ev != null ? y.ev - x.ev : 0) || y.prob - x.prob;
    return rows.sort(cmp).slice(0, n == null ? 3 : n);
  }

  /* Günün özeti. rows: options.js satırları (seçili gün + spor; başlamamış). Sadece iddaa'dan (otomatik ya da elle) oranı
     olan ve değer hesabına giren satırlar sayılır. state: value (artı değerli var) | none (yok; nearest en yakın) | nodata. */
  function daySummary(rows) {
    const c = (rows || []).filter((r) => r.src !== "yurtdışı" && !r.derived && !r.unverified && r.ev != null)
      .sort((x, y) => y.ev - x.ev || y.prob - x.prob);
    if (!c.length) return { state: "nodata", count: 0, top: [], nearest: null };
    const good = c.filter((r) => r.ev >= PLAY - EPS);
    if (good.length) return { state: "value", count: good.length, top: good.slice(0, 2), nearest: null };
    return { state: "none", count: 0, top: [], nearest: { ...c[0], breakEven: breakEven(c[0].prob) } };
  }

  return { PLAY, CLOSE, BAND_TEXT, breakEven, bandOf, liveCount, isLive, headline, verdict, matchBand, bestOptions, daySummary };
})();

if (typeof module !== "undefined") module.exports = Decide;
