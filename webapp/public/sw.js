// omp-squad web-push service worker. Served from webapp/public/ (Vite copies to dist root).
// ponytail: minimal push display + focus-on-click. Note: the daemon's OMP_SQUAD_WEBAPP
// serve seam currently serves only "/" + "/assets/*", so to use push behind that flag
// the seam must also serve "/sw.js" (one-line follow-up in src/server.ts). Works under
// vite dev/preview today.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "omp-squad";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag,
      data: data.url ? { url: data.url } : undefined,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url;
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) return w.focus();
      }
      if (url && self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
