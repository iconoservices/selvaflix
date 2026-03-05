/* 
   🌊 Estrategia "Network First" Elite (v2.1): 
   1. Prioridad absoluta a la red (Fruta fresca).
   2. Respaldo inteligente en Caché (Conservas).
   3. Rescate Visual: Fallback para imágenes rotas.
   4. Blindaje contra Opaque Responses (CORS).
*/

const CACHE_NAME = 'selvaflix-cache-v2.1';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/icon_192.png',
    '/vite.svg'
];

const FALLBACK_IMAGE = '/icon_192.png'; // Nuestra imagen de rescate

// Install Event
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('🌴 Selva Cache v2.1: Armando mochila de supervivencia');
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
                        console.log('🧹 Selva: Quemando rastro de versiones antiguas');
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Fetch Event (Network First Strategy Refined)
self.addEventListener('fetch', (event) => {
    // Solo procesar peticiones GET
    if (event.request.method !== 'GET') return;

    // Detectar origen y destino
    const url = new URL(event.request.url);
    const isImage = event.request.destination === 'image';

    // EXCLUSIÓN: Datos en tiempo real (Firebase/TMDB) -> Siempre a la Red Directo (No cachear)
    if (url.origin.includes('firebase') || url.origin.includes('themoviedb.org')) {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                // ESTRATEGIA SELECTIVA: Solo guardamos en caché si status es 200 (OK).
                // Status 0 (Opaque Responses de dominios externos sin CORS) pasan directo sin ensuciar la caché.
                if (networkResponse && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            })
            .catch(async () => {
                // FALLBACK: La red ha caído. Buscamos en el búnker (Caché).
                const cachedResponse = await caches.match(event.request);
                if (cachedResponse) return cachedResponse;

                // RESCATE FINAL: Si no hay red ni caché, devolvemos una Response válida.

                // 1. Caso: Imagen (Portadas de películas que fallan)
                if (isImage) {
                    return caches.match(FALLBACK_IMAGE);
                }

                // 2. Caso: Fallo total (Evitamos el TypeError 'Failed to convert value to Response')
                return new Response('La selva está temporalmente inaccesible. 🌴⛈️', {
                    status: 503,
                    statusText: 'Service Unavailable',
                    headers: new Headers({ 'Content-Type': 'text/plain; charset=utf-8' })
                });
            })
    );
});
