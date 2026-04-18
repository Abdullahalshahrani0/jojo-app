const CACHE = 'jojo-v2';
const STATIC = ['/', '/index.html', '/manifest.json', '/icon.svg'];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first for static, pass-through for API ───────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/subscribe') ||
      url.pathname.startsWith('/schedule') ||
      url.pathname.startsWith('/vapid-public-key') ||
      url.pathname.startsWith('/health')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Push: show notification + tell any open windows to play sound ─────────────
self.addEventListener('push', e => {
  let data = { title: 'JOJO 🍓', body: 'Hey Jomana! Time to reach out 🍓' };
  try { data = e.data.json(); } catch {}

  e.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/icon.svg',
        badge: '/icon.svg',
        vibrate: [150, 80, 150, 80, 300],
        data: { url: '/' },
      }),
      // If the app is already open, tell it to play the sound immediately
      self.clients.matchAll({ type: 'window' }).then(list =>
        list.forEach(c => c.postMessage({ type: 'PLAY_SOUND' }))
      ),
    ])
  );
});

// ── Notification click: focus/open app and play sound ────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // If a window is already open, focus it and tell it to play sound
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage({ type: 'PLAY_SOUND' });
          return client.focus();
        }
      }
      // Otherwise open the app with a flag so it plays sound on load
      return clients.openWindow('/?notify=1');
    })
  );
});
