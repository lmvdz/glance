/**
 * glance service worker — installable shell + background Web Push.
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
	const title = d.title || "glance";
	e.waitUntil(
		// Completion pushes ("done:" tag namespace) go quiet when a glance window is
		// visible on this device — the operator is already looking at the live view,
		// and this stands in for the live-call beacon that was cut from the voice-loop
		// design: during a call the tab is normally visible, so "finished" toasts stay
		// silent here and still fire on any other (pocket) device. ESCALATIONS
		// (input/error — everything else) always show: "visible" does not mean the
		// operator is looking (an unfocused window on a second monitor still counts as
		// visible), and a suppressed "needs you" leaves an agent silently blocked —
		// review finding on the voice-loop branch. On matchAll failure, fail toward
		// notifying — never toward silence.
		(typeof d.tag === "string" && d.tag.indexOf("done:") === 0
			? self.clients
					.matchAll({ type: "window", includeUncontrolled: true })
					.then((cls) => cls.some((c) => c.visibilityState === "visible"))
					.catch(() => false)
			: Promise.resolve(false)
		)
			.then((visible) => {
				if (visible) return;
				return self.registration.showNotification(title, {
					body: d.body || "",
					tag: d.tag || "ompsq",
					data: { url: d.url || "/" },
					icon: "/icon-192.png",
					badge: "/icon-192.png",
					renotify: true,
				});
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
