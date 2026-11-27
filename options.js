/* Maç Analiz — Değerli > "Tüm seçenekler" (§36): modelin olasılık verdiği her seçenek, iddaa (yoksa yurtdışı) oranıyla.
   DOM'a dokunmaz; app.js ve testler (tests/js/options_test.html) kullanır. iddaa oranları sadece bu cihazdaki kayıttan
   (iddaa.js) gelir; burada ağ isteği yok. */
"use strict";

const Options = (() => {
  /* Bizim pazar → filtre grubu. Bu tablo dışındaki pazarlar listeye girmez. */
  const GROUPS = { h2h: "result", double_chance: "double", totals: "totals", btts: "btts", handicap3: "handicap", spreads: "handicap" };

  /* Maçlardan satırlar. ctx: {now, dayOf(m) → 0|1|2|null, extra(m) → [ek seçenek], price(m, o) → iddaa oranı|null,
     source(m, o) → "elle"|"iddaa"|null, status(m, o) → "ok"|"closed"|"absent"|"unknown"}.
     Başlamış, biten (skoru olan) ve gösterilen 3 günün dışındaki maçlar girmez. Oran: iddaa, yoksa yurtdışı; ikisi de
     yoksa (ya da diğer liglerde iddaa oranı yoksa) satır yok. Doğrulanmamış olasılık (diğer ligler, NBA ek çizgileri) → bant
     "model" (renk yok). */
  function collect(matches, ctx) {
    const now = ctx.now || new Date();
    const rows = [];
    for (const m of matches || []) {
      if (!m || m.score != null || new Date(m.kickoff) <= now) continue;
      const day = ctx.dayOf(m);
      if (day == null) continue;
      const minor = m.sport === "minor";
      for (const o of (m.options || []).concat(ctx.extra(m) || [])) {
        const group = GROUPS[o.market];
        if (!group || !(o.prob > 0)) continue;
        const iddaa = ctx.price(m, o);
        const price = iddaa ?? (minor ? null : o.price ?? null);
        if (price == null) continue;
        const unverified = minor || !!o.unverified;
        // §39 türetilmiş KG (gerçek KG oranı yok): satır görünür ama değer hesabına girmez (BD, gereken farkı, bant yok)
        const derived = o.market === "btts" && o.market_src === "derived";
        const required = Iddaa.required(price);
        const ev = derived ? null : Iddaa.expectedValue(o.prob, price);
        const band = derived ? null : Iddaa.evBand(ev);
        rows.push({ key: o.key, match: m.id, sport: m.sport === "basketball" ? "basketball" : "football", minor,
          competition: m.competition, kickoff: m.kickoff, day, home: m.home, away: m.away, pick: o.pick, market: o.market,
          group, line: o.line ?? null, prob: o.prob, price, src: iddaa != null ? ctx.source(m, o) || "iddaa" : "yurtdışı",
          required, gap: required == null || derived ? null : o.prob - required, ev, band: band && unverified ? "model" : band,
          unverified, derived, status: ctx.status(m, o), addable: !!o.addable || minor, option: o });
      }
    }
    return rows;
  }

  /* ---------- filtreler ---------- */
  const STORE = "macanaliz.filtre.v1";
  const VERSION = 1;
  const MIN_ODDS_PRESETS = [1.4, 1.5, 1.8, 2.0];
  /* Sıralama anahtarı → varsayılan yön (masaüstü tablo başlıkları dahil). */
  const SORTS = { value: "desc", odds: "desc", time: "asc", gap: "desc", match: "asc", pick: "asc", required: "asc", prob: "desc" };
  const FIELD = { value: "ev", odds: "price", time: "kickoff", gap: "gap", match: "home", pick: "pick", required: "required", prob: "prob" };
  const SPORTS = ["all", "football", "basketball"];
  const DAYS = ["all", 0, 1, 2];
  const MARKETS = ["all", ...new Set(Object.values(GROUPS))];

  const defaults = () => ({ minOdds: null, onlyValue: false, market: "all", sport: "all", league: "all", day: "all",
    showClosed: false, sort: { by: "value", dir: "desc" } });

  /* Metin → filtreler. Hiç fırlatmaz: bozuk metin ya da başka sürüm → varsayılanlar; geçersiz alan → o alanın varsayılanı. */
  function parseFilters(text) {
    const d = defaults();
    let o;
    try { o = JSON.parse(text); } catch { return d; }
    if (!o || typeof o !== "object" || Array.isArray(o) || o.version !== VERSION) return d;
    const f = { ...d };
    if (typeof o.minOdds === "number") f.minOdds = Iddaa.parseOdds(o.minOdds);
    if (typeof o.onlyValue === "boolean") f.onlyValue = o.onlyValue;
    if (typeof o.showClosed === "boolean") f.showClosed = o.showClosed;
    if (MARKETS.includes(o.market)) f.market = o.market;
    if (SPORTS.includes(o.sport)) f.sport = o.sport;
    if (DAYS.includes(o.day)) f.day = o.day;
    if (typeof o.league === "string" && o.league.trim()) f.league = o.league;
    if (o.sort && typeof o.sort === "object" && o.sort.by in SORTS) {
      f.sort = { by: o.sort.by, dir: ["asc", "desc"].includes(o.sort.dir) ? o.sort.dir : SORTS[o.sort.by] };
    }
    return f;
  }
  const serializeFilters = (f) => JSON.stringify({ version: VERSION, ...f });

  /* Varsayılandan farklı filtre sayısı (sıralama sayılmaz). */
  function activeCount(f) {
    const d = defaults();
    return Object.keys(d).filter((k) => k !== "sort" && f[k] !== d[k]).length;
  }

  const sportOk = (r, f) => f.sport === "all" || r.sport === f.sport;
  /* Spor filtresine uyan satırlardaki ligler, Türkçe alfabetik, tekrarsız. */
  function leagues(rows, f) {
    return [...new Set(rows.filter((r) => sportOk(r, f) && r.competition).map((r) => r.competition))]
      .sort((a, b) => a.localeCompare(b, "tr"));
  }
  /* Kayıtlı lig artık listede yoksa (hafta değişti) lig filtresi uygulanmaz; kayıt değişmez (kopya döner). */
  function effective(f, rows) {
    return f.league === "all" || leagues(rows, f).includes(f.league) ? { ...f } : { ...f, league: "all" };
  }

  /* Sıralı kopya. null değerler yön ne olursa olsun sonda; eşitlikte saat ↑, sonra anahtar. */
  function sortRows(rows, sort) {
    const s = sort && sort.by in SORTS ? sort : defaults().sort;
    const field = FIELD[s.by], sign = s.dir === "asc" ? 1 : -1;
    const cmp = (a, b) => (typeof a === "string" ? a.localeCompare(b, "tr") : a - b);
    return rows.slice().sort((a, b) => {
      const x = a[field], y = b[field];
      if ((x == null) !== (y == null)) return x == null ? 1 : -1;
      if (x != null && x !== y) {
        const c = cmp(x, y);
        if (c) return sign * c;
      }
      if (a.kickoff !== b.kickoff) return a.kickoff < b.kickoff ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  }
  /* Aynı başlık → yön ters; başka başlık → o anahtarın varsayılan yönü. */
  const toggleSort = (sort, by) => (sort && sort.by === by ? { by, dir: sort.dir === "asc" ? "desc" : "asc" } : { by, dir: SORTS[by] });

  /* Filtrele + sırala. Kapalı (iddaa'da yok / 1,00) ve bültende olmayan seçenekler showClosed değilse gizli. */
  function apply(rows, f) {
    const out = rows.filter((r) => (f.showClosed || (r.status !== "closed" && r.status !== "absent"))
      && sportOk(r, f)
      && (f.league === "all" || r.competition === f.league)
      && (f.day === "all" || r.day === f.day)
      && (f.market === "all" || r.group === f.market)
      && (f.minOdds == null || r.price >= f.minOdds)
      && (!f.onlyValue || r.band === "value"));
    return sortRows(out, f.sort);
  }

  return { GROUPS, collect, STORE, MIN_ODDS_PRESETS, SORTS, defaults, parseFilters, serializeFilters, activeCount, leagues,
    effective, sortRows, toggleSort, apply };
})();

if (typeof module !== "undefined") module.exports = Options;
