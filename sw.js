// Lets the installed app open without internet. Saved apartments live in the browser's storage, so only the
// app's own files need keeping here. Registered from main.ts in the built version only.
//
// - The page and the rent check: the network first, so updates show up; the last copy when offline.
// - Built files in assets/ have a fingerprint in their names and never change, so the kept copy is used.
// - Everything else (map tiles, Firebase, map search) goes straight to the network, as before.

const CACHE = "apartment-hunter-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(["./", "./manifest.webmanifest", "./icons/icon-192.png"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const kept = (await cache.match(request, { ignoreSearch: true })) ?? (request.mode === "navigate" ? await cache.match("./") : undefined);
    if (kept) {
      return kept;
    }
    throw error;
  }
}

async function keptFirst(request) {
  const cache = await caches.open(CACHE);
  const kept = await cache.match(request);
  if (kept) {
    return kept;
  }
  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }
  if (request.mode === "navigate" || url.pathname.endsWith("/jsm-units.json")) {
    event.respondWith(networkFirst(request));
  } else if (url.pathname.includes("/assets/") || url.pathname.includes("/icons/")) {
    event.respondWith(keptFirst(request));
  }
});
