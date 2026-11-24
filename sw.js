/* Maç Analiz — service worker (PWA). Tüm yollar bu dosyanın kapsamına göre (GitHub Pages: /mac-analizi/).
   VERSION her yayında `prepare_site` tarafından zaman damgasıyla değiştirilir ("dev" sadece yerelde).
   localStorage'a (kupon, geçmiş) dokunmaz; sadece Cache Storage kullanır. */
const VERSION = "20261124103326";
const APP_CACHE = `macanaliz-app-${VERSION}`;
const DATA_CACHE = "macanaliz-data";    // son data.json (sürümden bağımsız: yeni sürümde de çevrimdışı veri kalsın)
const LOGO_CACHE = "macanaliz-logos-v1"; // armalar değişmez, sürümler arasında korunur
const KEEP = new Set([APP_CACHE, DATA_CACHE, LOGO_CACHE]);
const DATA_TIMEOUT_MS = 4000;

const FONTS = ["archivo-latin", "archivo-latin-ext", "inter-latin", "inter-latin-ext"].map((f) => `fonts/${f}.woff2`);
const APP_FILES = ["./", "index.html", `style.css?v=${VERSION}`, `history.js?v=${VERSION}`, `iddaa.js?v=${VERSION}`, `value.js?v=${VERSION}`, `app.js?v=${VERSION}`,
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png",
  "icons/apple-touch-icon.png", ...FONTS];

const scoped = (path) => new URL(path, self.registration.scope).href;

self.addEventListener("install", (event) => {
  // HTTP önbelleğini atla: GitHub Pages dosyaları 10 dk önbellekte tutar, yeni sürüm eskiyle karışmasın
  event.waitUntil(caches.open(APP_CACHE).then((c) =>
    c.addAll(APP_FILES.map((f) => new Request(scoped(f), { cache: "reload" })))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("macanaliz-") && !KEEP.has(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

/* data.json: önce ağ (4 sn). Ağ yavaşsa ya da yoksa önbellektekini işaretli başlıkla döner; uygulama bandı gösterir. */
async function dataFirstNetwork(event) {
  const key = scoped("data.json");
  const cache = await caches.open(DATA_CACHE);
  const network = fetch(event.request).then(async (res) => {
    if (res.ok) await cache.put(key, res.clone());
    return res;
  });
  event.waitUntil(network.catch(() => null)); // geç gelen yanıt da önbelleğe yazılsın
  const marked = async (state) => {
    const cached = await cache.match(key);
    if (!cached) return null;
    const headers = new Headers(cached.headers);
    headers.set("X-Macanaliz-Cache", state);
    return new Response(cached.body, { status: 200, statusText: "OK", headers });
  };
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), DATA_TIMEOUT_MS); });
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== "timeout") {
      if (first.ok) return first;
      return (await marked("offline")) || first; // sunucu hatası: elde ne varsa
    }
    return (await marked("slow")) || (await network); // önbellek yoksa ağı beklemeye devam
  } catch {
    return (await marked("offline")) || Response.error();
  } finally {
    clearTimeout(timer);
  }
}

/* Armalar: ilk görüldüğünde önbelleğe, sonra hep önbellekten. */
async function logoCacheFirst(request) {
  const cache = await caches.open(LOGO_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

/* Uygulama dosyaları: önce önbellek (sürüm önbelleği), yoksa ağ. Sayfa açılışı çevrimdışıyken index.html. */
async function appCacheFirst(request) {
  const cache = await caches.open(APP_CACHE);
  if (VERSION === "dev") { // yerelde (yayınlanmamış şablon) önce ağ: düzenlenen dosyalar hemen görünsün
    try { return await fetch(request, { cache: "no-store" }); } catch { /* sunucu kapalı: önbellekten */ }
  }
  if (request.mode === "navigate") {
    const page = await cache.match(scoped("index.html"));
    if (page) return page;
    return fetch(request);
  }
  const hit = await cache.match(request);
  if (hit) return hit;
  return fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  const path = url.href.slice(self.registration.scope.length).split(/[?#]/)[0];
  if (path === "data.json") event.respondWith(dataFirstNetwork(event));
  else if (path.startsWith("logos/")) event.respondWith(logoCacheFirst(request));
  else if (path !== "sw.js") event.respondWith(appCacheFirst(request));
});
