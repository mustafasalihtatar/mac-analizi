/* Maç Analiz — canlı skor (§37): iddaa canlı yanıtını ayrıştırır, fark zinciriyle bir canlı tabloda tutar, maç başına durum
   (dakika/devre/bitti), geçici sonuç skoru ve seçim durumu üretir. DOM'a dokunmaz; app.js ve testler (tests/js/live_test.html)
   kullanır. Ham yanıt saklanmaz; tablo sadece bellekte. data.json'a, GitHub'a hiçbir şey gitmez. */
"use strict";

const Live = (() => {
  const BASE = "https://sportsbookv2.iddaa.com/sportsbook/events";
  const ST = { football: 1, basketball: 2 };
  const EVERY_MS = 45000;
  const FORMAT_ERROR = { ok: false, error: "biçim değişti" };

  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const numOrNull = (x) => (isNum(x) ? x : null);

  const url = (sport, version) => `${BASE}?st=${ST[sport]}&type=1&version=${version || 0}`;

  /* Yanıt → {ok, isdiff, version, events, scores, removed}. Alanı eksik tek kayıt atlanır; kayıtların yarısından fazlası
     ayrıştırılamıyorsa biçim hatası. */
  function parse(json) {
    const d = json && json.isSuccess === true && json.data;
    if (!d || !d.sc || typeof d.sc !== "object" || Array.isArray(d.sc)) return FORMAT_ERROR;
    const scores = {};
    const raw = Object.values(d.sc);
    let bad = 0;
    for (const x of raw) {
      const hc = x && x.ht && x.ht.c, ac = x && x.at && x.at.c;
      if (!x || !isNum(x.id) || !isNum(x.s) || !isNum(hc) || !isNum(ac)) { bad++; continue; }
      scores[x.id] = { code: x.s, min: numOrNull(x.min), sec: numOrNull(x.sec), home: hc, away: ac,
        homeReg: numOrNull(x.ht.r), awayReg: numOrNull(x.at.r), t: numOrNull(x.t),
        homeCo: numOrNull(x.ht.co), awayCo: numOrNull(x.at.co) }; // §41 korner (iddaa `co`)
    }
    if (bad * 2 > raw.length) return FORMAT_ERROR;
    const events = [];
    for (const e of Array.isArray(d.events) ? d.events : []) {
      if (!e || ![e.i, e.d, e.phi, e.pai, e.ci].every(isNum)) continue;
      events.push({ id: e.i, homeId: e.phi, awayId: e.pai, compId: e.ci, kickoff: e.d * 1000, home: String(e.hn), away: String(e.an) });
    }
    const removed = (Array.isArray(d.rmi) ? d.rmi : []).filter(isNum);
    return { ok: true, isdiff: d.isdiff === true, version: numOrNull(d.version), events, scores, removed };
  }

  const emptyTable = () => ({ version: 0, fetchedAt: null, events: {}, scores: {}, gone: {}, codes: {} });

  /* Tabloya yeni yanıtı katar (girdi değişmez). Tam yanıtta olmayan canlı maç ve farktaki rmi'de skoru görülmüş maç → gone. */
  function merge(table, p, nowMs) {
    const t = { version: p.version || table.version, fetchedAt: nowMs, events: { ...table.events },
      scores: p.isdiff ? { ...table.scores } : {}, gone: { ...table.gone }, codes: { ...table.codes } };
    for (const e of p.events) t.events[e.id] = e;
    for (const [id, s] of Object.entries(p.scores)) {
      t.scores[id] = s;
      delete t.gone[id];
      const seen = t.codes[id] || [];
      if (!seen.includes(s.code)) t.codes[id] = [...seen, s.code];
    }
    const drop = (id) => {
      if (table.scores[id] && !p.scores[id]) t.gone[id] = { score: table.scores[id], at: nowMs };
      delete t.scores[id];
    };
    if (!p.isdiff) {
      for (const id of Object.keys(table.scores)) if (!p.scores[id]) drop(id);
    } else {
      for (const id of p.removed) {
        if (p.scores[id]) continue;
        if (table.scores[id]) drop(id);
        delete t.events[id];
      }
    }
    return t;
  }

  /* Tam görüntü (version=0) gerekir mi: zincir yok, son çekim 3 × 45 sn'den eski (sekme uyudu), ya da verilen (eşleşmiş) maçlardan
     biri bitişe yakın — fark modunda düşen maç sadece rmi ile, dakikalarca gecikmeli gelir; tam görüntüde hemen görünür. */
  const needsFull = (table, nowMs, ids, sport) => !table.version || !table.fetchedAt || nowMs - table.fetchedAt > 3 * EVERY_MS
    || (!!ids && delay(table, ids, sport) < EVERY_MS);

  /* ---------- maç görünümü ---------- */
  // Gözlenen kodlar (§37). Basketbol FIBA'da gözlendi; NBA'de farklıysa maç "güvenilmez" olur: skor görünür, sonuç yok.
  const KNOWN = { football: [2, 3, 4, 6], basketball: [15, 16, 17, 18, 25, 62, 6] };
  const ENDED = 6;
  const HT = { football: 4, basketball: 25 };
  const OT = 62;
  const Q4 = 18;
  /* Kod görülmeden düşen maç bitmiş sayılabilir mi (son görülen durumdan). Basketbolda berabere skor asla: uzatmaya gider. */
  const looksFinal = (s, sport) => (sport === "football" ? s.code === 3 && s.min != null && s.min >= 90
    : (s.code === Q4 || s.code === OT) && (s.min == null || s.min === 0) && s.home !== s.away);
  /* Bitişe yakın mı (çekme aralığı 15 sn). Basketbolda min = periyotta kalan dakika. */
  const closing = (s, sport) => (sport === "football" ? s.code === 3 && s.min != null && s.min >= 88
    : (s.code === Q4 || s.code === OT) && s.min != null && s.min < 2);

  function liveLabel(s, sport) {
    if (sport === "football") {
      if (s.code === HT.football) return "İY";
      if ((s.code === 2 || s.code === 3) && s.min != null) return `${s.min}'`;
      return "Canlı";
    }
    if (s.code >= 15 && s.code <= Q4) return `${s.code - 14}. çeyrek`;
    if (s.code === HT.basketball) return "Devre arası";
    if (s.code === OT) return "Uzatma";
    return "Canlı";
  }

  /* Maç görünümü: {state, label, score, settleScore, corners, settleCorners, provisional, certain, trusted} | null (tabloda
     hiç yoksa). §41 corners: iddaa korner sayısı "ev-dep"; settleCorners sadece settleScore verildiğinde (bitti + güvenilir). */
  function view(table, id, sport) {
    const live = table.scores[id], gone = table.gone[id];
    const s = live || (gone && gone.score);
    if (!s) return null;
    const known = KNOWN[sport] || [];
    const trusted = (table.codes[id] || [s.code]).every((c) => known.includes(c));
    const certain = s.code === ENDED;
    const ended = certain || (!live && looksFinal(s, sport));
    const state = ended ? "ended" : !live ? "gone" : s.code === HT[sport] ? "ht" : "live";
    const label = state === "ended" ? (certain ? "Bitti" : "Muhtemelen bitti") : state === "gone" ? "Sonuç bekleniyor" : liveLabel(s, sport);
    let settleScore = null;
    if (ended && trusted) {
      if (sport === "basketball") settleScore = `${s.home}-${s.away}`;
      else if (s.homeReg != null && s.awayReg != null) settleScore = `${s.homeReg}-${s.awayReg}`;
    }
    const corners = s.homeCo != null && s.awayCo != null ? `${s.homeCo}-${s.awayCo}` : null;
    return { state, label, score: `${s.home}-${s.away}`, settleScore, corners, settleCorners: settleScore != null ? corners : null,
      provisional: settleScore != null, certain: ended && certain, trusted };
  }

  /* Kupon seçiminin canlı satır metni. §41 korner seçiminde gol skoru yerine iddaa korner sayısı. */
  function legText(key, v) {
    const k = History.parseKey(key), corner = !!k && k.market.startsWith("corners_");
    const dash = (x) => String(x).replace("-", "–");
    const val = corner ? (v.corners ? `korner ${dash(v.corners)}` : "korner sayısı yok") : dash(v.score);
    const settle = corner ? v.settleCorners : v.settleScore;
    if (v.state === "ended") {
      const t = v.certain ? `Bitti · ${val} (iddaa)` : `Muhtemelen bitti · son ${corner ? val : `skor ${val}`}`;
      return settle ? t : `${t} · durum kodu tanınmadı, sonuç sabah`;
    }
    if (v.state === "gone") return `Sonuç bekleniyor · son ${corner ? val : `skor ${val}`}`;
    return `${v.label} · ${val}`;
  }

  /* Maç bitmeden kesinleşen sonuç: üst tuttu, alt yattı, KG var tuttu, KG yok yattı. */
  function decidedEarly(key, result) {
    const k = History.parseKey(key);
    if (!k) return false;
    if (k.market === "totals" || k.market === "corners_totals") return (k.outcome === "over" && result === "won") || (k.outcome === "under" && result === "lost");
    if (k.market === "btts") return (k.outcome === "yes" && result === "won") || (k.outcome === "no" && result === "lost");
    return false;
  }

  /* Seçimin canlı durumu: {result, decided, provisional, certain} | null. */
  function legState(key, v) {
    if (!v || v.state === "gone") return null;
    const k = History.parseKey(key), corner = !!k && k.market.startsWith("corners_"); // §41
    if (v.state === "ended") {
      const fin = corner ? v.settleCorners : v.settleScore;
      const r = fin == null ? null : History.legFromScore(key, fin);
      return r ? { result: r, decided: true, provisional: true, certain: v.certain } : null;
    }
    const r = History.legFromScore(key, corner ? v.corners : v.score);
    return r ? { result: r, decided: v.trusted && decidedEarly(key, r), provisional: false, certain: false } : null;
  }

  /* Kupon özeti: bir seçim yatıyorsa "lost"; hepsinin durumu var ve yatan yoksa "won"; aksi "partial". */
  function couponNow(states) {
    const total = states.length;
    const ok = states.filter((s) => s && (s.result === "won" || s.result === "void")).length;
    if (states.every((s) => !s)) return { now: null, ok, total };
    if (states.some((s) => s && s.result === "lost")) return { now: "lost", ok, total };
    return { now: states.every(Boolean) ? "won" : "partial", ok, total };
  }

  /* Çekme aralığı: verilen (eşleşmiş) maçlardan biri bitişe yakınsa 15 sn, aksi 45 sn. */
  const delay = (table, ids, sport) => (ids.some((id) => table.scores[id] && closing(table.scores[id], sport)) ? 15000 : EVERY_MS);

  /* Aday maç yokken bir sonraki uyanma: gelecekteki en erken (başlama − 10 dk); yoksa null. */
  function wakeAt(kickoffsMs, nowMs) {
    const next = kickoffsMs.map((k) => k - 10 * 60 * 1000).filter((t) => t > nowMs);
    return next.length ? Math.min(...next) : null;
  }

  /* ---------- bitti etiketi + son görülen skor (2026-11-28) ----------
     Biten maçı sayfa kapalıyken kaçıran telefonda maç sabaha kadar "başladı" kalmasın: başlama + 2 sa 15 dk (futbol, diğer ligler)
     / + 3 sa (basketbol) geçmiş ve maç canlı akışta yoksa "bitti · sonuç sabah gelir". Sadece metin: kupon sonuçlandırmaz
     (geçici sonuç yalnız kod 6 ya da looksFinal düşüşüyle, view → legState). Son görülen skor localStorage'da (app.js
     macanaliz.canli.skor.v1): {<bizim maç id>: {score, at, kickoff}}. */
  const AFTER_MS = { football: 135 * 60000, basketball: 180 * 60000 };
  const SEEN_KEEP_MS = 36 * 3600 * 1000;

  /* v: Live.view (null = tabloda yok); seen: {score} | null. Akışta (canlı, İY, bitti) olan maçın kendi etiketi var → null. */
  function afterText(kickoffMs, nowMs, sport, v, seen) {
    if (v && v.state !== "gone") return null;
    if (!(nowMs >= kickoffMs + (AFTER_MS[sport] || AFTER_MS.football))) return null;
    const sc = seen && typeof seen.score === "string" && seen.score ? seen.score : null;
    return `bitti · sonuç sabah gelir${sc ? ` · son görülen ${sc.replace("-", "–")}` : ""}`;
  }

  /* items [{id, score, kickoff}] → yeni kayıt; hiçbir skor değişmediyse aynı nesne (yazma gerekmez). */
  function rememberSeen(store, items, nowMs) {
    let out = store;
    for (const x of items) {
      if (!x || typeof x.score !== "string" || !x.score) continue;
      const old = store[x.id];
      if (old && old.score === x.score) continue;
      if (out === store) out = { ...store };
      out[x.id] = { score: x.score, at: nowMs, kickoff: isNum(x.kickoff) ? x.kickoff : nowMs };
    }
    return out;
  }

  /* Bozuk kayıtları ve başlamasından 36 sa geçmiş maçları atar; değişmezse aynı nesne. */
  function pruneSeen(store, nowMs) {
    if (!store || typeof store !== "object" || Array.isArray(store)) return {};
    const keep = Object.entries(store).filter(([, x]) => x && typeof x.score === "string" && isNum(x.kickoff)
      && nowMs - x.kickoff <= SEEN_KEEP_MS);
    return keep.length === Object.keys(store).length ? store : Object.fromEntries(keep);
  }

  return { ST, EVERY_MS, KNOWN, wakeAt, url, parse, emptyTable, merge, needsFull, view, legState, legText, couponNow, delay,
    afterText, rememberSeen, pruneSeen };
})();

if (typeof module !== "undefined") module.exports = Live;
