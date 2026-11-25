/* Maç Analiz — iddaa bülteni (§34): tarayıcıda çekilen yanıtı ayrıştırır, eler, bizim maçlarla eşler ve seçenek
   anahtarlarına çevirir. DOM'a dokunmaz; app.js ve testler (tests/js/) kullanır. Ham yanıt saklanmaz; sadece eşleşen
   seçeneklerin oranı bu cihazın iddaa kaydına (iddaa.js, "auto") yazılır. data.json'a, GitHub'a hiçbir şey gitmez. */
"use strict";

const Bulletin = (() => {
  const BASE = "https://sportsbookv2.iddaa.com/sportsbook/events";
  const ST = { football: 1, basketball: 2 };
  const EVERY_MS = 2 * 3600 * 1000;   // spor başına en fazla 2 saatte bir
  const KICKOFF_TOL_MS = 2 * 3600 * 1000;
  const FORMAT_ERROR = { ok: false, error: "biçim değişti" };

  /* iddaa pazar kodu (t_st) → bizim pazar. lines: izin verilen çizgiler (yoksa her çizgi); out: seçenek adı → sonuç.
     neg: deplasman tarafında çizgi işaret değiştirir (NBA handikabı). Tablo dışı her pazar yok sayılır. */
  const MARKETS = {
    football: {
      "1_1": { market: "h2h", out: { 1: "home", 0: "draw", 2: "away" } },
      "2_92": { market: "double_chance", out: { "1 ve 0": "1X", "1 ve 2": "12", "0 ve 2": "X2" } },
      "2_101": { market: "totals", line: true, lines: ["1.5", "2.5", "3.5"], out: { Alt: "under", "Üst": "over" } },
      "2_89": { market: "btts", out: { Var: "yes", Yok: "no" } },
      "2_100": { market: "handicap3", line: true, lines: ["-3", "-2", "-1", "1", "2", "3"], out: { 1: "home", 0: "draw", 2: "away" } },
    },
    basketball: {
      "1_2": { market: "h2h", out: { 1: "home", 2: "away" } },
      "2_113": { market: "spreads", line: true, neg: true, out: { 1: "home", 2: "away" } },
      "2_114": { market: "totals", line: true, out: { Alt: "under", "Üst": "over" } },
    },
  };

  const url = (sport) => `${BASE}?st=${ST[sport]}&type=0&version=0&live=false`;
  const isNum = (x) => typeof x === "number" && Number.isFinite(x);
  const lineStr = (x) => String(Number(x));

  /* Yanıt → {ok, events}. Biçim beklenmedikse {ok:false, error}. Eleme: oynanan / başlamış maç, pazarsız (sözde) maç,
     canlı pazar (t ∉ {1,2}), oranı 1.00 (kapalı) seçenek. Oran "odd" alanından; "wodd" kullanılmaz. */
  function parse(json, nowMs) {
    const evs = json && json.isSuccess === true && json.data && json.data.events;
    if (!Array.isArray(evs)) return FORMAT_ERROR;
    const events = [];
    let candidates = 0; // oynanmayan, başlamamış, pazarı olan maçlar
    const skipped = []; // alanları beklenen biçimde olmayan maçlar: atlanır (çoğunluksa biçim hatası)
    for (const e of evs) {
      if (!e || ![e.i, e.d, e.phi, e.pai, e.ci].every(isNum) || !Array.isArray(e.m)) {
        skipped.push(e && isNum(e.i) ? e.i : null);
        continue;
      }
      if (e.s === 1 || e.bp === 1 || e.d * 1000 <= nowMs) continue;
      if (e.m.length) candidates++;
      const markets = [];
      for (const m of e.m) {
        if (!m || (m.t !== 1 && m.t !== 2) || !Array.isArray(m.o)) continue;
        const outcomes = m.o.filter((o) => o && isNum(o.odd) && o.odd > 1).map((o) => ({ n: String(o.n), odd: o.odd }));
        if (outcomes.length) markets.push({ key: `${m.t}_${m.st}`, line: m.sov == null ? null : String(m.sov), outcomes });
      }
      if (!markets.length) continue;
      events.push({ id: e.i, homeId: e.phi, awayId: e.pai, home: String(e.hn), away: String(e.an), compId: e.ci,
        kickoff: e.d * 1000, markets });
    }
    // pazarı olan maçlar var ama hiçbirinden oran çıkmadı: oran alanı değişmiş olmalı (sessizce "0 maç" sayılmasın)
    if (candidates && !events.length) return FORMAT_ERROR;
    if (skipped.length * 2 > evs.length) return FORMAT_ERROR; // maçların yarısından fazlası ayrıştırılamadı
    return { ok: true, events, skipped };
  }

  /* Eşleme: lig haritada ve bu sporsa; iki takım id'si haritada; bizim maçta adlar birebir aynı, saat farkı ≤ 2 sa.
     Eşleşmeyen takım ya da maç loglanır, tahmin edilmez (ters ev/deplasman da eşleşmez). */
  function match(events, ourMatches, map, sport) {
    const pairs = [], teams = [], matches = [], seen = new Set();
    const comps = (map && map.comps) || {}, names = (map && map.teams) || {};
    for (const ev of events || []) {
      if (comps[ev.compId] !== sport) continue;
      const home = names[ev.homeId], away = names[ev.awayId];
      if (home == null || away == null) {
        for (const [id, name, known] of [[ev.homeId, ev.home, home], [ev.awayId, ev.away, away]]) {
          if (known == null && !seen.has(id)) { seen.add(id); teams.push({ id, name, comp: ev.compId }); }
        }
        continue;
      }
      const m = (ourMatches || []).find((x) => x.home === home && x.away === away
        && Math.abs(new Date(x.kickoff).getTime() - ev.kickoff) <= KICKOFF_TOL_MS);
      if (m) pairs.push({ ev, match: m });
      else matches.push({ home, away, kickoff: new Date(ev.kickoff).toISOString() });
    }
    return { pairs, log: { teams, matches } };
  }

  const keyOf = (id, market, outcome, line) => `${id}|${market}|${outcome}|${line == null ? "" : line}`;
  /* Bizde karşılığı olan seçenek mi: data.json seçeneği, ya da `lines` tablosunda çizgisi olan ek seçenek. */
  function linesHas(match, market, outcome, line) {
    const L = match.lines;
    if (!L || line == null) return false;
    if (market === "handicap3") return !!(L.handicap3 && L.handicap3[line]);
    if (market === "spreads") return !!(L.spreads && L.spreads[outcome === "home" ? line : lineStr(-Number(line))] != null);
    if (market === "totals" && match.sport === "basketball") return !!(L.totals && L.totals[line] != null);
    return false;
  }

  /* Eşleşen maçın oranları → {odds: {anahtar: oran}, unknown}. unknown: tablo dışı ya da bizde karşılığı olmayan seçenek. */
  function oddsFor(ev, match, sport) {
    const table = MARKETS[sport] || {};
    const known = new Set((match.options || []).map((o) => o.key));
    const odds = {};
    let unknown = 0;
    for (const m of ev.markets) {
      const spec = table[m.key];
      const okLine = spec && (!spec.line || (m.line != null && (!spec.lines || spec.lines.includes(lineStr(m.line)))));
      for (const o of m.outcomes) {
        const outcome = okLine ? spec.out[o.n] : undefined;
        if (!outcome) { unknown++; continue; }
        let line = spec.line ? lineStr(m.line) : null;
        if (spec.neg && outcome === "away") line = lineStr(-Number(line));
        const key = keyOf(match.id, spec.market, outcome, line);
        if (known.has(key) || linesHas(match, spec.market, outcome, line)) odds[key] = o.odd;
        else unknown++;
      }
    }
    return { odds, unknown };
  }

  /* Eşleşen maçların oranları. Eşleşme var ama hiçbirinden bilinen pazar çıkmadıysa (pazar kodları değişmiş) biçim hatası:
     çağıran eski otomatik oranlara dokunmaz. */
  function collect(pairs, sport) {
    const perMatch = [];
    let nOdds = 0, unknown = 0;
    for (const { ev, match } of pairs || []) {
      const o = oddsFor(ev, match, sport);
      nOdds += Object.keys(o.odds).length;
      unknown += o.unknown;
      perMatch.push({ match, odds: o.odds });
    }
    if (perMatch.length && !nOdds && unknown) return FORMAT_ERROR;
    return { ok: true, perMatch, nOdds, unknown };
  }

  function parseKey(key) {
    const parts = String(key).split("|");
    if (parts.length < 4) return null;
    const line = parts.pop(), outcome = parts.pop(), market = parts.pop();
    return { id: parts.join("|"), market, outcome, line: line === "" ? null : Number(line) };
  }
  const IDX = { home: 0, draw: 1, away: 2 };
  const SHORT = { home: "1", draw: "X", away: "2" };
  const hcap = (h) => (h > 0 ? `${h}:0` : `0:${-h}`);
  const r4 = (x) => Math.round(x * 10000) / 10000;
  const signed = (x) => `${x > 0 ? "+" : ""}${x}`;

  /* data.json'da olmayan (iddaa'nın getirdiği) seçenekler: futbol 3 yollu handikap, NBA'de Odds API dışı çizgi.
     Alanlar options[] ile aynı + extra: true; NBA ek çizgisi model olasılığıdır, piyasa yok → unverified: true. */
  function extraOptions(match, keys) {
    const known = new Set((match.options || []).map((o) => o.key));
    const L = match.lines;
    const out = [];
    for (const key of keys || []) {
      if (known.has(key) || !L) continue;
      const k = parseKey(key);
      if (!k || k.line == null || !Number.isFinite(k.line)) continue;
      let o = null;
      if (k.market === "handicap3" && L.handicap3 && L.handicap3[lineStr(k.line)] && k.outcome in IDX) {
        const row = L.handicap3[lineStr(k.line)], i = IDX[k.outcome], tag = hcap(k.line);
        o = { label: `HMS${SHORT[k.outcome]} (${tag})`,
          pick: k.outcome === "draw" ? `Beraberlik (${tag})` : `${k.outcome === "home" ? match.home : match.away} (${tag}) kazanır`,
          prob: row.prob[i], market_prob: row.market ? row.market[i] : null, model_prob: row.model ? row.model[i] : null };
      } else if (match.sport === "basketball" && k.market === "spreads" && L.spreads && (k.outcome === "home" || k.outcome === "away")) {
        const p = L.spreads[k.outcome === "home" ? lineStr(k.line) : lineStr(-k.line)];
        if (p != null) {
          const q = r4(k.outcome === "home" ? p : 1 - p), team = k.outcome === "home" ? match.home : match.away;
          o = { label: `${team} ${signed(k.line)}`, pick: `${team} ${signed(k.line)}`, prob: q, market_prob: null, model_prob: q, unverified: true };
        }
      } else if (match.sport === "basketball" && k.market === "totals" && L.totals && (k.outcome === "over" || k.outcome === "under")) {
        const p = L.totals[lineStr(k.line)];
        if (p != null) {
          const q = r4(k.outcome === "over" ? p : 1 - p), label = `${k.outcome === "over" ? "Üst" : "Alt"} ${k.line}`;
          o = { label, pick: label, prob: q, market_prob: null, model_prob: q, unverified: true };
        }
      }
      if (!o || !(o.prob > 0)) continue;
      out.push({ key, market: k.market, outcome: k.outcome, line: k.line, ...o,
        fair: Math.round(100 / o.prob) / 100, price: null, addable: true, extra: true });
    }
    return out;
  }

  /* Çekme zamanı geldi mi: spor hiç denenmediyse ya da son deneme 2 saatten eskiyse. */
  function due(status, sport, nowMs) {
    const t = status && status[sport] && Date.parse(status[sport].lastTry);
    return !Number.isFinite(t) || nowMs - t >= EVERY_MS;
  }

  return { MARKETS, url, parse, match, oddsFor, collect, extraOptions, due, parseKey };
})();

if (typeof module !== "undefined") module.exports = Bulletin;
