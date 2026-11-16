// Service worker: guarda a casca do app para ele abrir mesmo sem internet (o link fica guardado e vai depois).
// As chamadas ao GitHub nunca passam pelo cache.
'use strict';

const VERSAO = 'fila-v1';
const CASCA = ['./', 'index.html', 'app.js', 'estilo.css', 'manifest.webmanifest', 'icone-192.png', 'icone-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(CASCA)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// Rede primeiro (para pegar a versao nova), cache se estiver sem internet. So arquivos do proprio app.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp.ok && req.mode !== 'navigate') {
          const copia = resp.clone();
          caches.open(VERSAO).then((c) => c.put(req, copia));
        }
        return resp;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((r) => r || (req.mode === 'navigate' ? caches.match('./') : Response.error()))),
  );
});
