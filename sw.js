// Service worker mínimo: permite instalar AlmaBet como app. No guarda nada en caché para que siempre veas datos al día.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
