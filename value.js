/* Maç Analiz — "Değerli" sekmesi (§30) hesapları. DOM'a dokunmaz; app.js ve testler (tests/js/) kullanır.
   Liste (eşik, seçim) yayında Python'da kurulur (data.json `value.picks`, eşik `value.threshold`); burada sadece
   bu cihazda girilen iddaa oranları (Iddaa kaydı) satırlara eklenir ve sıralanır. */
"use strict";

const Value = (() => {
  const started = (kickoff, now) => new Date(kickoff) <= now;
  const iddaaGet = (store, matchId, key) => (typeof Iddaa !== "undefined" ? Iddaa.get(store, matchId, key) : null);
  const ev = (p, o) => (typeof Iddaa !== "undefined" ? Iddaa.expectedValue(p, o) : null);

  /* Listedeki satıra iddaa oranı ve beklenen değer (sitede gösterilen olasılıkla, §29 ile aynı). */
  function withIddaa(p, store) {
    const iddaa = iddaaGet(store, p.match, p.key);
    return { ...p, iddaa, ev: iddaa == null ? null : ev(p.prob, iddaa), below: false, minor: false };
  }

  /* Seçenekten satır (listede olmayan ama iddaa oranı girilmiş seçenekler için). */
  function rowFromOption(m, o, store) {
    const minor = m.sport === "minor";
    const iddaa = iddaaGet(store, m.id, o.key);
    const diff = o.model_prob != null && o.market_prob != null ? Math.round((o.model_prob - o.market_prob) * 1e4) / 1e4 : null;
    return { key: o.key, match: m.id, sport: m.sport, competition: m.competition, kickoff: m.kickoff, home: m.home,
      away: m.away, market: o.market, outcome: o.outcome, line: o.line, pick: o.pick, market_prob: o.market_prob ?? null,
      model_prob: o.model_prob ?? (minor ? o.prob : null), blend_prob: o.blend_prob ?? null, prob: o.prob, diff,
      fair: o.model_prob ? Math.round(100 / o.model_prob) / 100 : o.fair, price: o.price ?? null,
      odds_first: null, odds_last: null, odds_seen: 0, iddaa, ev: iddaa == null ? null : ev(o.prob, iddaa),
      below: !minor, minor };
  }

  /* Sıralama: beklenen değeri pozitif olanlar en üstte (büyükten küçüğe), sonra farka göre (büyükten küçüğe). */
  function compare(a, b) {
    const pa = a.ev != null && a.ev > 0, pb = b.ev != null && b.ev > 0;
    if (pa !== pb) return pa ? -1 : 1;
    if (pa && pb && a.ev !== b.ev) return b.ev - a.ev;
    const da = a.diff ?? -Infinity, db = b.diff ?? -Infinity;
    if (da !== db) return db - da;
    return a.kickoff < b.kickoff ? -1 : a.kickoff > b.kickoff ? 1 : (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }

  /* → {rows, minor}. rows: listedekiler + iddaa oranı girilmiş ama eşik altında kalan futbol/NBA seçenekleri
     (below: true); minor: diğer liglerde iddaa oranı girilmiş seçenekler (doğrulanmamış model). Başlamış maçlar
     çıkarılır. matchOf(id) → site maç nesnesi | undefined. */
  function build(picks, store, matchOf, now) {
    const t = now || new Date();
    const rows = (picks || []).filter((p) => !started(p.kickoff, t)).map((p) => withIddaa(p, store));
    const listed = new Set(rows.map((r) => r.key));
    const minor = [];
    for (const [id, rec] of Object.entries((store && store.matches) || {})) {
      const m = matchOf(id);
      if (!m || started(m.kickoff, t)) continue;
      for (const key of Object.keys(rec.odds || {})) {
        if (listed.has(key)) continue;
        const o = (m.options || []).find((x) => x.key === key);
        if (!o || (o.market === "btts" && o.market_src === "derived")) continue; // §39 türetilmiş KG Değerli'ye girmez
        const r = rowFromOption(m, o, store);
        if (r.iddaa == null) continue;
        (r.minor ? minor : rows).push(r);
      }
    }
    rows.sort(compare);
    minor.sort(compare);
    return { rows, minor };
  }

  /* Oran hareketi metni için: ilk → son (ortalama oran), değişim oranı; iki kez görülmediyse null. */
  function move(p) {
    if (!p || !(p.odds_seen >= 2) || !p.odds_first || !p.odds_last) return null;
    // §38 kaynak değişimi hareket sayılmaz: sunucu parça parça hesaplar (odds_change); eski veride düz oran
    if ("odds_change" in p) {
      if (p.odds_change == null) return null;
      return { first: p.odds_first, last: p.odds_last, change: p.odds_change, sourceChanged: !!p.odds_source_changed };
    }
    return { first: p.odds_first, last: p.odds_last, change: p.odds_last / p.odds_first - 1, sourceChanged: false };
  }

  return { build, compare, withIddaa, rowFromOption, move };
})();

if (typeof module !== "undefined") module.exports = Value;
