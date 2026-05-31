// (C) Pluto's Terminal — phone/web companion service worker (Phase 5).
// Its whole job is push-when-closed: receive a Web Push and show a notification
// even when the page/tab is closed, and focus/open the page when it's tapped.
// (No offline caching yet — xterm still loads from a CDN; vendoring it is a
// follow-up.) Served at root scope by companion.rs so it controls the page.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = { title: "Pluto Remote", body: "A session finished" };
  try { if (event.data) data = event.data.json(); } catch { /* keep default */ }
  event.waitUntil(
    self.registration.showNotification(data.title || "Pluto Remote", {
      body: data.body || "",
      tag: "pluto-finish",
      renotify: true,
      data: { url: "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
