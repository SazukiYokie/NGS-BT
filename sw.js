// NGS-HUB service worker
//  - app shell (index.html, icons): network-first with a 4 s fallback to the saved copy, so updates appear at once but a bad
//    connection never leaves a blank screen;
//  - third-party libraries, styles and fonts (Tailwind, Font Awesome, KaTeX, Firebase modules, Google Fonts…): kept in a
//    separate cache so the whole app can start with NO internet;
//  - Firebase / Firestore / Auth / AI API calls are never touched (the Firestore SDK has its own offline cache).
const CACHE_NAME = 'ngs-hub-v31';
const LIBS = 'ngs-libs-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './logo.png',
  './icon-192.png',
  './icon-512.png'
];
const LIB_URLS = [
  'https://cdn.tailwindcss.com/',
  'https://fonts.googleapis.com/css2?family=Kantumruy+Pro:ital,wght@0,300..700;1,300..700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/contrib/auto-render.min.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'
];
const LIB_HOSTS = new Set([
  'cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'tessdata.projectnaptha.com'
]);

function isApi(url) {
  const h = url.hostname;
  if (h === 'fonts.googleapis.com') return false; // Google Fonts CSS is a library, not an API
  return (
    h.includes('googleapis.com') ||
    h.includes('firebase') ||
    h.includes('groq.com') ||
    h.includes('openrouter.ai') ||
    h.includes('pollinations.ai') ||
    h.includes('generativelanguage')
  );
}
function isLib(url) {
  if (!LIB_HOSTS.has(url.hostname)) return false;
  if (url.hostname === 'www.gstatic.com') return url.pathname.startsWith('/firebasejs/');
  return true;
}
// URLs that name an exact version never change, so they can be served straight from the cache
const isPinned = url => /\/\d+\.\d+\.\d+(\/|$)|@\d+\.\d+\.\d+|\.(woff2?|ttf)$/i.test(url.pathname);

async function precache(cache, u) {
  try { if (await cache.match(u)) return; } catch (e) {}
  try { const r = await fetch(u, { mode: 'cors' }); if (r.ok) { await cache.put(u, r); return; } } catch (e) {}
  try { const r = await fetch(u, { mode: 'no-cors' }); await cache.put(u, r); } catch (e) {}
}
const within = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const shell = await caches.open(CACHE_NAME);
    await Promise.allSettled(ASSETS.map(url => shell.add(url)));
    const libs = await caches.open(LIBS);
    await within(Promise.allSettled(LIB_URLS.map(u => precache(libs, u))), 25000);
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME && key !== LIBS).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

// The page tells us which library/font URLs it actually loaded (fonts, KaTeX fonts, Firebase chunks…); keep them too.
self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.t !== 'warm' || !Array.isArray(d.urls)) return;
  event.waitUntil((async () => {
    const libs = await caches.open(LIBS);
    for (const u of d.urls.slice(0, 120)) {
      let url; try { url = new URL(u); } catch (e) { continue; }
      if (!isLib(url)) continue;
      await precache(libs, u);
    }
  })());
});

async function libFetch(req, url) {
  const cache = await caches.open(LIBS);
  let hit = await cache.match(req);
  // an opaque copy cannot answer a CORS request (module imports); fetch it again instead
  if (hit && hit.type === 'opaque' && req.mode === 'cors') hit = null;
  const net = () => fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  if (hit) {
    if (!isPinned(url)) net().catch(() => {}); // stale-while-revalidate for un-versioned files such as Tailwind
    return hit;
  }
  return net();
}

async function shellFetch(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = (await cache.match(req)) || (await cache.match('./index.html')) || (await cache.match('./'));
  const net = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  if (!cached) return net;
  return Promise.race([net, new Promise(r => setTimeout(() => r(cached), 4000))]).catch(() => cached);
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isApi(url)) return;

  if (isLib(url)) {
    event.respondWith(libFetch(req, url).catch(() => Response.error()));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML/navigation so GitHub Pages updates appear immediately
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(shellFetch(req));
    return;
  }

  // Cache-first with network fallback for the app's own static files (icons, manifest…)
  event.respondWith(
    caches.match(req).then(cached => {
      return cached || fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
