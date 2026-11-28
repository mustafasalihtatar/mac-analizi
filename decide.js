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
  /* %90 ve üstü olasılıklı uç çizgiler (Alt 6.5 gibi) "en iyi" listesinde gösterilmez: oranı ~1,05, oynamaya değmez (2026-11-27). */
  const EXTREME = 0.9;
  function bestOptions(m, ctx, sort, n) {
    const rows = rated(m, ctx).filter((r) => r.prob < EXTREME - EPS);
    const odds = (r) => r.price ?? r.option.price ?? 0;
    const noIddaa = (x, y) => (x.price == null) - (y.price == null); // iddaa oranı olmayanlar her sıralamada sona
    const cmp = sort === "prob" ? (x, y) => y.prob - x.prob
      : sort === "odds" ? (x, y) => noIddaa(x, y) || odds(y) - odds(x) || y.prob - x.prob
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

  /* ---------- §40 Aşama 2: maç detayı metinleri (DOM'suz) ---------- */
  const fx = (x, d) => Number(x).toFixed(d).replace(".", ",");
  const signed1 = (x) => (x > 0 ? "+" : x < 0 ? "−" : "±") + fx(Math.abs(x), 1);
  const pctInt = (p) => `%${Math.round(p * 100)}`;
  const pctOne = (p) => `%${fx(p * 100, 1).replace(/,0$/, "")}`;
  const signedPct = (x) => `${x > 0 ? "+" : x < 0 ? "−" : ""}%${fx(Math.abs(x) * 100, 1).replace(/,0$/, "")}`;

  /* "#/mac/" sonrası: "<id>" özet, "<id>/tum" tüm seçenekler. id encodeURIComponent'li ("/" içermez). */
  function parseMatchPath(rest) {
    const all = rest.endsWith("/tum");
    return { raw: all ? rest.slice(0, -4) : rest, all };
  }
  /* Üst kartta "14. · 12 puan": info.table'da takımın satırı (info.<side>_src adıyla); yoksa null. */
  function rankText(info, side) {
    const t = info && info.table, src = info && info[`${side}_src`];
    const r = t && src && t.find((x) => x["Takım"] === src);
    return r ? `${r["Sıra"]}. · ${r.P} puan` : null;
  }
  /* 1-X-2 barı: %12 ve üstü parçanın içinde yüzde; daha darında içi boş, alttaki adın yanında yüzde. */
  const BAR_MIN = 0.12;
  function barLabels(probs, names) {
    return probs.map((p, i) => ({ inside: p >= BAR_MIN ? pctInt(p) : "", below: p >= BAR_MIN ? names[i] : `${names[i]} ${pctInt(p)}` }));
  }
  /* Üst karttaki 3 kutu: [{label, big, small|null}]. Futbol: en olası skor (+2 alternatif), beklenen gol, eksikler.
     NBA: beklenen fark, toplam sayı, eksikler (resmi rapor). */
  function tiles(m) {
    const e = m.expected || {};
    if (m.sport === "basketball") {
      const j = m.nba_info && m.nba_info.injuries;
      const ok = !!j && j.status !== "no_report";
      const n = (s) => (j && j[s] ? j[s].length : 0);
      return [{ label: "Beklenen fark", big: e.margin == null ? "–" : signed1(e.margin), small: "ev sahibi" },
        { label: "Toplam sayı", big: e.total == null ? "–" : fx(e.total, 1), small: "uzatmalar dahil" },
        { label: "Eksikler", big: ok ? `${n("home")} · ${n("away")}` : "–",
          small: !ok ? "rapor yok" : j.effect ? `fark etkisi ${signed1(j.effect)}` : "etki yok" }];
    }
    const ts = (m.stats && m.stats.top_scores) || [];
    const sc = (s) => s.replace("-", "–");
    const j = m.injuries;
    const miss = (s) => (j && j[s] ? j[s].missing.length : 0);
    const hit = j ? (miss("home") > miss("away") ? m.home : miss("away") > miss("home") ? m.away : null) : null;
    return [{ label: "En olası skor", big: ts.length ? sc(ts[0].score) : "–", small: ts.length > 1 ? ts.slice(1, 3).map((t) => sc(t.score)).join(" · ") : null },
      { label: "Beklenen gol", big: e.home == null ? "–" : `${fx(e.home, 1)}–${fx(e.away, 1)}`, small: e.home == null ? null : `toplam ${fx(e.home + e.away, 1)}` },
      { label: "Eksikler", big: j ? `${miss("home")} · ${miss("away")}` : "–", small: !j ? "veri yok" : hit ? `${hit} etkilenir` : "denk" }];
  }
  /* KARAR kartının metinleri. auto: otomatik iddaa çekme açık mı (oran yoksa nedeni). */
  const BADGES = { play: ["Oynanabilir", "good"], close: ["Yakın ama eksi", "warn"], skip: ["iddaa'da oynama", "bad"],
    none: ["iddaa oranı yok", "muted"], minor: ["Doğrulanmamış model", "muted"], started: ["Maç başladı", "muted"] };
  function verdictView(v, auto) {
    const [badge, kind] = BADGES[v.band];
    const base = { badge, kind, boxes: null, note: null };
    if (v.band === "started") return { ...base, text: "Maç başladı; iddaa'nın canlı oranı sitede yok, karar verilmez." };
    if (v.band === "minor") return { ...base, text: "Bu ligde sadece kendi modelimiz var ve doğrulanmadı; iddaa değeri hesaplanmaz.",
      note: "iddaa oranını Tüm seçenekler'de yazarsan gereken olasılığı görürsün." };
    if (v.band === "none") return { ...base, text: "Bu maç için iddaa oranı bulunamadı.",
      note: `${auto ? "Bülten bu maçı henüz açmamış olabilir." : "Otomatik iddaa çekme kapalı."} Oranı elle girebilirsin:` };
    const pick = v.option.pick;
    return { ...base,
      text: v.band === "play" ? `En iyi seçenek ${pick}; iddaa oranı yeterli.`
        : v.band === "close" ? `En iyi seçenek ${pick}; iddaa oranı biraz düşük.` : `En iyi seçenek bile ${pick}; iddaa oranı çok düşük.`,
      boxes: [{ label: "Bizim", value: pctInt(v.prob) }, { label: "Gereken", value: pctOne(v.required) },
        { label: `iddaa ${fx(v.price, 2)}`, value: signedPct(v.ev), good: v.band === "play" }],
      note: v.band === "play" ? `Oran ${fx(v.breakEven, 2)} altına düşerse değer kalmaz.` : `Oran ${fx(v.breakEven, 2)} ve üstüne çıkarsa artıya geçer.` };
  }

  /* ---------- §40 Aşama 3: Değerli ---------- */
  /* Value.build satırları iki bölüme: play = iddaa değeri ≥ +%2 (eşik altı "below" satırlar dahil: iddaa'da değerli);
     rest = modelin ayrıldığı (listedeki) ama iddaa'nın karşılamadığı ya da iddaa oranı olmayanlar. Sıra Value.build'inki. */
  function valueSections(rows) {
    const play = [], rest = [];
    for (const r of rows || []) {
      if (r.ev != null && r.ev >= PLAY - EPS) play.push(r);
      else if (!r.below) rest.push(r);
    }
    return { play, rest, anyIddaa: (rows || []).some((r) => r.iddaa != null) };
  }
  const signedInt = (x) => `${x > 0 ? "+" : x < 0 ? "−" : ""}%${Math.round(Math.abs(x) * 100)}`;
  /* Kart etiketleri: [{text, kind}] — kind: accent (model farkı) | plain | good | bad | warn. Renk her zaman yazıyla. */
  function valueTags(r) {
    const tags = [];
    if (r.diff != null) tags.push({ text: `Model ${r.diff > 0 ? "+" : "−"}${Math.round(Math.abs(r.diff) * 100)}`, kind: r.diff > 0 && !r.below ? "accent" : "plain" });
    if (r.iddaa != null) tags.push({ text: `iddaa ${fx(r.iddaa, 2)}`, kind: "plain" });
    else if (r.price != null) tags.push({ text: `yurtdışı ${fx(r.price, 2)}`, kind: "plain" });
    if (r.ev != null) tags.push({ text: signedInt(r.ev), kind: r.ev >= PLAY - EPS ? "good" : "bad" });
    if (r.sport !== "basketball" && r.market === "totals" && r.outcome === "under") tags.push({ text: "Alt eğilimi ⚠", kind: "warn", under: true });
    if (r.minor) tags.push({ text: "doğrulanmamış", kind: "plain" });
    return tags;
  }
  /* Takip özeti tek satır: sonuçlanan, tuttu %, birim kazanç; kayıt yoksa null. */
  function trackSummary(t) {
    if (!t || !t.settled) return null;
    return { settled: t.settled, hit: t.hit_rate == null ? "–" : pctInt(t.hit_rate), roi: t.roi == null ? "–" : signedPct(t.roi),
      roiGood: t.roi != null ? t.roi > 0 : null, reliable: !!t.reliable };
  }

  /* ---------- §40 Aşama 5: Ayarlar, Geçmiş, Performans ---------- */
  const DAY_MS = 86400000;
  /* Son yedek: metin + uyarı (hiç yok ya da 7 günden eski). */
  function backupState(lastIso, now) {
    const t = lastIso ? Date.parse(lastIso) : NaN;
    if (!Number.isFinite(t)) return { text: "henüz yok", warn: true };
    const days = Math.floor((now - t) / DAY_MS);
    return { text: days <= 0 ? "bugün" : days === 1 ? "dün" : `${days} gün önce`, warn: days > 7 };
  }
  /* Sürüm: yayın damgası (YYYYMMDDhhmmss) → "20261127"; yerelde "dev". */
  const versionText = (v) => (!v || v === "dev" ? "geliştirme" : String(v).slice(0, 8));
  /* Geçmiş kuponları: live = sonuçlanmamış ve en az bir seçimi başlamış; waiting = sonuçlanmamış, hiçbiri başlamamış;
     done = sonuçlanmış (tuttu/yattı/iade). settle(c) → {status}. */
  function splitCoupons(coupons, settle, now) {
    const first = (c) => Math.min(...c.legs.map((l) => Date.parse(l.kickoff)).filter(Number.isFinite));
    const live = [], waiting = [], done = [];
    for (const c of coupons || []) {
      const st = settle(c).status;
      if (st !== "pending") done.push(c);
      else if (c.legs.some((l) => Date.parse(l.kickoff) <= now)) live.push(c);
      else waiting.push(c);
    }
    live.sort((a, b) => first(a) - first(b));
    waiting.sort((a, b) => first(a) - first(b));
    done.sort((a, b) => Date.parse(b.playedAt) - Date.parse(a.playedAt));
    return { live, waiting, done };
  }
  /* "Değerli seçenekler kazandırıyor mu?" — takip özeti (yurtdışı oranla). Kayıt yoksa null. */
  function valueQuestion(t) {
    if (!t || !t.settled) return null;
    const title = !t.reliable ? "Henüz belli değil" : t.roi > 0 ? "Şimdilik evet" : "Şimdilik hayır";
    const weak = (t.groups || []).filter((g) => g.settled >= 10 && g.roi != null && g.roi < 0).map((g) => g.group);
    return { title, big: t.roi == null ? "–" : signedPct(t.roi), good: t.roi != null && t.roi > 0,
      text: `${t.settled} seçenek sonuçlandı, tutma oranı ${t.hit_rate == null ? "–" : pctInt(t.hit_rate)}. Yurtdışı oranlarla ölçüldü.`
        + (weak.length ? ` Zayıf: ${weak.join(", ")}.` : "") };
  }
  /* "Model piyasadan iyi mi?" — futbol harmanı (canlı 200 maç), NBA harmanı (300 maç). */
  function modelQuestion(blend, nba) {
    const rows = [];
    let decided = false;
    if (blend) {
      const l = blend.live, n = l ? l.n : 0, goal = l ? l.min_n : 200;
      let text = !n ? "henüz sonuçlanan maç yok" : l.diff < 0 ? "model biraz önde" : l.diff > 0 ? "piyasa biraz önde" : "başa baş";
      if (blend.reverted_at) { text = "karar: piyasaya dönüldü"; decided = true; } else if (n >= goal) { text = "karar: harman sitede kaldı"; decided = true; }
      rows.push({ name: "Futbol", n: Math.min(n, goal), goal, text });
    }
    if (nba) {
      const done = !!nba.decided_at;
      if (done) decided = true;
      rows.push({ name: "NBA", n: done ? nba.need : Math.min(nba.n || 0, nba.need), goal: nba.need,
        text: done ? `karar: sitede ${nba.use_on_site ? "harman" : "piyasa"}` : "" });
    }
    if (!rows.length) return null;
    return { title: decided ? "Karar verildi" : "Henüz belli değil", rows, note: "Sayı dolunca site karar verir: model kötüyse piyasaya döner." };
  }
  /* "Favori ne sıklıkla kazandı?" */
  const favoriteQuestion = (p) => (p && p.n && p.favorite_hit != null ? { big: pctInt(p.favorite_hit), text: `${p.n} futbol maçı` } : null);
  /* "2'li kupon", "3'lü", "6'lı", "9'lu", "10'lu": son rakama göre ek (20 ve üstü kuponda yok). */
  const LI = ["lu", "li", "li", "lü", "lü", "li", "lı", "li", "li", "lu"];
  const legsName = (n) => `${n}'${LI[n % 10]}`;
  const VERDICT_TEXT = { model: ["Model haklı", "good"], market: ["Piyasa haklı", "bad"], equal: ["Berabere", "plain"] };

  /* §41 Tüm seçenekler tek satırı: {prob, required (1 ÷ oran | null), ev (değer | null), band (play|close|skip|none), src}.
     Değer sadece iddaa oranı varken ve seçenek türetilmiş / doğrulanmamış / diğer lig değilken hesaplanır. */
  /* ＋ düğmesi etkin mi: §41 korner sadece iddaa oranıyla kupona girer (yurtdışı oranla değil); diğerleri addable ya da diğer lig. */
  const canAdd = (o, iddaaPrice, minor) => (o.market.startsWith("corners_") ? iddaaPrice != null && iddaaPrice > 1 : !!(o.addable || minor));
  function rowView(o, price, flags) {
    const f = flags || {};
    const has = price != null && price > 1;
    const ev = has && !f.minor && !f.derived && !f.unverified ? o.prob * price - 1 : null;
    return { prob: o.prob, required: has ? 1 / price : null, ev, band: ev == null ? "none" : bandOf(ev), src: has ? "iddaa" : null };
  }
  /* Tüm seçenekler satır detayındaki kaynak etiketi (sütun başlığı her tabloda "Olasılık"): gösterilen olasılık neyin?
     "Model" (diğer lig, NBA'de piyasası olmayan iddaa çizgisi), "Piyasa" (§41 korner ve olasılığı piyasaya eşit her seçenek),
     aksi "Harman": §26-5 harman açıkken skor matrisi harmanın 1X2'sine göre ölçeklenir, alt/üst ve (türetilmiş) KG de kayar. */
  function optionSource(o, minor) {
    if (minor || o.unverified) return "Model";
    if (o.market.startsWith("corners_")) return "Piyasa";
    if (o.market_prob == null) return "Model";
    return Math.abs(o.prob - o.market_prob) < 0.0005 ? "Piyasa" : "Harman";
  }
  /* Tüm seçenekler ince başlığı: "Ev – Dep", saat metni, skor (bitti ya da canlı) ve durum. lv = Live.view ya da null. */
  function thinHead(m, lv, when) {
    const done = m.score != null;
    const score = done ? m.score : lv && lv.state !== "gone" && lv.score ? lv.score : null;
    const status = done ? "bitti" : !lv ? null : lv.state === "ended" ? (lv.certain ? "bitti (geçici)" : "muhtemelen bitti")
      : lv.state === "gone" ? "sonuç bekleniyor" : lv.state === "ht" ? lv.label : `canlı ${lv.label}`;
    return { teams: `${m.home} – ${m.away}`, when, score: score ? String(score).replace("-", "–") : null, status, live: !done && !!lv && (lv.state === "live" || lv.state === "ht") };
  }

  return { PLAY, CLOSE, EXTREME, BAND_TEXT, breakEven, bandOf, liveCount, isLive, headline, verdict, matchBand, bestOptions, daySummary,
    parseMatchPath, rankText, BAR_MIN, barLabels, tiles, verdictView, valueSections, valueTags, trackSummary,
    backupState, versionText, splitCoupons, valueQuestion, modelQuestion, favoriteQuestion, legsName, VERDICT_TEXT, rowView, canAdd, optionSource, thinHead };
})();

if (typeof module !== "undefined") module.exports = Decide;
