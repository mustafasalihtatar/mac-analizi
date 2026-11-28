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
      "2_48": { market: "corners_totals", line: true, out: { Alt: "under", "Üst": "over" } }, // §41 toplam korner (sadece piyasa çizgileri)
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

  /* Ad normalleştirme (matching/team_names.normalize ile aynı): aksan, büyük/küçük, noktalama ve FC/SK gibi ekler. */
  const TRANSLIT = { "ı": "i", "İ": "I", "ø": "o", "Ø": "O", "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ß": "ss", "æ": "ae", "Æ": "AE" };
  const STOP = new Set(["fc", "sk", "jk", "ac", "as", "cf", "bc", "ca", "sc", "afc", "cfc", "fk", "sv", "tsg", "vfb", "vfl",
    "rc", "fsv", "1", "04", "05"]);
  function normName(s) {
    let x = String(s).replace(/[ıİøØłŁđĐßæÆ]/g, (c) => TRANSLIT[c]).replace(/\//g, " ");
    x = x.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ");
    x = x.replace(/[-.]/g, " ").replace(/[^a-z0-9 ]+/g, "");
    return x.split(/\s+/).filter((w) => w && !STOP.has(w)).join(" ");
  }
  // tek başına takımı ayırt etmeyen kelimeler (Real Madrid / Real Sociedad)
  const GENERIC = new Set(["real", "united", "city", "club", "sporting", "athletic", "atletico", "inter", "olympique",
    "racing", "union", "borussia", "deportivo", "town", "sport", "spor", "the", "and", "saint", "san", "los", "angeles"]);
  /* iddaa adı bizim adla uyuyor mu: normalleştirilmiş adlar aynı ya da ≥ 4 harfli, genel olmayan ortak bir kelime var
     (ya da ≥ 5 harfli kelime ötekinin başı: Hamburg / Hamburger, Erzurum / Erzurumspor). */
  function nameFits(a, b) {
    const x = normName(a), y = normName(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const xs = x.split(" ").filter((w) => !GENERIC.has(w)), ys = y.split(" ").filter((w) => !GENERIC.has(w));
    return xs.some((u) => ys.some((v) => (u.length >= 4 && u === v)
      || (Math.min(u.length, v.length) >= 5 && (u.startsWith(v) || v.startsWith(u)))));
  }
  const FALLBACK_TOL_MS = 15 * 60 * 1000;

  /* Eşleme: lig haritada ve bu sporsa; iki takım id'si haritada; bizim maçta adlar birebir aynı, saat farkı ≤ 2 sa.
     Yedek (2026-11-27): takımlardan biri haritada yoksa maç ancak saat farkı ≤ 15 dk, haritadaki taraf birebir, haritada
     olmayan taraf adla uyuyor (nameFits; ad haritada başka id'ye bağlı değil) ve tek aday varsa eşlenir (`guessed`); yeni
     id → ad `learned`'de döner (app.js bu cihazda hatırlar). Bir bizim maça iki iddaa maçı düşerse ya da aynı bizim ada iki iddaa id'si öğrenilecekse hepsi bırakılır.
     Eşleşmeyen takım ya da maç loglanır (ters ev/deplasman da eşleşmez).
     opts.live (canlı skor, 2026-11-27): iddaa'nın canlı akışı bazı liglerde (Süper Lig) bültendekinden farklı takım ve maç id'leri
     kullanıyor; haritadaki bülten id'si canlıda tutmaz. Canlıda yedek kural "ad haritada başka id'ye bağlı" koşulunu aramaz (saat,
     iki ad ve tek aday yine şart) ve haritada adı olan takımı öğrenmez (canlı id'si haritayı kirletmesin). */
  function match(events, ourMatches, map, sport, opts) {
    const live = !!(opts && opts.live);
    const pairs = [], teams = [], matches = [], seen = new Set();
    const comps = (map && map.comps) || {}, names = (map && map.teams) || {};
    const taken = new Set(Object.values(names));
    const guessed = new Map(); // bizim maç id → [{ev, match, learn}]
    const logTeams = (ev, home, away) => {
      for (const [id, name, known] of [[ev.homeId, ev.home, home], [ev.awayId, ev.away, away]]) {
        if (known == null && !seen.has(id)) { seen.add(id); teams.push({ id, name, comp: ev.compId }); }
      }
    };
    for (const ev of events || []) {
      if (comps[ev.compId] !== sport) continue;
      const home = names[ev.homeId], away = names[ev.awayId];
      if (home == null || away == null) {
        const side = (known, iddaaName, ours) => (known != null ? known === ours : (live || !taken.has(ours)) && nameFits(iddaaName, ours));
        const cands = (ourMatches || []).filter((x) => Math.abs(new Date(x.kickoff).getTime() - ev.kickoff) <= FALLBACK_TOL_MS
          && side(home, ev.home, x.home) && side(away, ev.away, x.away));
        if (cands.length === 1) {
          const m = cands[0], learn = {};
          if (home == null && !taken.has(m.home)) learn[ev.homeId] = m.home;
          if (away == null && !taken.has(m.away)) learn[ev.awayId] = m.away;
          if (!guessed.has(m.id)) guessed.set(m.id, []);
          guessed.get(m.id).push({ ev, match: m, learn, home, away });
        } else logTeams(ev, home, away);
        continue;
      }
      const m = (ourMatches || []).find((x) => x.home === home && x.away === away
        && Math.abs(new Date(x.kickoff).getTime() - ev.kickoff) <= KICKOFF_TOL_MS);
      if (m) pairs.push({ ev, match: m });
      else matches.push({ home, away, kickoff: new Date(ev.kickoff).toISOString() });
    }
    const learned = {};
    const paired = new Set(pairs.map((p) => p.match.id));
    const single = [];
    for (const [id, list] of guessed) {
      if (list.length > 1 || paired.has(id)) { for (const g of list) logTeams(g.ev, g.home, g.away); continue; }
      single.push(list[0]);
    }
    // aynı bizim ada iki farklı iddaa id'si öğrenilecekse o tahminlerin hepsi bırakılır
    const idsOf = new Map();
    for (const g of single) for (const [tid, name] of Object.entries(g.learn)) {
      if (!idsOf.has(name)) idsOf.set(name, new Set());
      idsOf.get(name).add(tid);
    }
    for (const g of single) {
      if (Object.values(g.learn).some((name) => idsOf.get(name).size > 1)) { logTeams(g.ev, g.home, g.away); continue; }
      pairs.push({ ev: g.ev, match: g.match, guessed: true });
      Object.assign(learned, g.learn);
    }
    return { pairs, learned, log: { teams, matches } };
  }

  /* Maçın iddaa oranı kaydedilebilecek seçenek anahtarları: data.json seçenekleri + §41 korner seçenekleri (corners.options). */
  const optionKeys = (match) => new Set([...(match.options || []), ...((match.corners && match.corners.options) || [])].map((o) => o.key));
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
    const known = optionKeys(match);
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

  return { MARKETS, url, parse, match, normName, nameFits, oddsFor, collect, extraOptions, due, parseKey, optionKeys };
})();

if (typeof module !== "undefined") module.exports = Bulletin;
