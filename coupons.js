/* Maç Analiz — önerilen kuponları iddaa oranlarına göre yeniden kurma (§35). DOM'a dokunmaz; app.js ve testler (tests/js/)
   kullanır. Kurallar sunucudaki coupons/builder.py ile aynı (variant 0); aday havuzu data.json'daki `pool` (seçim, olasılık,
   yurtdışı oran), iddaa oranı tarayıcıdaki kayıttan gelir. */
"use strict";

const Coupons = (() => {
  const FRESH_MS = 6 * 3600 * 1000; // son başarılı iddaa çekimi bundan eskiyse oranlar "yok" sayılır

  /* Bültenin kapsadığı gün mü: günün başı bültenin en geç maçından sonra değilse. coverTo yoksa (eski durum kaydı) kapsıyor. */
  function dayCovered(dayStartMs, coverToMs) {
    if (!Number.isFinite(coverToMs)) return true;
    return dayStartMs <= coverToMs;
  }

  /* Tek seçimin iddaa durumu: "ok" (oranı var), "closed" (maç bültende, bu seçenek yok ya da 1,00), "absent" (maç bültende
     yok), "unknown" (iddaa verisi yok ya da bülten bu maçın saatine henüz gelmedi). */
  function legStatus(ctx, matchId, key, kickoffMs) {
    if (!ctx || !ctx.fetched) return "unknown";
    if (ctx.price(matchId, key) != null) return "ok";
    if (Number.isFinite(ctx.coverTo) && kickoffMs > ctx.coverTo) return "unknown";
    return ctx.inBulletin(matchId) ? "closed" : "absent";
  }

  /* Maç başına en iyi seçim (eşitlikte havuzda önce gelen, sunucudaki _best_per_match gibi). */
  function bestPerMatch(list, key) {
    const best = new Map();
    for (const e of list) {
      const b = best.get(e.match);
      if (!b || key(e) > key(b)) best.set(e.match, e);
    }
    return [...best.values()];
  }
  const byKeyDesc = (key) => (a, b) => key(b) - key(a) || a.idx - b.idx;
  const byKickoff = (a, b) => a.kickoff - b.kickoff || a.idx - b.idx;

  /* Kurallar (limits: data.json coupon_limits[kind]) havuza uygulanır. Kural en az maç sayısına ulaşmasa da elde ne varsa
     döner (sitede "daha az maçla" gösterilir). */
  function pick(kind, entries, limits) {
    if (kind === "safe") {
      const pool = bestPerMatch(entries.filter((e) => e.prob >= limits.min_prob), (e) => e.prob);
      return pool.sort(byKeyDesc((e) => e.prob)).slice(0, limits.max);
    }
    if (kind === "risky") {
      const score = (e) => e.prob * e.price;
      const [lo, hi] = limits.target;
      const pool = bestPerMatch(entries.filter((e) => e.prob >= limits.min_prob), score).sort(byKeyDesc(score));
      const out = [];
      let total = 1;
      for (const e of pool) {
        if (total * e.price > hi) continue;
        out.push(e);
        total *= e.price;
        if (out.length >= limits.max || (out.length >= limits.min && total >= lo)) break;
      }
      return out;
    }
    if (kind === "slip") {
      const pool = bestPerMatch(entries.filter((e) => e.price >= limits.min_price && e.prob >= (limits.min_prob || 0)), (e) => e.prob);
      return pool.sort(byKickoff).slice(0, limits.max).sort(byKickoff);
    }
    return [];
  }

  /* Kuponun gösterilecek hali.
     ctx: {fetched, coverTo (ms|NaN), dayStart (ms), price(maç, anahtar) → iddaa oranı|null, source(maç, anahtar) → "iddaa"|"elle"|null,
           inBulletin(maç), kickoff(maç) → ms, started(maç), option(maç, anahtar) → {prob, price}|null (havuz yoksa)}
     Dönüş: {mode: "none" (iddaa verisi yok) | "notyet" (bülten bu günü açmadı) | "iddaa", legs: [{match, key, prob, price, src}],
             total_odds, total_prob, replaced (yeni giren seçim), closed (önerideki iddaa'da kapalı/olmayan seçim),
             unmatched (havuzda bültende bulunamayan maç), short (kuralın en az sayısından az)} */
  function build(kind, coupon, limits, ctx) {
    const lim = limits || {};
    const srcLegs = (coupon.legs || []).map((l) => {
      const p = (coupon.pool || []).find((x) => x.key === l.key) || (ctx.option && ctx.option(l.match, l.key));
      return p ? { match: l.match, key: l.key, prob: p.prob, price: p.price } : null;
    }).filter(Boolean);
    const asIs = (mode) => ({ mode, legs: srcLegs.map((l) => ({ ...l, src: "yurtdışı" })),
      total_odds: coupon.total_odds, total_prob: coupon.total_prob, replaced: 0, closed: 0, unmatched: 0, short: false });
    if (!ctx || !ctx.fetched) return asIs("none");
    if (!dayCovered(ctx.dayStart, ctx.coverTo)) return asIs("notyet");

    const pool = coupon.pool && coupon.pool.length ? coupon.pool : srcLegs;
    const entries = [];
    const unmatched = new Set();
    pool.forEach((p, idx) => {
      if (ctx.started(p.match)) return; // başlamış maç iddaa'da oynanamaz
      const price = ctx.price(p.match, p.key), kickoff = ctx.kickoff(p.match);
      if (price == null) {
        // bülten bu maçın saatine gelmedi (günün son maçları): yurtdışı oranla kalır
        if (Number.isFinite(ctx.coverTo) && kickoff > ctx.coverTo) {
          entries.push({ match: p.match, key: p.key, prob: p.prob, price: p.price, src: "yurtdışı", kickoff, idx });
        } else if (!ctx.inBulletin(p.match)) unmatched.add(p.match);
        return;
      }
      entries.push({ match: p.match, key: p.key, prob: p.prob, price, src: ctx.source(p.match, p.key) || "iddaa", kickoff, idx });
    });
    for (const e of entries) unmatched.delete(e.match); // elle oran girilen maç eşleşmemiş sayılmaz
    // bültenin en geç maçı günün başından sonra ama günün maçlarının hiçbiri henüz açılmamış (gece yarısından sonraki tek maç)
    if (entries.length && !unmatched.size && entries.every((e) => e.src === "yurtdışı")) return asIs("notyet");
    const chosen = lim[kind] ? pick(kind, entries, lim[kind]) : [];
    const orig = new Set(srcLegs.map((l) => l.key));
    const legs = chosen.map((e) => ({ match: e.match, key: e.key, prob: e.prob, price: e.price, src: e.src }));
    const closed = srcLegs.filter((l) => ["closed", "absent"].includes(legStatus(ctx, l.match, l.key, ctx.kickoff(l.match)))
      && !ctx.started(l.match)).length;
    return {
      mode: "iddaa", legs,
      total_odds: legs.length ? legs.reduce((a, l) => a * l.price, 1) : null,
      total_prob: legs.length ? legs.reduce((a, l) => a * l.prob, 1) : null,
      replaced: legs.filter((l) => !orig.has(l.key)).length, closed, unmatched: unmatched.size,
      short: !!lim[kind] && legs.length < lim[kind].min,
    };
  }

  /* ---------- §40 Başka öner ve kendi kuponunu oluştur ---------- */
  const PLAY = 0.02; // iddaa değeri bu ve üstü "artı değerli"
  const MAX_LEGS = 6, PER_MATCH = 3, MAX_CANDS = 14, LIMIT = 4;
  const evOf = (e) => e.prob * e.price - 1;

  /* Adaylardan kombinasyonlar: maç başına tek seçim, toplam oran [minOdds, maxOdds] içinde, min..max seçim.
     score "prob": Π olasılık (Düşük risk); "ev": Π(olasılık × oran) − 1, eşitlikte Π olasılık (Riskli, oluşturucu).
     Aday sayısı sınırlı: maç başına en iyi 3, toplam en iyi 14 (tek seçim puanına göre). En iyi `limit` kombinasyon döner. */
  function combos(entries, opts) {
    const o = { minOdds: 1, maxOdds: Infinity, limit: LIMIT, ...opts };
    const one = o.score === "prob" ? (e) => e.prob : (e) => e.prob * e.price;
    const byMatch = new Map();
    for (const e of entries || []) {
      if (!(e.price > 1) || !(e.prob > 0)) continue;
      if (!byMatch.has(e.match)) byMatch.set(e.match, []);
      byMatch.get(e.match).push(e);
    }
    const cands = [...byMatch.values()].flatMap((l) => l.sort((a, b) => one(b) - one(a) || a.idx - b.idx).slice(0, PER_MATCH))
      .sort((a, b) => one(b) - one(a) || a.idx - b.idx).slice(0, MAX_CANDS);
    const max = Math.min(o.max, MAX_LEGS), min = Math.max(1, o.min);
    const best = [];
    const rank = (c) => (o.score === "prob" ? [c.total_prob, 0] : [c.ev, c.total_prob]);
    const better = (a, b) => { const x = rank(a), y = rank(b); return Math.abs(x[0] - y[0]) > 1e-9 ? x[0] > y[0] : x[1] > y[1] + 1e-12; };
    const legs = [], used = new Set();
    (function walk(start, odds, prob) {
      if (legs.length >= min && odds >= o.minOdds - 1e-9) {
        const c = { legs: [...legs].sort((a, b) => a.kickoff - b.kickoff || a.idx - b.idx), total_odds: odds, total_prob: prob, ev: odds * prob - 1 };
        let i = best.length;
        while (i > 0 && better(c, best[i - 1])) i--;
        if (i < o.limit) { best.splice(i, 0, c); if (best.length > o.limit) best.pop(); }
      }
      if (legs.length >= max) return;
      for (let k = start; k < cands.length; k++) {
        const e = cands[k];
        if (used.has(e.match) || odds * e.price > o.maxOdds + 1e-9) continue;
        legs.push(e); used.add(e.match);
        walk(k + 1, odds * e.price, prob * e.prob);
        legs.pop(); used.delete(e.match);
      }
    })(0, 1, 1);
    return best;
  }

  /* Önerilen kuponun aday girdileri (build ile aynı kurallar): iddaa verisi varsa iddaa oranı, bülten o maça gelmediyse
     yurtdışı; iddaa verisi yoksa yurtdışı. Başlamış maç ve iddaa'da kapalı/bültende olmayan seçenek girmez. */
  function poolEntries(coupon, ctx) {
    const live = !!(ctx && ctx.fetched) && dayCovered(ctx.dayStart, ctx.coverTo);
    const out = [];
    (coupon.pool || []).forEach((p, idx) => {
      if (ctx && ctx.started(p.match)) return;
      const kickoff = ctx ? ctx.kickoff(p.match) : 0;
      const price = live ? ctx.price(p.match, p.key) : null;
      if (price != null) out.push({ match: p.match, key: p.key, prob: p.prob, price, src: ctx.source(p.match, p.key) || "iddaa", kickoff, idx });
      else if (!live || (Number.isFinite(ctx.coverTo) && kickoff > ctx.coverTo)) out.push({ match: p.match, key: p.key, prob: p.prob, price: p.price, src: "yurtdışı", kickoff, idx });
    });
    return out;
  }
  const keySet = (legs) => legs.map((l) => l.key).sort().join(",");
  /* Önerilen kupon + "Başka öner" seçenekleri, değere göre (Π olasılık × Π oran − 1; iddaa oranıyla, yoksa yurtdışı) en iyisi
     önce. Sunucunun kuponu (build sonucu, `server: true`) her zaman listede; diğerleri aynı kuralın kombinasyonları (Düşük risk:
     sunucunun seçim sayısında, Riskli: hedef oran aralığında). En fazla 4. */
  const couponValue = (x) => x.total_prob * x.total_odds - 1;
  function suggestions(kind, coupon, limits, ctx) {
    const first = { ...build(kind, coupon, limits, ctx), server: true };
    const lim = (limits || {})[kind];
    if (!lim || !first.legs.length) return [first];
    const entries = poolEntries(coupon, ctx).filter((e) => e.prob >= lim.min_prob);
    const opts = kind === "safe" ? { min: first.legs.length, max: first.legs.length, score: "ev", limit: LIMIT + 1 }
      : { min: lim.min, max: lim.max, minOdds: lim.target ? lim.target[0] : 1, maxOdds: lim.target ? lim.target[1] : Infinity, score: "ev", limit: LIMIT + 1 };
    const seen = keySet(first.legs);
    const alts = combos(entries, opts).filter((c) => keySet(c.legs) !== seen).slice(0, LIMIT - 1).map((c) => ({
      mode: first.mode, legs: c.legs.map(({ match, key, prob, price, src }) => ({ match, key, prob, price, src })),
      total_odds: c.total_odds, total_prob: c.total_prob, replaced: 0, closed: 0, unmatched: 0, short: false, server: false }));
    // eşit değerde sunucu önerisi önce (sort kararlı; sunucu listenin başında)
    return [first, ...alts].sort((a, b) => (Math.abs(couponValue(b) - couponValue(a)) > 1e-9 ? couponValue(b) - couponValue(a) : 0));
  }

  /* "Başka öner" notu: öneri en iyi öneriye (listenin ilki) göre değerde zayıf mı, aynı mı. */
  function rankNote(kind, r, first) {
    const d = couponValue(r) - couponValue(first);
    return d < -1e-9 ? "model gözünde biraz daha zayıf" : d > 1e-9 ? "model gözünde ilkinden biraz daha iyi" : "model gözünde ilkiyle aynı";
  }

  /* ---------- kendi kuponunu oluştur ---------- */
  const BUILDER_MARKETS = ["h2h", "double_chance", "totals", "btts", "nba"];
  const builderDefaults = () => ({ minOdds: 2, maxOdds: 5, min: 2, max: 4, minProb: 0.3, markets: ["h2h", "double_chance"], onlyValue: false,
    allowForeign: false }); // allowForeign: iddaa oranı olmayan seçimler yurtdışı oranla girsin mi (varsayılan hayır)
  /* Kayıt metni → ayarlar. Hiç fırlatmaz; bozuk ya da geçersiz alan varsayılana döner, sınırlar kırpılır. */
  function parseBuilder(text) {
    const d = builderDefaults();
    let o;
    try { o = JSON.parse(text); } catch { return d; }
    if (!o || typeof o !== "object" || Array.isArray(o) || o.version !== 1) return d;
    const num = (x, lo, hi, def) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def);
    const s = { ...d };
    s.minOdds = num(o.minOdds, 1.01, 1000, d.minOdds);
    s.maxOdds = num(o.maxOdds, 1.01, 1000, d.maxOdds);
    s.min = Math.round(num(o.min, 1, MAX_LEGS, d.min));
    s.max = Math.round(num(o.max, 1, MAX_LEGS, d.max));
    s.minProb = Math.round(num(o.minProb, 0.1, 0.9, d.minProb) * 100) / 100;
    if (Array.isArray(o.markets)) s.markets = BUILDER_MARKETS.filter((m) => o.markets.includes(m));
    if (typeof o.onlyValue === "boolean") s.onlyValue = o.onlyValue;
    if (typeof o.allowForeign === "boolean") s.allowForeign = o.allowForeign;
    return s;
  }
  const serializeBuilder = (s) => JSON.stringify({ version: 1, ...s });

  /* entries: {match, key, group (h2h|double_chance|totals|btts|nba), prob, price, src, derived, kickoff, idx}.
     → {list: combos (değere göre), reason: boşsa neden}. */
  function custom(entries, s) {
    const fail = (reason) => ({ list: [], reason });
    if (s.minOdds > s.maxOdds) return fail("En az oran en çok orandan büyük.");
    if (s.min > s.max) return fail("En az maç sayısı en çok maç sayısından büyük.");
    if (!s.markets.length) return fail("En az bir pazar seç.");
    let pool = (entries || []).filter((e) => !e.derived && s.markets.includes(e.group) && e.prob >= s.minProb - 1e-9 && e.price > 1);
    if (!pool.length) return fail(`Seçilen pazarlarda olasılığı %${Math.round(s.minProb * 100)} ve üstü seçenek yok.`);
    if (!s.allowForeign) {
      pool = pool.filter((e) => e.src !== "yurtdışı");
      if (!pool.length) return fail("iddaa oranı olan seçenek yok; \"iddaa oranı olmayanları da kullan\" anahtarını açabilirsin.");
    }
    if (s.onlyValue) {
      pool = pool.filter((e) => e.src !== "yurtdışı" && evOf(e) >= PLAY - 1e-9);
      if (!pool.length) return fail("iddaa'da artı değerli seçenek yok; anahtarı kapatıp yeniden dene.");
    }
    const n = new Set(pool.map((e) => e.match)).size;
    if (n < s.min) return fail(`Kurala uyan kombinasyon yok: en az ${s.min} maç istendi, uygun ${n} maç var.`);
    const list = combos(pool, { min: s.min, max: s.max, minOdds: s.minOdds, maxOdds: s.maxOdds, score: "ev" });
    if (!list.length) return fail(`Toplam oranı ${String(s.minOdds).replace(".", ",")}–${String(s.maxOdds).replace(".", ",")} arasında kalan kombinasyon yok; oran aralığını genişlet.`);
    return { list, reason: null };
  }

  return { FRESH_MS, dayCovered, legStatus, pick, build, combos, poolEntries, suggestions, rankNote, BUILDER_MARKETS, builderDefaults,
    parseBuilder, serializeBuilder, custom };
})();

if (typeof module !== "undefined") module.exports = Coupons;
