/* Maç Analiz — masaüstü düzeni (≥ 1024 px). Mobil düzen (< 1024 px) bu dosyaya hiç girmez.
   Desktop.layoutFor DOM'suz karar fonksiyonu (tests/js/desktop_test.html); kenar çubuğu çizimi app.js globallerini kullanır
   (h, icon, state, DATA, …) ve sadece app.js yüklendikten sonra çağrılır. */
"use strict";

const Desktop = (() => {
  const SPLIT = new Set(["today", "match"]);

  /* Yönlendirme kararı. route: resolveRoute sonucu ({view, id?}); wide: ekran ≥ 1024 px; firstId: seçili gün/sporun ilk maçı.
     layout: mobile (eski tek sütun) | split (liste + sağda detay) | full (orta + sağ alan tek sayfa).
     Bugün açılınca ilk maç seçilir ve adres #/mac/<id> olur (replaceHash; geçmişe yeni kayıt eklenmez).
     Bilinmeyen maç id'si (eski paylaşım linki) olduğu gibi kalır: detay "bulunamadı" der, başka maça atlanmaz.
     tab: bölünmüş görünümde ortada hep Bugün listesi var, menüde Bugün seçili (Değerli'den açılan maçta da). */
  function layoutFor(route, wide, firstId) {
    if (!wide) return { layout: "mobile", detailId: null, replaceHash: null };
    if (!SPLIT.has(route.view)) return { layout: "full", detailId: null, replaceHash: null };
    if (route.view === "match") return { layout: "split", detailId: route.id, replaceHash: null, tab: "bugun" };
    return { layout: "split", detailId: firstId || null, replaceHash: firstId ? `#/mac/${encodeURIComponent(firstId)}` : null,
      tab: "bugun" };
  }

  /* Kupon toplam oranı (Kuponum ekranıyla aynı: oranı bilinmeyen seçim 1 sayılır). Boş kupon → null. */
  function kuponTotal(prices) {
    if (!prices.length) return null;
    return prices.reduce((a, p) => a * (Number.isFinite(p) && p > 0 ? p : 1), 1);
  }

  /* ---------- kenar çubuğu (DOM'lu; app.js globallerini kullanır: h, sec, card, state, DATA, legPrice, odds, fmtStamp, Value) ---------- */
  let lastTab = "bugun";
  function valueCount() {
    if (!DATA || !DATA.value) return 0;
    return Value.build(DATA.value.picks, state.iddaa, (id) => (byId.get(id) || {}).match, new Date()).rows.length;
  }
  function navLinks(active) {
    const counts = { degerli: valueCount(), kupon: state.kupon.length };
    return [...document.querySelectorAll(".tabbar a[data-tab]")].map((a) => {
      const c = a.cloneNode(true); // aynı ikonlar ve adresler
      c.querySelectorAll(".count").forEach((x) => x.remove());
      if (c.dataset.tab === active) c.setAttribute("aria-current", "page"); else c.removeAttribute("aria-current");
      const n = counts[c.dataset.tab];
      if (n) c.append(h("span", { class: "sb-count", "aria-label": c.dataset.tab === "kupon" ? `${n} seçim` : `${n} seçenek` }, n));
      return c;
    });
  }
  function kuponBox() {
    const legs = state.kupon;
    if (!legs.length) {
      return sec("Kuponum", h("div", { class: "card pad sb-empty" },
        h("p", {}, "Kupon boş."), h("p", { class: "muted" }, "Bir maçın detayından seçim ekle ya da önerilen kuponlara bak.")));
    }
    const total = kuponTotal(legs.map((l) => legPrice(l)));
    return sec("Kuponum", card(
      legs.map((l) => h("div", { class: "sb-leg row" },
        h("div", { class: "sb-leg-info" }, h("span", { class: "sb-pick" }, l.pick), h("small", {}, l.match)),
        h("span", { class: "sb-odds" }, odds(legPrice(l))))),
      h("div", { class: "sb-total row" }, h("span", {}, "Toplam oran"), h("b", { class: "num" }, odds(total))),
      h("div", { class: "sb-open" }, h("a", { class: "btn primary block", href: "#/kupon" }, "Kuponu aç"))));
  }
  function footer() {
    const u = (DATA && DATA.odds_updated) || {}, q = DATA && DATA.odds_quota;
    const line = (label, t) => h("span", {}, `${label}: `, t ? h("time", { datetime: t }, fmtStamp(t)) : "yok");
    return h("div", { class: "sb-foot foot" },
      h("span", { class: "sb-foot-h" }, "Oranların son güncellemesi"),
      line("Futbol", u.football), line("NBA", u.basketball),
      q && q.remaining != null ? h("span", {}, `Odds API: ${q.remaining} kredi kaldı`) : null);
  }
  function renderSide(root, activeTab) {
    if (activeTab) lastTab = activeTab;
    if (!root || root.hidden || !DATA) return;
    root.replaceChildren(
      h("a", { class: "brand sb-brand", href: "#/", "aria-label": "Maç Analiz" },
        h("span", { class: "brand-mark", "aria-hidden": "true" }, icon("trend", 18, 2.4)),
        h("span", { class: "brand-name", "aria-hidden": "true" }, "MAÇ ANALİZ")),
      h("nav", { class: "sb-nav", "aria-label": "Bölümler" }, navLinks(lastTab)),
      kuponBox(),
      footer());
  }

  return { layoutFor, kuponTotal, renderSide };
})();
