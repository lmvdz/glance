/**
 * omp-squad service worker — installable shell + background Web Push.
 *
 * The shell is cached network-first (updates land immediately, offline falls
 * back to cache). /api and /ws are NEVER cached — they carry live, authed state.
 * `push` renders an escalation notification even when the app is closed; tapping
 * it focuses the app and deep-links to the agent that needs a human.
 */

const CACHE = "ompsq-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
	e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
	e.waitUntil(
		caches.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (e) => {
	const url = new URL(e.request.url);
	if (e.request.method !== "GET" || url.pathname.startsWith("/api") || url.pathname === "/ws") return;
	e.respondWith(
		fetch(e.request)
			.then((res) => {
				const copy = res.clone();
				caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
				return res;
			})
			.catch(() => caches.match(e.request).then((m) => m || caches.match("/"))),
	);
});

self.addEventListener("push", (e) => {
	let d = {};
	try {
		d = e.data ? e.data.json() : {};
	} catch {
		d = { body: e.data ? e.data.text() : "" };
	}
	const title = d.title || "omp-squad";
	e.waitUntil(
		self.registration.showNotification(title, {
			body: d.body || "",
			tag: d.tag || "ompsq",
			data: { url: d.url || "/" },
			icon: "/icon-192.png",
			badge: "/icon-192.png",
			renotify: true,
		}),
	);
});

self.addEventListener("notificationclick", (e) => {
	e.notification.close();
	const target = (e.notification.data && e.notification.data.url) || "/";
	e.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cls) => {
			for (const c of cls) {
				if ("focus" in c) {
					if ("navigate" in c) c.navigate(target).catch(() => {});
					return c.focus();
				}
			}
			return self.clients.openWindow(target);
		}),
	);
});
