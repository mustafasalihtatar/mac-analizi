/* Maç Analiz — kupon geçmişi hesapları (§27). DOM'a dokunmaz; app.js ve testler (tests/js/) kullanır.
   Veri sadece bu cihazın localStorage'ında durur; data.json'a, GitHub'a hiçbir tutar gitmez. */
"use strict";

const History = (() => {
  const VERSION = 1;
  const TYPES = ["safe", "risky", "slip", "mixed", "own"];
  // Ad kayıtta tutulmaz, tipten türetilir: eski kayıtlarda da güncel ad görünür ("Garanti" → "Düşük risk").
  const TYPE_NAMES = { safe: "Düşük risk", risky: "Riskli", slip: "Market fişi", mixed: "Karma", own: "Kendi kuponum" };
  const LEGACY_TYPES = { garanti: "safe", "düşük risk": "safe", riskli: "risky", "market fişi": "slip", karma: "mixed",
    "kendi kuponum": "own", kendi: "own" };
  const MANUAL = ["won", "lost", "void"];
  const PENDING_STATUSES = ["postponed", "cancelled", "aet"]; // otomatik sonuçlandırılmaz, elle

  const num = (x) => (typeof x === "number" ? x : parseFloat(x));
  const finite = (x) => Number.isFinite(num(x));
  const round2 = (x) => Math.round(x * 100) / 100;

  function normType(t) {
    if (TYPES.includes(t)) return t;
    const k = String(t || "").trim().toLowerCase();
    return LEGACY_TYPES[k] || "own";
  }

  /* Kupon tipi: tüm seçimler tek bir önerilen kupondan → o tip; birden çok önerilen kupondan → Karma;
     en az biri Maçlar'dan (ya da kaynağı bilinmiyor) → Kendi kuponum. */
  function detectType(legs) {
    const srcs = new Set((legs || []).map((l) => l.src));
    if (!srcs.size) return "own";
    for (const s of srcs) if (!["safe", "risky", "slip"].includes(s)) return "own";
    return srcs.size === 1 ? [...srcs][0] : "mixed";
  }

  /* "<id>|<pazar>|<seçim>|<çizgi>" — id içinde "|" olabilir diye sondan ayrılır. */
  function parseKey(key) {
    const parts = String(key).split("|");
    if (parts.length < 4) return null;
    const line = parts.pop(), outcome = parts.pop(), market = parts.pop();
    return { id: parts.join("|"), market, outcome, line: line === "" ? null : num(line) };
  }
  function parseScore(s) {
    const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String(s || ""));
    return m ? [Number(m[1]), Number(m[2])] : null;
  }

  /* Skordan seçim sonucu: won | lost | void (tam çizgide eşitlik = iade) | null (bilinmeyen pazar). */
  function legFromScore(key, score) {
    const k = parseKey(key), sc = parseScore(score);
    if (!k || !sc) return null;
    const [h, a] = sc;
    const res = (b) => (b ? "won" : "lost");
    switch (k.market) {
      case "h2h": return res((h > a ? "home" : h < a ? "away" : "draw") === k.outcome);
      case "double_chance": {
        const ok = { "1X": h >= a, X2: h <= a, "12": h !== a }[k.outcome];
        return ok === undefined ? null : res(ok);
      }
      case "btts": return k.outcome === "yes" ? res(h > 0 && a > 0) : k.outcome === "no" ? res(!(h > 0 && a > 0)) : null;
      case "totals": {
        if (k.line == null || !["over", "under"].includes(k.outcome)) return null;
        const t = h + a;
        if (t === k.line) return "void";
        return res((t > k.line) === (k.outcome === "over"));
      }
      case "spreads": {
        if (k.line == null) return null;
        const d = k.outcome === "home" ? h + k.line - a : k.outcome === "away" ? a + k.line - h : null;
        if (d === null) return null;
        return d === 0 ? "void" : res(d > 0);
      }
      case "handicap3": { // §34 3 yollu (Avrupa) handikap: çizgi ev skoruna eklenir, iade yok
        if (k.line == null) return null;
        const d = h + k.line - a;
        const r = d > 0 ? "home" : d < 0 ? "away" : "draw";
        return ["home", "draw", "away"].includes(k.outcome) ? res(r === k.outcome) : null;
      }
      default: return null;
    }
  }

  /* Seçimin geçerli sonucu: elle girilen her zaman önce; sonra resmi skor (yalnızca durum "finished" ise); resmi durum yoksa
     §37 geçici (iddaa canlı) skor. */
  function legResult(leg) {
    if (MANUAL.includes(leg.manual)) return leg.manual;
    if (leg.status === "finished") return legFromScore(leg.key, leg.score);
    if (leg.status == null && leg.prov) return legFromScore(leg.key, leg.prov.score);
    return null;
  }
  /* Sonucu geçici skordan mı geliyor. */
  const legProvisional = (leg) => !MANUAL.includes(leg.manual) && leg.status == null && !!leg.prov
    && legFromScore(leg.key, leg.prov.score) !== null;
  /* Elle sonuçlandırılması gereken (ertelendi / iptal / uzatma) ve elle girilmemiş seçim. */
  const needsManual = (leg) => PENDING_STATUSES.includes(leg.status) && !MANUAL.includes(leg.manual);

  /* Kupon: won | lost | void | pending, dönen tutar (bekliyorsa null). Bir seçim yatarsa kupon hemen yatar. */
  function settle(c) {
    const rs = c.legs.map(legResult);
    // §37 sonuç geçici skora dayanıyor mu (yatan kuponda: yatıran seçimlerden biri geçiciyse); probable: kod 6 görülmeden bitti sayılan
    const flags = (used) => {
      const provs = c.legs.filter((l, i) => used(rs[i]) && legProvisional(l));
      return { provisional: provs.length > 0, probable: provs.some((l) => l.prov.certain === false) };
    };
    if (rs.includes("lost")) {
      const official = c.legs.some((l, i) => rs[i] === "lost" && !legProvisional(l)); // resmi yatan seçim varsa kesin yattı
      return { status: "lost", payout: 0, odds: null, ...(official ? { provisional: false, probable: false } : flags((r) => r === "lost")) };
    }
    if (rs.some((r) => r === null)) return { status: "pending", payout: null, odds: null, provisional: false, probable: false };
    if (rs.every((r) => r === "void")) return { status: "void", payout: round2(c.stake), odds: 1, ...flags(() => true) };
    const odds = c.legs.reduce((acc, l, i) => acc * (rs[i] === "won" ? num(l.price) : 1), 1);
    return { status: "won", payout: round2(c.stake * odds), odds, ...flags(() => true) };
  }

  /* §37 muhtemel bitti sayılan maç yeniden canlı göründü: o maçların muhtemel (certain: false) geçici skoru geri alınır. */
  function withdrawProvisional(store, matchIds, nowIso) {
    const ids = new Set(matchIds || []);
    let changed = 0;
    for (const c of store.coupons) {
      let touched = false;
      for (const l of c.legs) if (ids.has(l.matchId) && l.prov && l.prov.certain === false) { l.prov = null; touched = true; }
      if (touched) { c.updatedAt = nowIso; changed++; }
    }
    return changed;
  }

  /* §37 iddaa'da biten maçların geçici skoru ([{id, score, certain}]) → resmi/elle sonucu olmayan seçimlere `prov`. Değişen kupon sayısı. */
  function applyProvisional(store, items, nowIso) {
    const by = new Map((items || []).filter((x) => x && typeof x.id === "string" && parseScore(x.score)).map((x) => [x.id, x]));
    let changed = 0;
    for (const c of store.coupons) {
      let touched = false;
      for (const l of c.legs) {
        const x = by.get(l.matchId);
        if (!x || l.status != null || MANUAL.includes(l.manual)) continue;
        const certain = x.certain === true;
        if (l.prov && l.prov.score === x.score && l.prov.certain === certain) continue;
        l.prov = { score: String(x.score), at: nowIso, certain };
        touched = true;
      }
      if (touched) { c.updatedAt = nowIso; changed++; }
    }
    return changed;
  }

  /* data.json "results" ([{id, score, status}]) → bekleyen seçimlere skor/durum yazar. Kaydedilen değer kalıcı:
     sonuç 7 gün sonra listeden düşse de kupon sonuçlanmış kalır. Değişen kupon sayısını döner. */
  function applyResults(store, results) {
    const by = new Map((results || []).filter((r) => r && typeof r.id === "string").map((r) => [r.id, r]));
    let changed = 0;
    for (const c of store.coupons) {
      let touched = false;
      for (const l of c.legs) {
        const r = by.get(l.matchId);
        if (!r) continue;
        const score = r.score == null ? null : String(r.score);
        if (l.status === "finished" && l.score) continue; // biten maçın skoru bir kez yazılır
        if (l.status !== r.status || l.score !== score) { l.status = r.status; l.score = score; touched = true; }
        if (l.prov) { l.prov = null; touched = true; } // §37 resmi durum geldi: geçici skor artık geçmez
      }
      if (touched) { c.updatedAt = new Date().toISOString(); changed++; }
    }
    return changed;
  }

  /* ---------- özetler ---------- */
  function monthKey(iso, tz) {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Europe/Istanbul", year: "numeric", month: "2-digit" })
      .formatToParts(new Date(iso));
    return `${p.find((x) => x.type === "year").value}-${p.find((x) => x.type === "month").value}`;
  }
  function summarize(coupons) {
    const s = { count: coupons.length, staked: 0, settledStaked: 0, returned: 0, net: 0, won: 0, lost: 0, void: 0,
      pending: 0, pendingStaked: 0, hitRate: null };
    for (const c of coupons) {
      const r = settle(c);
      s.staked += num(c.stake);
      if (r.status === "pending") { s.pending++; s.pendingStaked += num(c.stake); continue; }
      s[r.status]++;
      s.settledStaked += num(c.stake);
      s.returned += r.payout;
    }
    s.net = s.returned - s.settledStaked;
    const decided = s.won + s.lost;
    s.hitRate = decided ? s.won / decided : null;
    for (const k of ["staked", "settledStaked", "returned", "net", "pendingStaked"]) s[k] = round2(s[k]);
    return s;
  }
  function byType(coupons) {
    return TYPES.map((t) => ({ type: t, name: TYPE_NAMES[t], ...summarize(coupons.filter((c) => normType(c.type) === t)) }));
  }
  /* Modelin tahmin ettiği tutma ihtimali ile gerçekleşen: sadece tuttu/yattı kesinleşmiş ve ihtimali bilinen kuponlar. */
  function calibration(coupons) {
    const rows = coupons.map((c) => ({ p: c.totalProb, r: settle(c).status }))
      .filter((x) => finite(x.p) && (x.r === "won" || x.r === "lost"));
    if (!rows.length) return { n: 0, expectedRate: null, actualRate: null, expectedWins: 0, actualWins: 0, bins: [] };
    const exp = rows.reduce((a, x) => a + num(x.p), 0), act = rows.filter((x) => x.r === "won").length;
    const edges = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.0001]];
    const bins = edges.map(([lo, hi]) => {
      const b = rows.filter((x) => x.p >= lo && x.p < hi);
      return { lo, hi: Math.min(hi, 1), n: b.length,
        pred: b.length ? b.reduce((a, x) => a + num(x.p), 0) / b.length : null,
        obs: b.length ? b.filter((x) => x.r === "won").length / b.length : null };
    }).filter((b) => b.n);
    return { n: rows.length, expectedRate: exp / rows.length, actualRate: act / rows.length,
      expectedWins: exp, actualWins: act, bins };
  }
  /* Aylık bütçe: ok | near (%80 ve üstü) | over (aştı) | null (bütçe yok). extra: oynanmak üzere olan tutar. */
  function budgetState(store, now, extra, tz) {
    const b = num(store.budget);
    if (!(b > 0)) return null;
    const mk = monthKey((now || new Date()).toISOString(), tz);
    const spent = round2(store.coupons.filter((c) => monthKey(c.playedAt, tz) === mk).reduce((a, c) => a + num(c.stake), 0)
      + (num(extra) || 0));
    const ratio = spent / b;
    return { budget: b, spent, left: round2(b - spent), ratio, level: ratio > 1 ? "over" : ratio >= 0.8 ? "near" : "ok" };
  }

  /* ---------- kayıt ---------- */
  function newId() {
    return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
  /* Sepetten oynanan kupon. legs: app.js kupon seçimleri (key, matchId, pick, match, competition, kickoff, price, prob, src,
     verified). verified === false: oran iddaa'dan girilmedi (yurtdışı ya da adil oran) → kupon "oran doğrulanmadı" (§29). */
  function makeCoupon(legs, stake, type, now) {
    const price = legs.reduce((a, l) => a * num(l.price), 1);
    const probs = legs.map((l) => l.prob);
    const totalProb = probs.every(finite) ? probs.reduce((a, p) => a * num(p), 1) : null;
    const at = (now || new Date()).toISOString();
    return {
      id: newId(), playedAt: at, updatedAt: at, type: normType(type), stake: round2(num(stake)),
      totalOdds: round2(price), totalProb, unverified: legs.some((l) => l.verified === false),
      legs: legs.map((l) => ({ key: l.key, matchId: l.matchId, pick: l.pick, match: l.match, competition: l.competition || "",
        kickoff: l.kickoff, price: round2(num(l.price)), prob: finite(l.prob) ? num(l.prob) : null, fair: !!l.fair,
        verified: l.verified !== false, status: null, score: null, manual: null, prov: null })),
    };
  }
  const emptyStore = () => ({ version: VERSION, budget: null, coupons: [] });

  /* Doğrulama: hata dizisi (boşsa geçerli). Bir tane bozuk kupon bile dosyayı reddeder. */
  function validateCoupon(c, i) {
    const e = [], at = `Kupon ${i + 1}`;
    if (!c || typeof c !== "object") return [`${at}: nesne değil`];
    if (typeof c.id !== "string" || !c.id) e.push(`${at}: id yok`);
    if (!c.playedAt || isNaN(new Date(c.playedAt))) e.push(`${at}: tarih geçersiz`);
    if (!(num(c.stake) > 0) || !finite(c.stake)) e.push(`${at}: tutar geçersiz`);
    if (!(num(c.totalOdds) >= 1)) e.push(`${at}: toplam oran geçersiz`);
    if (c.totalProb != null && !(num(c.totalProb) >= 0 && num(c.totalProb) <= 1)) e.push(`${at}: tutma ihtimali geçersiz`);
    if (!Array.isArray(c.legs) || !c.legs.length) { e.push(`${at}: seçim yok`); return e; }
    c.legs.forEach((l, j) => {
      const lt = `${at}, seçim ${j + 1}`;
      if (!l || typeof l !== "object") { e.push(`${lt}: nesne değil`); return; }
      if (typeof l.key !== "string" || !parseKey(l.key)) e.push(`${lt}: anahtar geçersiz`);
      if (typeof l.matchId !== "string") e.push(`${lt}: maç yok`);
      if (!(num(l.price) > 1)) e.push(`${lt}: oran geçersiz`);
      if (l.manual != null && !MANUAL.includes(l.manual)) e.push(`${lt}: elle sonuç geçersiz`);
      if (l.score != null && !parseScore(l.score)) e.push(`${lt}: skor geçersiz`);
    });
    return e;
  }
  /* §37 geçici skor: geçersizse (eski/bozuk yedek) atılır, dosya reddedilmez. */
  const normProv = (p) => (p && typeof p === "object" && parseScore(p.score) && p.at && !isNaN(new Date(p.at))
    ? { score: String(p.score), at: p.at, certain: p.certain === true } : null);
  function normalizeCoupon(c) {
    return { ...c, type: normType(c.type), stake: num(c.stake), totalOdds: num(c.totalOdds),
      totalProb: c.totalProb == null ? null : num(c.totalProb), updatedAt: c.updatedAt || c.playedAt,
      unverified: c.unverified === true, // §29 öncesi kayıtlarda alan yok → doğrulanmış sayılır
      legs: c.legs.map((l) => ({ ...l, price: num(l.price), prob: l.prob == null ? null : num(l.prob), verified: l.verified !== false,
        status: l.status || null, score: l.score == null ? null : String(l.score), manual: l.manual || null, prov: normProv(l.prov) })) };
  }
  /* Metin (yedek dosyası ya da localStorage) → {ok, store} | {ok: false, error}. */
  function parseStore(text) {
    let o;
    try { o = JSON.parse(text); } catch { return { ok: false, error: "Veri okunamadı (geçerli JSON değil)." }; }
    if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "Veri Maç Analiz yedeği değil." };
    if (o.version !== VERSION) return { ok: false, error: "Yedek sürümü tanınmıyor." };
    if (!Array.isArray(o.coupons)) return { ok: false, error: "Yedekte kupon listesi yok." };
    if (o.budget != null && !(num(o.budget) > 0)) return { ok: false, error: "Bütçe değeri geçersiz." };
    const errs = o.coupons.flatMap(validateCoupon);
    if (errs.length) return { ok: false, error: `Yedek bozuk: ${errs.slice(0, 3).join("; ")}${errs.length > 3 ? " …" : ""}` };
    const ids = new Set();
    for (const c of o.coupons) {
      if (ids.has(c.id)) return { ok: false, error: "Yedekte aynı kupon iki kez var." };
      ids.add(c.id);
    }
    return { ok: true, store: { version: VERSION, budget: o.budget == null ? null : num(o.budget),
      coupons: o.coupons.map(normalizeCoupon) } };
  }
  /* Yedeği mevcut veriyle birleştirir (aynı id'de daha yeni güncellenen kalır); mevcut hiçbir kupon silinmez. */
  function mergeStores(current, incoming) {
    const map = new Map(current.coupons.map((c) => [c.id, c]));
    let added = 0, updated = 0;
    for (const c of incoming.coupons) {
      const old = map.get(c.id);
      if (!old) { map.set(c.id, c); added++; }
      else if (new Date(c.updatedAt) > new Date(old.updatedAt)) { map.set(c.id, c); updated++; }
    }
    const coupons = [...map.values()].sort((a, b) => new Date(b.playedAt) - new Date(a.playedAt));
    return { store: { version: VERSION, budget: current.budget ?? incoming.budget, coupons }, added, updated };
  }
  const serialize = (store) => JSON.stringify({ version: VERSION, budget: store.budget, coupons: store.coupons }, null, 1);

  return { VERSION, TYPES, TYPE_NAMES, normType, detectType, parseKey, parseScore, legFromScore, legResult, legProvisional, needsManual,
    settle, applyResults, applyProvisional, withdrawProvisional, monthKey, summarize, byType, calibration, budgetState, makeCoupon, emptyStore, parseStore,
    mergeStores, serialize };
})();

if (typeof module !== "undefined") module.exports = History;
