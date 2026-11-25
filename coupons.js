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

  return { FRESH_MS, dayCovered, legStatus, pick, build };
})();

if (typeof module !== "undefined") module.exports = Coupons;
