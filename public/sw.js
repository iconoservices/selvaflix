importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');
console.log('🌴 SW Check: Script cargado (v2.44)');

const firebaseConfig = {
    apiKey: "AIzaSyCABaNkvUlMjBatNh0Giih01IDH4sNbt1Q",
    authDomain: "selvaflix-5d991.firebaseapp.com",
    projectId: "selvaflix-5d991",
    storageBucket: "selvaflix-5d991.firebasestorage.app",
    messagingSenderId: "935630160406",
    appId: "1:935630160406:web:171ecfcb9e4258628bab37"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
    console.log('[sw.js] Mensaje push recibido en background:', payload);
    const notificationTitle = payload.notification?.title || 'SelvaFlix';
    const notificationOptions = {
        body: payload.notification?.body || 'Nueva actualización',
        icon: '/icon_192.png',
        data: payload.data
    };
    self.registration.showNotification(notificationTitle, notificationOptions);
});

/* 
   🌊 Estrategia "Network First" Elite (v2.1): 
   1. Prioridad absoluta a la red (Fruta fresca).
   2. Respaldo inteligente en Caché (Conservas).
   3. Rescate Visual: Fallback para imágenes rotas.
   4. Blindaje contra Opaque Responses (CORS).
*/

const CACHE_NAME = 'selvaflix-cache-v2.44';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/icon_192.png',
    '/icon_512.png',
    '/favicon.png'
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
    // 🚨 REMOVED self.skipWaiting() here to prevent infinite reload loops on iOS
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

                return new Response('La selva está temporalmente inaccesible. 🌴⛈️', {
                    status: 503,
                    statusText: 'Service Unavailable',
                    headers: new Headers({ 'Content-Type': 'text/plain; charset=utf-8' })
                });
            })
    );
});

// Mensaje para forzar actualización (Skip Waiting)
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
