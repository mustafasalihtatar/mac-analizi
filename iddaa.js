/* Maç Analiz — elle girilen iddaa oranları ve beklenen değer (§29). DOM'a dokunmaz; app.js ve testler (tests/js/)
   kullanır. Oranlar sadece bu cihazın localStorage'ında durur; data.json'a, GitHub'a hiçbir şey gitmez. */
"use strict";

const Iddaa = (() => {
  /* Beklenen değer bantları: ev > value → "değerli", ev < low → "düşük", arası (sınırlar dahil) → "adil". */
  const EV_BANDS = { value: 0.02, low: -0.02 };
  const BAND_NAMES = { value: "değerli", fair: "adil", low: "düşük" };
  const KEEP_MS = 24 * 3600 * 1000; // maç başladıktan bu kadar sonra o maçın oranları silinir
  const MAX_ODDS = 1000;
  const VERSION = 1;

  const round2 = (x) => Math.round(x * 100) / 100;
  const validOdds = (o) => typeof o === "number" && Number.isFinite(o) && o > 1 && o <= MAX_ODDS;
  const validProb = (p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;

  /* "1,85" / "1.85" / " 2 " → sayı (2 hane); boş, harf, birden çok ayraç, ≤ 1 → null. */
  function parseOdds(v) {
    if (typeof v === "number") return validOdds(round2(v)) ? round2(v) : null;
    const m = /^\s*(\d+)(?:[.,](\d+))?\s*$/.exec(String(v ?? ""));
    if (!m) return null;
    const x = round2(Number(m[2] === undefined ? m[1] : `${m[1]}.${m[2]}`));
    return validOdds(x) ? x : null;
  }

  /* Beklenen değer (birim tutar başına): olasılık × oran − 1. Geçersiz girdide null. */
  function expectedValue(p, o) {
    if (!validProb(p) || !validOdds(o)) return null;
    return p * o - 1;
  }
  /* Bant ekranda gösterilen değere göre (yüzde, 1 hane): "+%2,0" hiçbir zaman yeşil görünmesin. */
  const shown = (ev) => Math.round(ev * 1000) / 1000;
  function evBand(ev) {
    if (typeof ev !== "number" || !Number.isFinite(ev)) return null;
    const r = shown(ev);
    return r > EV_BANDS.value ? "value" : r < EV_BANDS.low ? "low" : "fair";
  }
  /* 0.0423 → "+%4,2", −0.1 → "−%10,0", 0 → "%0,0" */
  function formatPct(x) {
    if (typeof x !== "number" || !Number.isFinite(x)) return "–";
    const r = shown(x);
    const body = `%${Math.abs(r * 100).toFixed(1).replace(".", ",")}`;
    return r > 0 ? `+${body}` : r < 0 ? `−${body}` : body;
  }

  /* Rozet: {band, text}. model = olasılık doğrulanmamış model tahmini (diğer ligler: piyasa yok) → bant ve renk yok,
     nötr "model" rozeti; yüzde yine yazılır. */
  const MODEL_LABEL = "doğrulanmamış model";
  function evLabel(ev, model) {
    const band = evBand(ev);
    if (!band) return null;
    return model ? { band: "model", text: `${formatPct(ev)} · ${MODEL_LABEL}` }
      : { band, text: `${formatPct(ev)} · ${BAND_NAMES[band]}` };
  }

  /* Bahis şirketinin kar payı: Σ 1/oran − 1 (maçın tüm sonuçlarının oranı; MS için 1, X, 2). */
  function margin(list) {
    if (!Array.isArray(list) || list.length < 2 || !list.every(validOdds)) return null;
    return list.reduce((a, o) => a + 1 / o, 0) - 1;
  }

  /* Kuponun beklenen değeri: Π olasılık × Π oran − 1 (seçimler bağımsız varsayılır). */
  function couponEV(legs) {
    if (!Array.isArray(legs) || !legs.length) return null;
    if (!legs.every((l) => l && validProb(l.prob) && validOdds(l.price))) return null;
    return legs.reduce((a, l) => a * l.prob, 1) * legs.reduce((a, l) => a * l.price, 1) - 1;
  }

  /* Kupondaki bağımlı seçimler: aynı maçı paylaşan (≥ 2) seçimlerin indeks grupları, ilk görünüş sırasıyla. couponEV
     bağımsızlık varsayar; bu gruplar varsa kupon riski çeşitlendirmez (§34). */
  function dependentLegs(legs) {
    if (!Array.isArray(legs)) return [];
    const groups = new Map();
    legs.forEach((l, i) => {
      const id = l && l.matchId;
      if (id == null) return;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(i);
    });
    return [...groups.values()].filter((g) => g.length >= 2);
  }
  /* Gereken olasılık: oranın başa baş noktası, 1 / oran (§34). */
  const required = (o) => (validOdds(o) ? 1 / o : null);

  /* ---------- kayıt: {version, matches: {maçId: {kickoff, odds: {anahtar: oran}, auto?: {anahtar: oran}, autoAt?}}}
     odds = elle girilen, auto = iddaa'dan otomatik çekilen (§34). Okurken elle girilen her zaman önce gelir. ---------- */
  const emptyStore = () => ({ version: VERSION, matches: {} });
  /* Metin → kayıt. Hiç hata fırlatmaz: bozuk metin boş kayıt, geçersiz girdiler tek tek atılır. */
  function parseStore(text) {
    let o;
    try { o = JSON.parse(text); } catch { return emptyStore(); }
    const s = emptyStore();
    if (!o || typeof o !== "object" || o.version !== VERSION || !o.matches || typeof o.matches !== "object") return s;
    for (const [id, m] of Object.entries(o.matches)) {
      if (!m || typeof m !== "object" || isNaN(new Date(m.kickoff)) || !m.odds || typeof m.odds !== "object") continue;
      const odds = {}, auto = {};
      for (const [k, v] of Object.entries(m.odds)) if (typeof k === "string" && validOdds(v)) odds[k] = v;
      if (m.auto && typeof m.auto === "object") for (const [k, v] of Object.entries(m.auto)) if (validOdds(v)) auto[k] = v;
      const rec = { kickoff: String(m.kickoff), odds };
      if (Object.keys(auto).length) { rec.auto = auto; rec.autoAt = isNaN(new Date(m.autoAt)) ? null : String(m.autoAt); }
      if (Object.keys(odds).length || rec.auto) s.matches[id] = rec;
    }
    return s;
  }
  const serialize = (store) => JSON.stringify({ version: VERSION, matches: store.matches });
  /* Başlama + 24 saati geçmiş maçları siler; silinen maç sayısını döner. */
  function prune(store, now) {
    const t = (now || new Date()).getTime();
    let n = 0;
    for (const [id, m] of Object.entries(store.matches)) {
      if (new Date(m.kickoff).getTime() + KEEP_MS < t) { delete store.matches[id]; n++; }
    }
    return n;
  }
  const has = (m) => Object.keys(m.odds).length || (m.auto && Object.keys(m.auto).length);
  function manual(store, matchId, key) {
    const m = store.matches[matchId];
    return m && validOdds(m.odds[key]) ? m.odds[key] : null;
  }
  const autoOf = (store, matchId, key) => {
    const m = store.matches[matchId];
    return m && m.auto && validOdds(m.auto[key]) ? m.auto[key] : null;
  };
  /* Etkin oran: elle girilen, yoksa otomatik çekilen. */
  const get = (store, matchId, key) => manual(store, matchId, key) ?? autoOf(store, matchId, key);
  const source = (store, matchId, key) => (manual(store, matchId, key) != null ? "elle" : autoOf(store, matchId, key) != null ? "iddaa" : null);
  function autoKeys(store, matchId) {
    const m = store.matches[matchId];
    return m && m.auto ? Object.keys(m.auto) : [];
  }
  /* Maçın otomatik oranlarını tümüyle değiştirir (elle girilenlere dokunmaz). Boş harita otomatik oranları siler. */
  function setAuto(store, matchId, kickoff, odds, atIso) {
    if (isNaN(new Date(kickoff))) return false;
    const auto = {};
    for (const [k, v] of Object.entries(odds || {})) if (validOdds(v)) auto[k] = round2(v);
    const m = store.matches[matchId] || (store.matches[matchId] = { kickoff: String(kickoff), odds: {} });
    m.kickoff = String(kickoff);
    if (Object.keys(auto).length) { m.auto = auto; m.autoAt = String(atIso); } else { delete m.auto; delete m.autoAt; }
    if (!has(m)) delete store.matches[matchId];
    return true;
  }
  /* price null → o seçeneğin oranı silinir (maçın son oranıysa maç da). Geçersiz oran yazılmaz: false döner. */
  function set(store, matchId, kickoff, key, price) {
    if (price == null) {
      const m = store.matches[matchId];
      if (!m) return true;
      delete m.odds[key];
      if (!has(m)) delete store.matches[matchId];
      return true;
    }
    if (!validOdds(price) || isNaN(new Date(kickoff))) return false;
    const m = store.matches[matchId] || (store.matches[matchId] = { kickoff: String(kickoff), odds: {} });
    m.kickoff = String(kickoff);
    m.odds[key] = round2(price);
    return true;
  }

  return { EV_BANDS, BAND_NAMES, KEEP_MS, parseOdds, expectedValue, evBand, evLabel, MODEL_LABEL, formatPct, margin, couponEV,
    emptyStore, parseStore, serialize, prune, get, set, manual, autoOdds: autoOf, source, autoKeys, setAuto, required, dependentLegs };
})();

if (typeof module !== "undefined") module.exports = Iddaa;
