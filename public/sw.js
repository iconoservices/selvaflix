/* 
   🌊 Estrategia "Network First": 
   Priorizamos siempre la fruta fresca del árbol (datos de la red). 
   Si el árbol está seco (sin internet), sacamos las conservas de la mochila (caché).
*/
const CACHE_NAME = 'selvaflix-cache-v1.3';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/icon_192.png',
    '/icon_512.png',
    '/vite.svg'
];

// Install Event
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('🌴 Selva Cache abierta');
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate Event
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        console.log('🧹 Limpiando cache antigua');
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Fetch Event (Network First Strategy)
self.addEventListener('fetch', (event) => {
    // Solo cachear peticiones GET
    if (event.request.method !== 'GET') return;

    // No cachear peticiones de Firebase o TMDB directo (usamos Network Only para datos frescos)
    const url = new URL(event.request.url);
    if (url.origin.includes('firebase') || url.origin.includes('themoviedb.org')) {
        return; // Dejar que el navegador maneje la peticion normalmente (Network Only)
    }

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                // Clonar y guardar en cache si la respuesta es valida
                if (networkResponse && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                // Si falla la red, intentar buscar en cache
                return caches.match(event.request).then((cachedResponse) => {
                    if (cachedResponse) return cachedResponse;

                    // Si no hay nada en cache y es una navegacion, podrías retornar un offline.html
                    // return caches.match('/offline.html');
                });
            })
    );
});
