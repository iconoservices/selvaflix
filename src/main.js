import './style.css'
import { SelvaStream } from './components/Player/Player.js'
import { ExportManager } from './utils/exportManager.js'
import './components/Player/Player.css'
import './ui/toasts.js' // 🍿 Notificaciones (define window.showToast)
// Firebase es nuestro Puesto de Vigilancia: mantiene un ojo en los datos
// y nos avisa al instante cuando algo cambia en la selva.
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection as fsCollection, onSnapshot as fsOnSnapshot, addDoc as fsAddDoc,
  deleteDoc as fsDeleteDoc, doc as fsDoc, updateDoc as fsUpdateDoc,
  setDoc, query, orderBy, limit, getDocs, getDoc, where
} from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getMessaging, getToken, onMessage } from "firebase/messaging"; // 🔔 FCM SDK
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "firebase/auth"; // 🔑 Auth SDK
import { createClient } from "@supabase/supabase-js"; // 🎬 Catálogo de películas (Firestore se quedó sin cuota, ver 2026-08-19)

// --- Firebase Configuration ---
// Sale de variables de entorno (VITE_FIREBASE_*) para poder desplegar este
// mismo repo en otro proyecto de Vercel apuntando a otra base de Firebase,
// sin tocar código — solo cambiando las env vars de ese Vercel. El valor
// después de "||" es el de SelvaFlix, así el deploy actual sigue andando
// igual aunque Vercel no tenga estas variables configuradas todavía.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyCABaNkvUlMjBatNh0Giih01IDH4sNbt1Q",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "selvaflix-5d991.firebaseapp.com",
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || "https://selvaflix-5d991-default-rtdb.firebaseio.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "selvaflix-5d991",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "selvaflix-5d991.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "935630160406",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:935630160406:web:171ecfcb9e4258628bab37",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-N4DRH9QPE3"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);
let messaging = null;
try {
  messaging = getMessaging(app);
} catch (e) {
  console.log('🔕 FCM no soportado en este navegador:', e.message);
}
const auth = getAuth(app); // 🚪 El guardián de la selva

// --- Supabase (catálogo de películas) ---
// Firestore se quedó sin cuota gratis (millones de lecturas/día leyendo el
// catálogo entero por sesión, ver 2026-08-19) — la colección "movies" se
// muda a Supabase, que cobra por ancho de banda y no por documento leído.
// Todo lo demás (Auth, usuarios, anuncios, push) se queda en Firebase.
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// Los ~38 lugares del código que hacían collection(db,"movies")/doc(db,"movies",id)
// /addDoc/updateDoc/deleteDoc/onSnapshot sobre la colección "movies" de Firestore
// NO se tocaron uno por uno (mucho riesgo de romper algo al copiar mal una
// variable). En cambio, collection/doc/addDoc/updateDoc/deleteDoc/onSnapshot se
// redefinen acá: cuando el pedido es sobre "movies" van a Supabase, para
// cualquier otra colección (users, reports, ads, etc.) siguen yendo a Firestore
// como siempre (fsCollection/fsDoc/etc., los nombres reales importados arriba).
const MOVIES_SENTINEL = Symbol('movies');
const MOVIE_PROMOTED_COLS = new Set(['id', 'tmdbId', 'imdbId', 'title', 'type', 'status']);

function supaRowToMovie(row) {
  return {
    id: row.id,
    tmdbId: row.tmdb_id || '',
    imdbId: row.imdb_id || '',
    title: row.title || '',
    type: row.type || '',
    status: row.status || 'healthy',
    ...(row.data || {})
  };
}

function movieToSupaRow(m) {
  const row = {
    tmdb_id: (m.tmdbId != null && m.tmdbId !== '') ? String(m.tmdbId) : null,
    imdb_id: m.imdbId || null,
    title: m.title || null,
    type: m.type || null,
    status: m.status || 'healthy',
    data: {}
  };
  for (const [k, v] of Object.entries(m)) {
    if (!MOVIE_PROMOTED_COLS.has(k)) row.data[k] = v;
  }
  return row;
}

// PostgREST corta en 1000 filas por pedido si no le decís lo contrario —
// con 1897 títulos (y creciendo) hace falta paginar con .range() hasta
// que una página vuelva con menos de PAGE_SIZE, o se pierden los últimos.
async function supaFetchAllMovieRows() {
  const PAGE_SIZE = 1000;
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from('movies').select('*').range(from, from + PAGE_SIZE - 1);
    if (error) { console.error('Error trayendo catálogo de Supabase:', error); break; }
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

async function supaAddMovie(movieData) {
  const row = movieToSupaRow(movieData);
  row.id = movieData.id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.random().toString(36).slice(2)}`);
  const { data: inserted, error } = await supabase.from('movies').insert(row).select('id').single();
  if (error) throw error;
  return { id: inserted.id };
}

// Mergea (no pisa) — igual que updateDoc de Firestore, que solo toca los
// campos que le pasás. Los campos "promovidos" (columnas reales) se actualizan
// directo; el resto se mergea adentro de "data" vía la función merge_movie_data
// (creada a mano en el SQL Editor de Supabase) para que sea atómico.
async function supaUpdateMovie(id, patch) {
  const cols = {};
  const dataPatch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'tmdbId') cols.tmdb_id = (v != null && v !== '') ? String(v) : null;
    else if (k === 'imdbId') cols.imdb_id = v;
    else if (k === 'title' || k === 'type' || k === 'status') cols[k] = v;
    else dataPatch[k] = v;
  }
  if (Object.keys(dataPatch).length > 0) {
    const { error } = await supabase.rpc('merge_movie_data', { p_id: id, p_patch: dataPatch });
    if (error) throw error;
  }
  if (Object.keys(cols).length > 0) {
    const { error } = await supabase.from('movies').update(cols).eq('id', id);
    if (error) throw error;
  }
}

async function supaDeleteMovie(id) {
  const { error } = await supabase.from('movies').delete().eq('id', id);
  if (error) throw error;
}

// Emula el onSnapshot de Firestore: primera entrega = snapshot.docs (catálogo
// completo), entregas siguientes = snapshot.docChanges() (uno por cambio en
// vivo vía Supabase Realtime). Requiere que la tabla "movies" tenga Replication
// activada en Supabase (Database → Replication) para las entregas en vivo — si
// no está activada, la carga inicial funciona igual, solo no llegan los cambios
// en vivo de otras pestañas/dispositivos hasta que se refresque el caché.
function supaOnSnapshotMovies(callback) {
  let cancelado = false;

  (async () => {
    const rows = await supaFetchAllMovieRows();
    if (cancelado) return;
    callback({ docs: rows.map(row => ({ id: row.id, data: () => supaRowToMovie(row) })) });
  })();

  const channel = supabase
    .channel('movies-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'movies' }, (payload) => {
      const tipo = payload.eventType === 'INSERT' ? 'added' : payload.eventType === 'DELETE' ? 'removed' : 'modified';
      const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
      if (!row) return;
      callback({
        docs: [],
        docChanges: () => [{ type: tipo, doc: { id: row.id, data: () => supaRowToMovie(row) } }]
      });
    })
    .subscribe();

  return () => { cancelado = true; supabase.removeChannel(channel); };
}

function collection(dbRef, path) {
  if (path === 'movies') return { [MOVIES_SENTINEL]: true };
  return fsCollection(dbRef, path);
}

function doc(dbRef, path, id) {
  if (path === 'movies') return { [MOVIES_SENTINEL]: true, id };
  return fsDoc(dbRef, path, id);
}

async function addDoc(colRef, data) {
  if (colRef && colRef[MOVIES_SENTINEL]) return await supaAddMovie(data);
  return await fsAddDoc(colRef, data);
}

async function updateDoc(ref, patch) {
  if (ref && ref[MOVIES_SENTINEL]) return await supaUpdateMovie(ref.id, patch);
  return await fsUpdateDoc(ref, patch);
}

async function deleteDoc(ref) {
  if (ref && ref[MOVIES_SENTINEL]) return await supaDeleteMovie(ref.id);
  return await fsDeleteDoc(ref);
}

function onSnapshot(refOrQuery, callback) {
  if (refOrQuery && refOrQuery[MOVIES_SENTINEL]) return supaOnSnapshotMovies(callback);
  return fsOnSnapshot(refOrQuery, callback);
}
const moviesCol = collection(db, "movies");

// --- iOS PWA / Notch Fallback Detection ---
/*
   Apple WebViews (Home Screen Web Apps) a menudo tienen bugs con env(safe-area-inset-top)
   y las media queries CSS de display-mode. Usamos JS nativo para forzar un parche perfecto.
*/
function applyIOSNotchFix() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isStandalone = window.navigator.standalone === true;
    
    if (isIOS && isStandalone) {
        console.log("🍎 Selva PWA: Detectado iPhone Instalado. Activando blindaje de Notch (45px) por JS.");
        document.body.classList.add('ios-pwa-standalone');
    }
}
applyIOSNotchFix();

// --- Service Worker Registration ---
/* 
   🧹 El "Conserje Invisible": Este pequeño script corre en segundo plano. 
   Su trabajo es asegurarse de que la app abra rápido y tenga comida (datos) incluso si cae un diluvio y se va el internet.
*/
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        console.log('🌴 Selva PWA: Service Worker Activo');

        // 🔥 FCM: Solicitar permisos al usuario y obtener Token Push
        if (!messaging) {
          console.log('🔕 FCM no disponible, omitiendo push notifications.');
          return;
        }
        Notification.requestPermission().then((permission) => {
          if (permission === 'granted') {
            console.log('🔔 Permiso de notificaciones concedido.');
            
            // Retraso intencional para asegurar que SW está bootado
            setTimeout(() => {
                getToken(messaging, { 
                  vapidKey: 'BLqkFCsqZCYKUOauIQND6XOWbiDBPKKebs9kNDBI5YRnhJ6WuOy2b1EUCKlv8xstA-1AkNOobOwPKDT8i34ZSwQ',
                  serviceWorkerRegistration: reg 
                }).then((currentToken) => {
                  if (currentToken) {
                    console.log('📨 Token FCM Obtenido:', currentToken);
                    // Guardar/Actualizar Token con setDoc (más robusto)
                    let userId = localStorage.getItem('selva_user_id');
                    if (!userId) {
                        userId = "USR_" + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
                        localStorage.setItem('selva_user_id', userId);
                    }
                    
                    setDoc(doc(db, "users", userId), { 
                        fcmToken: currentToken, 
                        lastActive: Date.now(),
                        platform: navigator.platform || 'Unknown' 
                    }, { merge: true }).then(() => {
                        console.log("✅ Usuario registrado para Push!");
                    }).catch(err => console.error("Error guardando token en BD", err));
                    
                  } else {
                    console.log('No token available. Request permission to generate one.');
                  }
                }).catch((err) => {
                  console.log('❌ Error obteniendo token FCM. ', err);
                });
            }, 1000); // 1s Espera de seguridad
          } else {
            console.log('🔕 Permiso de notificaciones denegado.');
          }
        });

        // 📬 FCM: Escuchar mensajes en primer plano (Foreground)
        if (messaging) {
          onMessage(messaging, (payload) => {
            console.log('[main.js] Mensaje recibido en Foreground ', payload);
            // Mostramos un Toast premium en vez de bloquear la pantalla con alert()
            const title = payload.notification?.title || "Nueva alerta";
            const body = payload.notification?.body || "";
            if (window.showToast) {
              window.showToast(`🔔 ${title} - ${body}`, "success");
            } else {
              console.log(`🔔 Notificación recibida: ${title} - ${body}`);
            }
          });
        }

        // Lógica de Actualización Manual (Botón) - AlDía Style
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // Nueva versión lista, pero esperando (hay otra versión controlando la página)
              const updateBtn = document.getElementById('pwa-update-toast');
              if (updateBtn) {
                updateBtn.style.display = 'block';
                updateBtn.onclick = () => {
                  updateBtn.innerText = "🔄 Actualizando...";
                  newWorker.postMessage({ type: 'SKIP_WAITING' });
                };
              }
            }
          });
        });
      })
      .catch(err => console.error('Error registrando SW:', err));

    // Refrescar página cuando el SW tome el control (después del skipWaiting)
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        // 🛑 CRÍTICO: Desactivamos el reload automático para detener bucles en Safari/iOS
        // window.location.reload();
        console.log('🔄 Nuevo SW ha tomado control. Actualiza para ver cambios.');
      }
    });
  });
}

// --- TMDB API Config ---
const TMDB_API_KEY = import.meta.env.VITE_TMDB_KEY || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
const TMDB_URL = 'https://api.themoviedb.org/3';
const TMDB_IMG_URL = 'https://image.tmdb.org/t/p/w500';

let movieDatabase = { trending: [] };
let heroPool = [];
let currentHeroIndex = 0;

// Editor de Episodios (Series/Anime): links manuales opcionales por capítulo
// puntual, clave "{temporada}-{episodio}" (ej. "1-1") → URL. Declarado acá
// arriba (no junto a sus funciones más abajo) porque openUploadDrawer,
// selectTMDBMovie y editMovie -- definidas antes en el archivo -- ya lo
// reasignan sin `let`; declararlo más abajo rompía esas referencias al
// empaquetar con Rollup/Terser (ReferenceError: not defined en producción).
let _currentEpisodesMap = {};
let _currentEpisodesSeasons = null;
// Se incrementa en cada llamada a loadEpisodesEditorSeasons y cada reset del
// drawer -- evita que una carga de TMDb vieja (más lenta) pise el resultado
// de una más nueva cuando se dispara sola al elegir un resultado de búsqueda
// Y el admin además aprieta "Cargar desde TMDb" a mano, o cuando cierra el
// drawer mientras el fetch sigue en vuelo.
let _epSeasonsRequestId = 0;
let heroTimer = null;
let currentPlayerMovie = null;
window._brokenIds = new Set();
let pendingSeeds = [];
// Eventos crudos del último rango cargado en Analíticas. Lo escribe
// loadMetrics (ahora en src/admin/analytics.js) y lo lee el modal de detalle
// de visitantes, que sigue acá — por eso viaja por window y no como variable
// de módulo. _dayChartMode y _dayChartBuckets se fueron con el módulo porque
// solo los usaba él.
window._lastMetricsData = window._lastMetricsData || [];
let deferredPrompt;

// --- Splash Screen Engine v2.40 ---
// --- Splash Screen Engine v2.40 🎬 ---
window.hideSplashScreen = (force = false) => {
  const splash = document.getElementById('splash-screen');
  if (splash) {
    // 🚀 DESBLOQUEO INTELIGENTE:
    const isProfileActive = localStorage.getItem('selva_active_profile');
    const isAuthModalOpen = document.getElementById('auth-modal')?.style.display === 'flex';
    const isProfileModalOpen = document.getElementById('profile-selector-modal')?.style.display === 'flex';

    if (force || isProfileActive || !auth.currentUser || isAuthModalOpen || isProfileModalOpen) {
      splash.style.opacity = '0';
      splash.style.pointerEvents = 'none'; 
      setTimeout(() => {
        splash.style.visibility = 'hidden';
      }, 800);
    }
  }
};

// Fallback de seguridad: Si en 5 segundos no se ha quitado, lo quitamos a la fuerza
setTimeout(() => window.hideSplashScreen(true), 5000);

// --- Notificaciones UI Premium (Toasts) ---
// 🍿 Movido a ./ui/toasts.js (define window.showToast). Ver import arriba.

// --- Data Loading System (15-Minute Cache) v4.2 ---
/* 
   🔗 El "Hilo de Ariadna": Mantenemos una conexión inteligente con la base de datos.
   Para evitar el sangrado de lecturas, servimos un caché de 15 minutos a los exploradores comunes.
*/
const yearSelect = document.getElementById('discover-year');
const mYearSelect = document.getElementById('m-year');
if (yearSelect || mYearSelect) {
  const currentYear = new Date().getFullYear();
  for (let i = currentYear; i >= 1980; i--) {
    if (yearSelect) yearSelect.insertAdjacentHTML('beforeend', `<option value="${i}">${i}</option>`);
    if (mYearSelect) mYearSelect.insertAdjacentHTML('beforeend', `<option value="${i}">${i}</option>`);
  }
}

async function loadSelvaFlixData() {
  const CACHE_KEY = 'selvaflix_full_database';
  const CACHE_TIME_KEY = 'selvaflix_cache_timestamp';
  // Bajado de 15 a 5 min: con localStorage (dura entre visitas) un admin
  // borrando/editando en una pestaña podía tardar hasta 15 min en verse
  // reflejado en cualquier otra pestaña/dispositivo con copia vieja.
  const CACHE_DURATION_MS = 5 * 60 * 1000;

  // 1. Revisar si hay un caché válido
  // localStorage (no sessionStorage): sobrevive a cerrar la pestaña, así una visita nueva
  // no vuelve a leer las 215 películas si alguien ya las trajo hace menos de 5 min.
  const cachedStored = localStorage.getItem(CACHE_KEY);
  const cacheTimestamp = localStorage.getItem(CACHE_TIME_KEY);
  const now = Date.now();

  let hydratedObject = null;

  if (cachedStored && cacheTimestamp && (now - parseInt(cacheTimestamp) < CACHE_DURATION_MS)) {
    try {
      hydratedObject = JSON.parse(cachedStored);

      // ️ Vigía Inteligente: Validar que el objeto tenga cara y ojos
      if (!hydratedObject || !Array.isArray(hydratedObject.trending)) {
        throw new Error("Caché incompleto o corrupto");
      }

      console.log(`🟢 Objeto rehidratado: { trending: ${hydratedObject.trending.length} elementos }. (0 lecturas)`);
      movieDatabase = hydratedObject;
      
      // ✅ Revisar anuncios de la app y detectar GEO al rehidratar
      setTimeout(() => { 
          if(window.trackUserGeo) window.trackUserGeo();
          if(window.triggerLandingAd) window.triggerLandingAd();
          if(window.resumePendingExports) window.resumePendingExports();
      }, 1500);
    } catch (e) {
      console.warn("⚠️ Fallo en rehidratación, limpiando búnker para fetch fresco...");
      localStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(CACHE_TIME_KEY);
      hydratedObject = null;
    }
  }

  if (!hydratedObject) {
    // 2. Si no hay caché o caducó, pedir a Firebase — y quedarse escuchando en
    // vivo el resto de la sesión en vez de solo pedir una vez. La primera
    // entrega cuesta igual que un fetch normal (las 215 completas), pero de
    // ahí en más, si alguien borra/edita algo en el admin, llega solo y solo
    // se cobra por lo que cambió (no por releer todo el catálogo de nuevo) —
    // reemplaza el "revisar cada 5 min por si acaso" por "avisame apenas
    // cambia algo de verdad". A pedido, para que un borrado en una pestaña se
    // vea reflejado al toque en cualquier otra sin esperar el vencimiento del caché.
    console.log("🔥 Haciendo expedición a Firebase (Solicitando datos frescos)");
    try {
      await new Promise((resolve, reject) => {
        let esPrimeraEntrega = true;
        onSnapshot(moviesCol, (snapshot) => {
          if (esPrimeraEntrega) {
            esPrimeraEntrega = false;
            const moviesArray = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            movieDatabase.trending = moviesArray;
            localStorage.setItem(CACHE_KEY, JSON.stringify(movieDatabase));
            localStorage.setItem(CACHE_TIME_KEY, Date.now().toString());
            if (window.resumePendingExports) window.resumePendingExports();
            resolve();
            return;
          }

          // Cambios en vivo (no la carga inicial): parchea en memoria en vez
          // de releer las 215 de nuevo, y refresca solo lo que esté a la vista.
          snapshot.docChanges().forEach((change) => {
            const data = { id: change.doc.id, ...change.doc.data() };
            const idx = movieDatabase.trending.findIndex(m => m.id === data.id);
            if (change.type === 'removed') {
              if (idx !== -1) movieDatabase.trending.splice(idx, 1);
            } else if (idx !== -1) {
              movieDatabase.trending[idx] = data;
            } else {
              movieDatabase.trending.push(data);
            }
          });
          localStorage.setItem(CACHE_KEY, JSON.stringify(movieDatabase));
          localStorage.setItem(CACHE_TIME_KEY, Date.now().toString());

          if (document.getElementById('admin-view')?.style.display === 'block') {
            _updateDetailedStats(movieDatabase.trending);
            if (window.filterInventoryByCategory) window.filterInventoryByCategory();
            else renderInventory();
          } else if (document.getElementById('home-view')?.style.display === 'block' && typeof initApp === 'function') {
            initApp();
          }
        }, (error) => {
          // Si falla ANTES de la primera entrega, es un error real de carga (se
          // maneja como antes). Si falla después (se cortó la conexión a mitad
          // de la sesión), no hay nada que "devolver": solo se deja de escuchar
          // hasta el próximo reload, que vuelve a intentar desde cero.
          if (esPrimeraEntrega) reject(error);
          else console.warn('Se perdió el listener en vivo del catálogo:', error);
        });
      });
    } catch (error) {
      console.error("❌ Error en la expedición de datos:", error);
      if (window.showToast) window.showToast("⚠️ Error cargando la selva: " + error.message, "error");
      return; // Muerte súbita
    }
  }

  // 3. Renderizar
  if (document.getElementById('admin-view')?.style.display === 'block') {
    _updateDetailedStats(movieDatabase.trending);
  }

  limpiarDuplicadosDeCatalogo();

  // Nota: handleRouting ya sabe si es la primera vez al revisar el DOM
  // ✅ Disparar anuncios automáticos si corresponde
  if(window.triggerLandingAd) window.triggerLandingAd();

  // ⚠️ En un reload con caché caliente (< 15 min) esta función corre de forma
  // SÍNCRONA durante la evaluación del módulo, y llega hasta aquí ANTES de que
  // más abajo se defina window.openMovieDetail (y openPlayer). Si enrutáramos ya,
  // en la ruta /detail/.../play la llamada a openMovieDetail sería undefined, la
  // ficha se quedaba en "Cargando..." (pantalla negra) y el player nunca abría.
  // Diferir un microtask deja terminar la carga del módulo: las funciones ya
  // existen y la ruta se resuelve bien. En la primera visita (sin caché) el
  // await del fetch ya daba ese margen; este fix cubre el reload cacheado.
  queueMicrotask(() => {
    handleRouting();
    // 🚀 Ocultar splash una vez resuelta la ruta
    window.hideSplashScreen();
  });
}

// Iniciar recolección al cargar
// Backdoor removed by Architect Antigravity 🌴
// Access only via #admin password check.
window.updateAdminUI = () => {
  const isAdmin = localStorage.getItem('selva_admin_auth') === 'true';
  const dot = document.getElementById('admin-status-dot');
  if (dot) dot.style.display = isAdmin ? 'block' : 'none';
  const adminMenuBtn = document.getElementById('admin-panel-menu-btn');
  if (adminMenuBtn) adminMenuBtn.style.display = isAdmin ? 'flex' : 'none';
};
// Ya no siembra títulos "famosos" automáticamente: se agregaban solos sin que
// el admin lo pidiera, y si alguno se borraba a propósito (ej. "Friends"),
// cualquier cosa que limpiara el localStorage (como borrar datos del sitio)
// hacía que se volviera a crear solo, porque la función no podía distinguir
// "nunca existió" de "lo borraron adrede". Se mantiene SOLO la limpieza de
// duplicados reales (que no agrega nada nuevo, solo saca copias repetidas).
async function limpiarDuplicadosDeCatalogo({ manual = false } = {}) {
  if (!Array.isArray(movieDatabase.trending)) return;

  // --- AUTOMATIC DUPLICATE CLEANER ---
  // getDocs(moviesCol) no lleva orderBy, así que el orden en que Firestore
  // devuelve los duplicados no está garantizado (no es por fecha de creación).
  // Antes esto se quedaba con el primero que aparecía en ese orden arbitrario
  // y borraba el resto — si el duplicado "bueno" (con link healthy) aparecía
  // después del viejo roto, se borraba el bueno y el título se quedaba sin
  // fuente aunque su estado dijera "Sano". Ahora se agrupan los duplicados y
  // de cada grupo se queda el "mejor" (status más sano, y entre empates el
  // más reciente por createdAt).
  const STATUS_RANK = { healthy: 3, waiting: 2, review: 1, broken: 0 };
  const rankOf = (m) => STATUS_RANK[m.status] ?? 1;
  const isBetter = (a, b) => {
    const ra = rankOf(a), rb = rankOf(b);
    if (ra !== rb) return ra > rb;
    return (a.createdAt || 0) > (b.createdAt || 0);
  };

  const bestByKey = new Map(); // normTmdb||normTitle -> mejor item visto hasta ahora
  const groups = new Map();    // misma key -> todos los items (para calcular el resto a borrar)

  for (const m of movieDatabase.trending) {
    const normTmdb = m.tmdbId ? String(m.tmdbId).trim() : '';
    const normTitle = m.title ? m.title.toLowerCase().trim() : '';
    const key = normTmdb || normTitle;
    if (!key) continue;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);

    const current = bestByKey.get(key);
    if (!current || isBetter(m, current)) bestByKey.set(key, m);
  }

  const duplicatesToDelete = [];
  for (const [key, items] of groups) {
    if (items.length <= 1) continue;
    const best = bestByKey.get(key);
    for (const m of items) {
      if (m.id !== best.id) duplicatesToDelete.push(m);
    }
  }

  if (duplicatesToDelete.length === 0) {
    if (manual && window.showToast) window.showToast('✨ No hay duplicados en el catálogo.', 'info');
    return { borrados: 0, fallidos: 0 };
  }

  // En modo manual (botón del admin) se muestra qué se va a borrar y cuál
  // copia se queda antes de tocar nada — corriendo solo (al cargar la
  // página, para cualquier visitante) esto se aplicaba directo y en
  // silencio, que es justo lo que hacía invisible el problema real: un ID
  // viejo de "Continuar viendo" moría sin que quedara rastro de por qué.
  if (manual) {
    const detalle = duplicatesToDelete
      .map(dup => `• "${dup.title}" (se borra esta copia, ID: ${dup.id.slice(0, 8)}…)`)
      .join('\n');
    if (!confirm(`🧹 Se encontraron ${duplicatesToDelete.length} duplicado(s):\n\n${detalle}\n\n¿Borrar las copias repetidas y quedarse con la mejor de cada una?`)) {
      return { borrados: 0, fallidos: 0, cancelado: true };
    }
  }

  console.log(`🧹 Encontrados ${duplicatesToDelete.length} duplicados en Firebase. Iniciando limpieza...`);
  let borrados = 0, fallidos = 0;
  for (const dup of duplicatesToDelete) {
    try {
      await deleteDoc(doc(db, "movies", dup.id));
      movieDatabase.trending = movieDatabase.trending.filter(m => m.id !== dup.id);
      console.log(`🗑️ Duplicado eliminado: ${dup.title} (ID: ${dup.id})`);
      borrados++;
    } catch (err) {
      console.error(`Error eliminando duplicado ${dup.title}:`, err);
      fallidos++;
    }
  }
  localStorage.removeItem('selvaflix_full_database');
  localStorage.removeItem('selvaflix_cache_timestamp');

  if (manual) {
    const msg = `🧹 ${borrados} duplicado${borrados === 1 ? '' : 's'} eliminado${borrados === 1 ? '' : 's'}${fallidos ? ` (${fallidos} fallaron)` : ''}.`;
    if (window.showToast) window.showToast(msg, fallidos ? 'warning' : 'success');
    else alert(msg);
    if (document.getElementById('admin-view')?.style.display === 'block') {
      _updateDetailedStats(movieDatabase.trending);
      if (window.filterInventoryByCategory) window.filterInventoryByCategory();
    }
  }

  return { borrados, fallidos };
}

window.limpiarDuplicadosManual = () => limpiarDuplicadosDeCatalogo({ manual: true });

window.updateAdminUI();
// Se guarda la promesa para que la Carga Masiva pueda esperarla antes de
// armar "existingIds": si el admin abre el modal apenas entra, sin esto
// movieDatabase.trending todavía está vacío y todo lo ya sembrado parece
// nuevo (se vuelve a ofrecer / se duplica al confirmar).
window.selvaFlixDataReady = loadSelvaFlixData();


// ─── Filter / Routing ────────────────────────────────────────────
let _currentFilter = '';   // 'movies' | 'series' | 'live' | ''
let _currentGenre = '';   // TMDB genre id string or ''
let _currentYear = '';    // año como string, o '' para todos

// Los enlaces de escritorio (Home / Películas / Series) llevan su propia clase
// y nadie los actualizaba: "Home" se quedaba naranja aunque estuvieras en Series.
function marcarNavEscritorio(tipo) {
  const enlaces = document.querySelectorAll('.nav-desktop-links .nav-link-cinepulse');
  if (!enlaces.length) return;

  const destino = { '': 'Home', 'movies': 'Películas', 'series': 'Series', 'anime': 'Anime', 'franquicias': 'Franquicias' }[tipo || ''];
  enlaces.forEach(a => {
    a.classList.toggle('active', a.textContent.trim() === destino);
  });
}

// La barra inferior de móvil solo se marcaba desde el enrutado, así que al
// cambiar de pestaña con setFilter se quedaba siempre en "Inicio".
function marcarNavMovil(tipo) {
  const mapa = { '': 'btn-nav-home', 'movies': 'btn-nav-movies', 'series': 'btn-nav-series', 'anime': 'btn-nav-anime', 'franquicias': 'btn-nav-franquicias' };
  Object.values(mapa).forEach(id => document.getElementById(id)?.classList.remove('active'));
  document.getElementById(mapa[tipo || ''])?.classList.add('active');
}

// "Continuar viendo" es cosa del Home. loadContinueWatching solo corre al cargar
// el historial, así que al cambiar de pestaña hay que ocultarlo aquí.
function sincronizarContinuarViendo(tipo) {
  const fila = document.getElementById('continue-watching-row');
  if (!fila) return;
  if (tipo) {
    fila.style.display = 'none';
  } else if (document.getElementById('continue-watching-grid')?.children.length) {
    fila.style.display = 'block';
  }
}

window.setFilter = (type) => {
  _currentFilter = type;
  _currentGenre = '';   // reset genre on main filter change
  _currentYear = '';    // reset año on main filter change

  marcarNavEscritorio(type);
  sincronizarContinuarViendo(type);
  marcarNavMovil(type);

  // Mismo motivo que en showView(): salir del admin para acá (Películas/
  // Series/Anime) no pasa por goToHome(), así que sin esto el flag de
  // "admin activo" quedaba pegado y nunca más se inyectaba publicidad.
  sessionStorage.removeItem('selva_admin_active');

  const adminEl = document.getElementById('admin-view');
  const homeEl = document.getElementById('home-view');
  if (adminEl) adminEl.style.display = 'none';
  if (homeEl) homeEl.style.display = 'block';

  // Update filter pill active state (only main pills)
  ['filter-all', 'filter-movies', 'filter-series', 'filter-anime'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  const idMap = { '': 'filter-all', 'movies': 'filter-movies', 'series': 'filter-series', 'anime': 'filter-anime' };
  document.getElementById(idMap[type] || 'filter-all')?.classList.add('active');

  // Show genre sub-bar only in movies/series/anime view; reset genre pills
  const genreBar = document.getElementById('genre-bar');
  if (genreBar) {
    genreBar.style.display = (type === 'movies' || type === 'series' || type === 'anime') ? 'flex' : 'none';
    // Ojo: las chips son .cinepulse-genre-chip, no .filter-btn (esa clase no
    // existe en el HTML) — con el selector viejo esto nunca sacaba el
    // "active" de la chip anterior al cambiar de género.
    genreBar.querySelectorAll('.cinepulse-genre-chip').forEach(b => b.classList.remove('active'));
    document.getElementById('genre-all')?.classList.add('active');
  }
  poblarFiltroAnios();
  document.querySelectorAll('.year-filter-select').forEach(sel => { sel.value = ''; });

  history.replaceState(null, '', type ? `#${type}` : '#');
  initApp(type, '', '');

  // 🚀 Splash Screen: Ocultar si es la primera carga y ya tenemos los datos
  window.hideSplashScreen();

  // 🧭 Navegación Fluida: Scroll suave al inicio del contenido para no perderse
  const filterOffset = document.getElementById('filter-bar')?.offsetTop || 0;
  window.scrollTo({ top: filterOffset - 80, behavior: 'smooth' });
};

window.setGenre = (genreId) => {
  _currentGenre = genreId;

  // Update genre pill active state
  const genreBar = document.getElementById('genre-bar');
  if (genreBar) {
    genreBar.querySelectorAll('.cinepulse-genre-chip').forEach(b => b.classList.remove('active'));
    // Find clicked button (match by onclick attr genreId)
    genreBar.querySelectorAll('.cinepulse-genre-chip').forEach(b => {
      const oc = b.getAttribute('onclick') || '';
      if (oc.includes(`'${genreId}'`) || (genreId === '' && b.id === 'genre-all')) {
        b.classList.add('active');
      }
    });
  }
  initApp(_currentFilter, genreId, _currentYear);
};

// Filtro por año: hay un <select class="year-filter-select"> junto al
// buscador de escritorio y otro junto al buscador móvil (dos lugares, mismo
// filtro) — se llenan solos con los años que de verdad existen en el
// catálogo (no un rango fijo 1980-2026 que mayormente daría "sin resultados").
function poblarFiltroAnios() {
  const selects = document.querySelectorAll('.year-filter-select');
  if (!selects.length || !movieDatabase.trending.length) return;

  const years = [...new Set(
    movieDatabase.trending.map(c => String(c.year || '')).filter(y => y.length === 4)
  )].sort((a, b) => b - a);

  selects.forEach(sel => {
    if (sel.dataset.poblado === String(movieDatabase.trending.length)) return; // ya está al día
    const seleccionActual = sel.value;
    const etiquetaTodos = sel.querySelector('option[value=""]')?.textContent || 'Año: Todos';
    sel.innerHTML = `<option value="">${etiquetaTodos}</option>` +
      years.map(y => `<option value="${y}">${y}</option>`).join('');
    sel.value = years.includes(seleccionActual) ? seleccionActual : '';
    sel.dataset.poblado = String(movieDatabase.trending.length);
  });
}

function poblarListaFranquicias() {
  const datalist = document.getElementById('franchise-datalist');
  if (!datalist) return;

  const nombres = [...new Set(
    movieDatabase.trending.map(c => (c.franchise || '').trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  datalist.innerHTML = nombres.map(n => `<option value="${n.replace(/"/g, '&quot;')}"></option>`).join('');
}

// Recorre las películas ya cargadas (con tmdbId y sin franquicia puesta a mano)
// y les pregunta a TMDB si pertenecen a una colección (Marvel, Star Wars, etc),
// para no tener que ir título por título asignándola manualmente.
window.detectarFranquiciasAutomatico = async () => {
  const candidatos = movieDatabase.trending.filter(m =>
    (m.type === 'movie' || !m.type) && m.tmdbId && !(m.franchise && m.franchise.trim())
  );

  if (candidatos.length === 0) {
    if (window.showToast) window.showToast('No hay películas pendientes: o no tienen ID de TMDB, o ya tienen franquicia asignada. 🌴', 'info');
    return;
  }

  if (!confirm(`🎬 DETECTAR FRANQUICIAS:\nVoy a revisar ${candidatos.length} película(s) contra TMDB para ver si pertenecen a una colección (Marvel, Star Wars, etc). Solo completa las que todavía no tengan franquicia — no pisa nada que ya hayas puesto a mano.\n\n¿Continuar? 🔍🌴`)) return;

  const overlay = document.getElementById('delete-progress-overlay');
  const bar = document.getElementById('progress-bar-fill');
  const text = document.getElementById('progress-percent');
  const statusText = document.getElementById('progress-text');

  if (statusText) statusText.innerText = 'Buscando franquicias en TMDB... 🎬🔎';
  if (overlay) overlay.style.display = 'flex';

  let detectadas = 0, fallidas = 0;
  for (let i = 0; i < candidatos.length; i++) {
    const m = candidatos[i];
    try {
      const res = await fetch(`${TMDB_URL}/movie/${m.tmdbId}?api_key=${TMDB_API_KEY}`);
      const details = await res.json();
      const nombre = (details.belongs_to_collection?.name || '').replace(/\s*Collection\s*$/i, '').trim();
      if (nombre) {
        await updateDoc(doc(db, "movies", m.id), { franchise: nombre });
        m.franchise = nombre;
        detectadas++;
      }
    } catch (e) {
      console.error('Error detectando franquicia:', m.title, e);
      fallidas++;
    }

    const percent = Math.round(((i + 1) / candidatos.length) * 100);
    if (bar) bar.style.width = `${percent}%`;
    if (text) text.innerText = `${percent}% (${i + 1}/${candidatos.length})`;

    await new Promise(r => setTimeout(r, 300)); // no saturar la API de TMDB
  }

  localStorage.removeItem('selvaflix_full_database');
  localStorage.removeItem('selvaflix_cache_timestamp');

  setTimeout(() => {
    if (overlay) overlay.style.display = 'none';
    alert(`🎬 DETECCIÓN DE FRANQUICIAS:\n- Revisadas: ${candidatos.length} película(s).\n- Franquicia encontrada: ${detectadas}.\n- Sin colección en TMDB o fallidas: ${candidatos.length - detectadas}.\n\nEntrá a la pestaña "Franquicias" para verlas agrupadas.`);
    if (window.filterInventoryByCategory) window.filterInventoryByCategory();
    poblarListaFranquicias();
  }, 800);
};

// Completa género/año/calificación/sinopsis/título original desde TMDB para
// títulos que quedaron sin esos datos (por ejemplo, un ingreso rápido que solo
// trajo título/poster/ids). Mismo patrón que detectarFranquiciasAutomatico:
// solo llena lo que esté vacío, nunca pisa algo ya cargado a mano.
window.enriquecerCatalogoDesdeTMDB = async () => {
  const candidatos = movieDatabase.trending.filter(m =>
    m.tmdbId && (!m.genres || m.genres.length === 0)
  );

  if (candidatos.length === 0) {
    if (window.showToast) window.showToast('No hay títulos con TMDB ID y sin género pendiente. 🌴', 'info');
    return;
  }

  if (!confirm(`🎨 ENRIQUECER CATÁLOGO:\nVoy a completar género/año/calificación/sinopsis desde TMDB para ${candidatos.length} título(s) que no los tienen. Solo llena lo que esté vacío — no pisa nada que ya hayas puesto a mano.\n\n¿Continuar? 🔍🌴`)) return;

  const overlay = document.getElementById('delete-progress-overlay');
  const bar = document.getElementById('progress-bar-fill');
  const text = document.getElementById('progress-percent');
  const statusText = document.getElementById('progress-text');

  if (statusText) statusText.innerText = 'Completando datos desde TMDB... 🎨🔎';
  if (overlay) overlay.style.display = 'flex';

  let completados = 0, fallidos = 0;
  for (let i = 0; i < candidatos.length; i++) {
    const m = candidatos[i];
    const esSerie = m.type === 'series' || m.type === 'anime';
    const tipoTMDB = esSerie ? 'tv' : 'movie';
    try {
      const res = await fetch(`${TMDB_URL}/${tipoTMDB}/${m.tmdbId}?api_key=${TMDB_API_KEY}&language=es-MX`);
      const details = await res.json();

      const cambios = {};
      if (!m.genres || m.genres.length === 0) cambios.genres = (details.genres || []).map(g => String(g.id));
      if (!m.rating) cambios.rating = details.vote_average ? details.vote_average.toFixed(1) : '';
      if (!m.year) cambios.year = (details.release_date || details.first_air_date || '').slice(0, 4);
      if (!m.synopsis) cambios.synopsis = details.overview || '';
      if (!m.original_title) cambios.original_title = details.original_title || details.original_name || '';

      if (Object.keys(cambios).length > 0) {
        await updateDoc(doc(db, "movies", m.id), cambios);
        Object.assign(m, cambios);
      }
      completados++;
    } catch (e) {
      console.error('Error enriqueciendo desde TMDB:', m.title, e);
      fallidos++;
    }

    const percent = Math.round(((i + 1) / candidatos.length) * 100);
    if (bar) bar.style.width = `${percent}%`;
    if (text) text.innerText = `${percent}% (${i + 1}/${candidatos.length})`;

    await new Promise(r => setTimeout(r, 300)); // no saturar la API de TMDB
  }

  localStorage.removeItem('selvaflix_full_database');
  localStorage.removeItem('selvaflix_cache_timestamp');

  setTimeout(() => {
    if (overlay) overlay.style.display = 'none';
    alert(`🎨 ENRIQUECIMIENTO COMPLETO:\n- Revisados: ${candidatos.length} título(s).\n- Completados: ${completados}.\n- Fallidos (error de red/TMDB): ${fallidos}.`);
    if (window.filterInventoryByCategory) window.filterInventoryByCategory();
    else if (document.getElementById('admin-view')?.style.display === 'block') renderInventory();
  }, 800);
};

// ─── 🔥 Conversión Masiva a VOE ─────────────────────────────────────────────
// Recorre el catálogo (o un subconjunto) y sube cada película a VOE.sx usando
// el mismo pipeline de extracción del botón individual ("Subir a VOE").
window.convertirCatalogoAVoe = async () => {
  if (localStorage.getItem('selva_admin_auth') !== 'true') return;

  const providerChoice = prompt(
    '🔥 CONVERTIR CATÁLOGO A VOE\n\n¿Qué fuente usar para extraer los links?\n\n1 → FlixLatam\n2 → PelisMart\n3 → RepelisHD\n4 → Vimeus\n\nEscribe el número:',
    '1'
  );
  if (!providerChoice) return;
  const providerMap = { '1': 'flixlatam', '2': 'pelismart', '3': 'repelishd', '4': 'vimeus' };
  const provider = providerMap[providerChoice.trim()];
  if (!provider) { alert('Opción inválida. Ingresa 1, 2, 3 o 4.'); return; }

  const limitStr = prompt(
    '¿Cuántas películas subir en esta tanda?\n(Escribe un número, ej: 20 — o "todo" para todas)',
    '20'
  );
  if (!limitStr) return;
  const limit = limitStr.trim().toLowerCase() === 'todo' ? Infinity : parseInt(limitStr.trim(), 10);
  if (isNaN(limit) || limit <= 0) { alert('Número inválido.'); return; }

  const skipDone = confirm('¿Saltear películas que ya tienen enlace de VOE.sx guardado? (Recomendado: Aceptar)');

  let candidatos = (_allInventoryItems || []).filter(m => {
    if (!m.id) return false;
    if (skipDone && m.embed && m.embed.includes('voe')) return false;
    const hasId = m.imdbId || m.imdb_id || m.tmdbId || m.tmdb_id;
    return !!hasId;
  });
  if (limit !== Infinity) candidatos = candidatos.slice(0, limit);

  if (candidatos.length === 0) {
    if (window.showToast) window.showToast('No hay películas pendientes para convertir. 🌴', 'info');
    return;
  }

  if (!confirm(`🔥 Se van a encolar ${candidatos.length} película(s) a VOE usando "${provider}".\n\nEl proceso corre de fondo (una por una, cada 4 segundos) y puedes seguir usando la app.\n\n¿Continuar?`)) return;

  if (window.showToast) window.showToast(`🚀 Iniciando conversión masiva de ${candidatos.length} películas a VOE...`, 'info');
  console.log(`[ConvertirVOE] Iniciando: ${candidatos.length} películas con proveedor "${provider}"`);

  const { SelvaStream } = await import('./components/Player/Player.js');
  const { ExportManager } = await import('./utils/exportManager.js');
  const voeKey = SelvaStream.VOE_API_KEY;
  if (!voeKey) {
    if (window.showToast) window.showToast('❌ Falta VITE_VOE_API_KEY en la configuración.', 'error');
    return;
  }

  let ok = 0, fail = 0, skip = 0;

  for (let i = 0; i < candidatos.length; i++) {
    const movie = candidatos[i];
    const title = movie.title || movie.name || movie.id;

    try {
      if (window.showToast) window.showToast(`[${i + 1}/${candidatos.length}] 🔍 ${title}...`, 'info');

      const imdbId = movie.imdbId || movie.imdb_id || '';
      const tmdbId = String(movie.tmdbId || movie.tmdb_id || '');
      const type = movie.type || 'movie';

      const links = await ExportManager.extractLinks({
        provider,
        imdbId,
        tmdbId,
        type,
        workerUrl: SelvaStream.MASTER_WORKER_URL,
        authToken: SelvaStream.AUTH_TOKEN
      });

      const best = ExportManager.pickBestLink(links);
      if (!best) {
        skip++;
        console.warn(`[ConvertirVOE] Sin links: ${title}`);
        continue;
      }

      await ExportManager.startVoeUpload({
        movieId: movie.id,
        sourceUrl: best.link,
        voeKey,
        onUpdate: async (update) => {
          if (update.phase === 'done' || update.url) {
            try {
              const { getFirestore, doc, updateDoc } = await import('firebase/firestore');
              const db = getFirestore();
              const updObj = { exportStatus: update.phase, updatedAt: Date.now() };
              if (update.url) updObj.embed = update.url;
              if (update.fileCode) updObj.exportFileId = update.fileCode;
              await updateDoc(doc(db, 'movies', movie.id), updObj);
              const memItem = _allInventoryItems.find(m => m.id === movie.id);
              if (memItem) { memItem.exportStatus = update.phase; if (update.url) memItem.embed = update.url; }
            } catch(e) { console.warn('[ConvertirVOE] Firestore error:', e); }
          }
        }
      });

      try {
        const { getFirestore, doc, updateDoc } = await import('firebase/firestore');
        const db = getFirestore();
        await updateDoc(doc(db, 'movies', movie.id), { exportStatus: 'processing', updatedAt: Date.now() });
        const memItem = _allInventoryItems.find(m => m.id === movie.id);
        if (memItem) memItem.exportStatus = 'processing';
      } catch(e) {}

      ok++;
      console.log(`[ConvertirVOE] ✅ Encolada: ${title} → ${best.link}`);

    } catch (err) {
      fail++;
      console.error(`[ConvertirVOE] ❌ Error en "${title}":`, err.message);
    }

    if (i < candidatos.length - 1) await new Promise(r => setTimeout(r, 4000));
  }

  if (window.filterInventoryByCategory) window.filterInventoryByCategory();
  if (window.showToast) window.showToast(
    `🔥 Conversión masiva lista: ✅ ${ok} encoladas | ⏭️ ${skip} sin link | ❌ ${fail} errores`,
    ok > 0 ? 'success' : 'warning'
  );
  console.log(`[ConvertirVOE] Resultado final: ${ok} OK, ${skip} sin link, ${fail} errores`);
};

window.setYear = (year) => {
  _currentYear = year;
  // Los dos selects (escritorio/móvil) se mantienen sincronizados entre sí.
  document.querySelectorAll('.year-filter-select').forEach(sel => { sel.value = year; });
  initApp(_currentFilter, _currentGenre, year);
};


// Helper para actualizar src del iframe sin contaminar el historial (Evita "about:blank" al volver)
window.setIframeSource = (id, url) => {
  const oldIframe = document.getElementById(id);
  if (!oldIframe) return;
  const parent = oldIframe.parentNode;
  const newIframe = oldIframe.cloneNode(false);
  newIframe.src = url || 'about:blank';
  parent.replaceChild(newIframe, oldIframe);
  return newIframe;
};

function showView(active) {
  // El flag de "estoy en el panel admin" (que injectCampaignScripts usa
  // para no inyectar anuncios encima de los botones del portal) solo se
  // limpiaba en goToHome() -- si el admin salía del panel navegando
  // directo a Películas/Series/Anime (setFilter, que no pasa por acá)
  // o a un detalle, se quedaba pegado en '1' para el resto de la sesión
  // y nunca más se le mostraba publicidad, aunque ya no estuviera en admin.
  if (active !== 'admin-view') sessionStorage.removeItem('selva_admin_active');

  const adminEl = document.getElementById('admin-view');
  const homeEl = document.getElementById('home-view');
  const detailEl = document.getElementById('detail-view');
  const myListEl = document.getElementById('my-list-view');
  // OJO: las clases reales son .navbar-cinepulse / .mobile-nav-cinepulse (no .navbar / .bottom-nav,
  // que no existen en el DOM). Con el selector viejo esto nunca ocultaba nada en ninguna vista.
  const navbar = document.querySelector('.navbar-cinepulse');
  const bottomNav = document.querySelector('.mobile-nav-cinepulse');

  // Ocultar todo primero
  if (adminEl) adminEl.style.display = 'none';
  if (homeEl) homeEl.style.display = 'none';
  if (detailEl) detailEl.style.display = 'none';
  if (myListEl) myListEl.style.display = 'none';

  // Limpiar estado activo del nav mobile
  document.querySelectorAll('.nav-item-cinepulse').forEach(b => b.classList.remove('active'));

  // El botón flotante de soporte es para usuarios navegando la selva, no para el admin
  const supportFab = document.getElementById('support-chat-fab');
  if (supportFab) supportFab.style.display = active === 'admin-view' ? 'none' : 'flex';

  // El de Premium/Promos: igual que el de soporte, nada de esto en el panel admin.
  // Fuera del admin, lo decide el tier (updatePremiumPromoFab esconde si ya es premium/admin).
  const promoFab = document.getElementById('premium-promo-fab');
  if (promoFab) {
    if (active === 'admin-view') promoFab.style.display = 'none';
    else if (typeof window.updatePremiumPromoFab === 'function') window.updatePremiumPromoFab();
  }

  // Candado anti-scroll: el panel admin ya maneja su propio scroll interno
  // (.admin-portal-content-body). Si el <body> también puede desplazarse, cualquier
  // elemento que sobre unos px de alto deja ver el fondo negro debajo del panel.
  document.body.classList.toggle('admin-locked', active === 'admin-view');

  if (active === 'admin-view') {
    if (adminEl) adminEl.style.display = 'block';
    // El admin tiene su propio header (logo, buscador, avatar): mostrar también la navbar del
    // sitio sumaba ~70px por encima del panel (que ya ocupa 100vh), forzando scroll en toda la
    // página y dejando ver el fondo negro debajo del panel al desplazarse.
    if (navbar) navbar.style.display = 'none';
    if (bottomNav) bottomNav.style.display = 'none';
  } else if (active === 'detail-view') {
    if (detailEl) detailEl.style.display = 'block';
    if (navbar) navbar.style.display = 'none';
    if (bottomNav) bottomNav.style.display = 'none';
    window.scrollTo(0, 0);
  } else if (active === 'my-list-view') {
    if (myListEl) myListEl.style.display = 'block';
    if (navbar) navbar.style.display = '';
    if (bottomNav) bottomNav.style.display = '';
    document.getElementById('btn-nav-mylist')?.classList.add('active');
    window.scrollTo(0, 0);
  } else {
    if (homeEl) homeEl.style.display = 'block';
    if (navbar) navbar.style.display = '';
    if (bottomNav) bottomNav.style.display = '';
    document.getElementById('btn-nav-home')?.classList.add('active');
  }
}

// ─── Navegación con control remoto / D-pad (Android TV) ────────────────────
// Puramente aditiva: no toca el diseño, solo hace navegable con flechas+Enter
// lo que ya se ve (tarjetas, chips de género, botones del hero). Un usuario
// con mouse/touch no nota ninguna diferencia. Todo elemento marcado con
// [data-tvnav] entra en el "mapa" de navegación.
function _tvNavItems() {
  return Array.from(document.querySelectorAll('[data-tvnav]'))
    .filter(el => el.offsetParent !== null); // solo lo visible en pantalla
}

// Busca, entre los ítems navegables, el más cercano en la dirección pedida
// (comparando centros de cada tarjeta/botón) — así funciona igual de bien
// con filas de distinto largo, sin tener que llevar la cuenta de índices.
function _tvNavMove(direction) {
  const items = _tvNavItems();
  if (items.length === 0) return;

  const current = document.activeElement;
  if (!items.includes(current)) {
    items[0].focus();
    items[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }

  const curRect = current.getBoundingClientRect();
  const curCx = curRect.left + curRect.width / 2;
  const curCy = curRect.top + curRect.height / 2;

  let best = null, bestScore = Infinity;
  items.forEach(el => {
    if (el === current) return;
    const r = el.getBoundingClientRect();
    const dx = (r.left + r.width / 2) - curCx;
    const dy = (r.top + r.height / 2) - curCy;

    let valid = false, score = 0;
    if (direction === 'left' && dx < -5 && Math.abs(dy) < curRect.height * 0.6) { valid = true; score = Math.abs(dx) + Math.abs(dy) * 3; }
    else if (direction === 'right' && dx > 5 && Math.abs(dy) < curRect.height * 0.6) { valid = true; score = Math.abs(dx) + Math.abs(dy) * 3; }
    else if (direction === 'up' && dy < -5) { valid = true; score = Math.abs(dy) + Math.abs(dx) * 2; }
    else if (direction === 'down' && dy > 5) { valid = true; score = Math.abs(dy) + Math.abs(dx) * 2; }

    if (valid && score < bestScore) { bestScore = score; best = el; }
  });

  if (best) {
    best.focus();
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}

document.addEventListener('keydown', (e) => {
  const dirMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  const homeVisible = document.getElementById('home-view')?.style.display !== 'none';
  const detailVisible = document.getElementById('detail-view')?.style.display !== 'none';
  if (!homeVisible && !detailVisible) return; // por ahora, solo home + ficha (ver Analíticas/Catálogo para admin)

  if (dirMap[e.key]) {
    const active = document.activeElement;
    const onTvItem = active?.matches?.('[data-tvnav]');
    const nothingFocused = !active || active === document.body;
    // No interceptar flechas si el foco está en el buscador u otro input:
    // ahí las flechas deben mover el cursor de texto, no la selva.
    const inTextInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    if ((onTvItem || nothingFocused) && !inTextInput) {
      e.preventDefault();
      _tvNavMove(dirMap[e.key]);
    }
    return;
  }

  if (e.key === 'Enter' || e.key === ' ') {
    const active = document.activeElement;
    // Los <button> ya activan con Enter/Space solos; esto es solo para las
    // tarjetas, que son <div> por (mucho) más flexibles a nivel de layout.
    if (active?.matches?.('[data-tvnav]') && active.tagName !== 'BUTTON' && active.tagName !== 'A') {
      e.preventDefault();
      active.click();
    }
  }
});

// 🐍 Convierte un título en slug URL-friendly: "Spider-Man: No Way Home" → "spider-man-no-way-home"
function slugify(title, year) {
  const base = (title || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/[^a-z0-9\s-]/g, '')                     // solo alfanumérico
    .trim()
    .replace(/\s+/g, '-');                             // espacios → guiones
  return year ? `${base}-${year}` : base;
}

// Busca una película por slug o por id
function findMovieBySlugOrId(slugOrId) {
  if (!movieDatabase?.trending) return null;
  // Primero intento por id exacto
  const byId = movieDatabase.trending.find(m => m.id === slugOrId);
  if (byId) return byId;
  // Luego por slug generado del título
  return movieDatabase.trending.find(m => slugify(m.title, m.year) === slugOrId) || null;
}

// Limpia el '#' del Home y navega limpiamente
window.goToHome = () => {
  if (window.location.hash) {
    history.pushState(null, '', window.location.pathname + window.location.search);
  }
  sessionStorage.removeItem('selva_admin_active');
  const adGlobalContainer = document.getElementById('ad-global-container');
  if (adGlobalContainer) adGlobalContainer.style.display = 'block';
  handleRouting();
};

// Navega a la pestaña Mi Lista
window.goToMyList = async () => {
  history.pushState(null, '', '#mylist');
  // pushState no dispara hashchange, así que handleRouting no corre: cerramos aquí
  if (typeof SelvaStream !== 'undefined') SelvaStream.close();
  showView('my-list-view');
  window.scrollTo(0, 0);
  await window.loadMyList();
};

function handleRouting() {
  const hash = window.location.hash.substring(1) || '';

  // El player-modal es un overlay independiente del hash, así que hay que cerrarlo
  // a mano en cuanto la ruta deja de ser /play. Si no, se queda encima de la app
  // (invisible pero comiéndose los clics) y con el scroll del body bloqueado.
  if (!hash.endsWith('/play')) {
    if (typeof SelvaStream !== 'undefined') SelvaStream.close();
    // Este es el único punto por el que SIEMPRE pasa un cierre del player (atrás
    // del navegador, un link, closePlayer()...), así que es el lugar correcto
    // para cancelar el timer de la racha si todavía no llegó a los 2 minutos.
    clearTimeout(_streakWatchTimer);
  }

  const genreBar = document.getElementById('genre-bar');
  if (genreBar) genreBar.style.display = 'flex'; // Siempre visible

  if (hash.startsWith('detail/')) {
    // Puede ser detail/slug, detail/id, o detail/slug/play
    const parts = hash.replace('detail/', '').split('/');
    const slugOrId = parts[0];
    const isPlayRoute = parts[1] === 'play';

    if (isPlayRoute) {
      // Ruta /play → mostrar detail Y abrir player (si la peli ya está cargada)
      showView('detail-view');
      if (slugOrId) window.openMovieDetail(slugOrId, { autoPlay: true });
    } else {
      // Ruta normal de detalle (el player ya se cerró arriba)
      showView('detail-view');
      if (slugOrId) window.openMovieDetail(slugOrId);
    }
  } else if (hash === 'admin') {
    const isAdminAuthenticated = localStorage.getItem('selva_admin_auth') === 'true';
    if (!isAdminAuthenticated) {
        const password = prompt("🔒 Área Restringida. Introduce la contraseña de administrador:");
        if (password === "adminselvaflix") {
            localStorage.setItem('selva_admin_auth', 'true');
            window.updateAdminUI();
            alert("✅ Acceso Concedido.");
        } else {
            alert("❌ Contraseña incorrecta. Volviendo a la selva.");
            window.goToHome();
            return;
        }
    }
    sessionStorage.setItem('selva_admin_active', '1');
    showView('admin-view');
    renderInventory();
    // loadMetrics vive en el módulo de Analíticas, que se baja recién con
    // cargarAnaliticas() (import() perezoso) — antes esto llamaba a
    // window.loadMetrics() directo, y si el admin entraba a #admin sin haber
    // abierto nunca la pestaña Analíticas en esa sesión, tiraba "loadMetrics
    // is not a function" y cortaba el resto de esta rama (badge de mensajes,
    // conteo de Premium, ocultar el contenedor de anuncios).
    cargarAnaliticas().then(() => window.loadMetrics()).catch(e => {
        console.error('No se pudo cargar el módulo de Analíticas:', e);
    });
    if (typeof window.loadAdminMessages === 'function') window.loadAdminMessages(); // refresca el punto de "sin leer" del sidebar
    if (typeof window.loadPremiumCount === 'function') window.loadPremiumCount();

    // 🔒 Si ya se habían inyectado anuncios de red (navegando el sitio público
    // antes de entrar al admin), ese contenedor queda fixed + z-index altísimo
    // y puede tapar botones reales del portal. Se esconde mientras estemos acá.
    const adGlobalContainer = document.getElementById('ad-global-container');
    if (adGlobalContainer) adGlobalContainer.style.display = 'none';
  } else if (hash === 'mylist') {
    showView('my-list-view');
    window.scrollTo(0, 0);
    window.loadMyList();
  } else {
    showView('home-view');
    const hashVal = hash || '';

    // Top filters
    const idMap = { '': 'filter-all', 'movies': 'filter-movies', 'series': 'filter-series', 'anime': 'filter-anime' };
    ['filter-all', 'filter-movies', 'filter-series', 'filter-anime'].forEach(id => document.getElementById(id)?.classList.remove('active'));
    document.getElementById(idMap[hashVal])?.classList.add('active');

    // Bottom nav (Mobile)
    const btmMap = { '': 'btn-nav-home', 'movies': 'btn-nav-movies', 'series': 'btn-nav-series', 'anime': 'btn-nav-anime' };
    ['btn-nav-home', 'btn-nav-movies', 'btn-nav-series', 'btn-nav-anime'].forEach(id => document.getElementById(id)?.classList.remove('active'));
    document.getElementById(btmMap[hashVal])?.classList.add('active');

    // Nav de escritorio (también al llegar por URL directa o botón atrás)
    marcarNavEscritorio(hashVal);
    sincronizarContinuarViendo(hashVal);

    initApp(hashVal, '');
  }
}

// --- Admin Power: Crown Promotion ---
window.selvaExecuteCrownPromotion = async (movieId, sourceUrl) => {
    if (localStorage.getItem('selva_admin_auth') !== 'true') return;
    
    if (!confirm("¿Deseas coronar esta fuente como la PRIORIDAD para esta película? 👑🌴")) return;

    try {
        await updateDoc(doc(db, "movies", movieId), { embed: sourceUrl });
        if (window.showToast) window.showToast("👑 Fuente coronada con éxito. Ahora es la prioridad.", "success");
        
        // Sincronizar localmente si el reproductor está abierto
        if (typeof SelvaStream !== 'undefined' && SelvaStream.currentPlayerMovie?.id === movieId) {
            SelvaStream.currentPlayerMovie.embed = sourceUrl;
            SelvaStream.loadDebridAuto(); // Recargar con la nueva corona
        }
        
        // Limpiar caché para que otros vean el cambio
        localStorage.removeItem('selvaflix_full_database');
    } catch (e) {
        console.error("Error coronando fuente:", e);
        if (window.showToast) window.showToast("Error al coronar la fuente 🐒", "error");
    }
};

// --- Botón Mágico: Exportar a Hosting Público (PPD) ---
window.selvaExecuteExportToHosting = async (movieId, streamIndex, isAuto = false) => {
    if (localStorage.getItem('selva_admin_auth') !== 'true') return;
    
    // Recuperar el stream usando el índice (Evita errores de escape HTML)
    const streamData = SelvaStream.lastScrapedStreams[streamIndex];
    if (!streamData) {
        if (window.showToast) window.showToast("❌ Error: No se encontró la fuente elegida.", "error");
        return;
    }
    
    const modeText = isAuto ? "AUTOMÁTICA (⚡ Subir + Auto-Guardar)" : "MANUAL (🪄 Solo Subir)";
    const confirmMsg = `¿Deseas iniciar la exportación ${modeText}?🎬\n\nFuente: ${streamData.providerName || 'N/A'}\nCalidad: ${streamData.title.split('\n')[0]}`;
    if (!confirm(confirmMsg)) return;

    try {
        if (window.showToast) window.showToast(`🪄 Iniciando exportación ${isAuto ? 'asistida' : 'manual'}...`, "info");

        let directUrl = streamData.url;

        // 🔗 EXTRACCIÓN DE LINKS (FlixLatam / Vimeus / RepelisHD)
        //    Si no hay URL directa en el stream (ej: el iframe no tiene link extraíble
        //    por el cliente), intentamos obtenerla vía el worker server-side.
        if (!directUrl && streamData.providerName) {
            const provider = streamData.providerName.toLowerCase().replace(/\s+/g, '');
            const supportedProviders = { flixlatam: 'flixlatam', pelismart: 'pelismart', vimeus: 'vimeus', repelishd: 'repelishd', pelishd: 'repelishd' };
            const workerProvider = supportedProviders[provider];

            if (workerProvider) {
                if (window.showToast) window.showToast(`🔍 Extrayendo links de ${streamData.providerName}...`, "info");
                const movie = _allInventoryItems.find(m => m.id === movieId);
                try {
                    const links = await ExportManager.extractLinks({
                        provider: workerProvider,
                        imdbId: movie?.imdbId || movie?.imdb_id,
                        tmdbId: movie?.tmdbId || movie?.id,
                        type: movie?.type || 'movie',
                        workerUrl: SelvaStream.MASTER_WORKER_URL,
                        authToken: SelvaStream.AUTH_TOKEN
                    });
                    const best = ExportManager.pickBestLink(links);
                    if (best) {
                        directUrl = best.link;
                        if (window.showToast) window.showToast(`✅ Link extraído: ${best.servername} (${links.length} disponibles)`, "success");
                        console.log('[ExportToHosting] Links extraídos:', links);
                    } else {
                        if (window.showToast) window.showToast(`⚠️ ${streamData.providerName} no devolvió links válidos.`, "warning");
                    }
                } catch (extractErr) {
                    console.warn('[ExportToHosting] Fallo la extracción:', extractErr);
                    if (window.showToast) window.showToast(`⚠️ Extracción falló: ${extractErr.message}`, "warning");
                }
            }
        }

        // 3. 🔥 SUBIR A VOE (prioridad si hay API key configurada)
        const voeKey = SelvaStream.VOE_API_KEY;
        if (voeKey && directUrl) {
            if (window.showToast) window.showToast("🔥 Subiendo a VOE.sx (tu servidor propio)...", "info");
            try {
                await ExportManager.startVoeUpload({
                    movieId,
                    sourceUrl: directUrl,
                    voeKey,
                    onUpdate: async (update) => {
                        const { getFirestore, doc, updateDoc } = await import("firebase/firestore");
                        const db = getFirestore();
                        const updObj = { exportStatus: update.phase, updatedAt: Date.now() };
                        if (update.url) updObj.embed = update.url;
                        if (update.fileCode) updObj.exportFileId = update.fileCode;
                        await updateDoc(doc(db, "movies", movieId), updObj);

                        const memItem = _allInventoryItems.find(m => m.id === movieId);
                        if (memItem) {
                            memItem.exportStatus = update.phase;
                            if (update.url) memItem.embed = update.url;
                        }

                        if (update.message && window.showToast) {
                            window.showToast(update.message, update.phase === 'done' ? 'success' : 'info');
                        }
                        if (window.filterInventoryByCategory) window.filterInventoryByCategory();
                        if (SelvaStream.currentPlayerMovie?.id === movieId) {
                            if (update.url) SelvaStream.currentPlayerMovie.embed = update.url;
                            SelvaStream.renderVipMenuList();
                        }
                    }
                });

                // Marcar como 'processing' en Firestore inmediatamente
                if (isAuto) {
                    try {
                        const { getFirestore, doc, updateDoc } = await import("firebase/firestore");
                        const db = getFirestore();
                        await updateDoc(doc(db, "movies", movieId), { exportStatus: 'processing', updatedAt: Date.now() });
                        const memItem = _allInventoryItems.find(m => m.id === movieId);
                        if (memItem) memItem.exportStatus = 'processing';
                        if (window.filterInventoryByCategory) window.filterInventoryByCategory();
                    } catch(e) { console.warn('No se pudo marcar processing:', e); }
                }
            } catch (voeErr) {
                console.error('[ExportToHosting] VOE Error:', voeErr);
                if (window.showToast) window.showToast(`❌ VOE: ${voeErr.message}`, "error");
            }
            // Con VOE configurada, no necesitamos Streamtape también — salir aquí.
            if (!isAuto) window.showToast("🚀 Exportación a VOE enviada. Recibirás notificación al completar.", "success");
            return;
        }

        // 4. 📼 STREAMTAPE (fallback cuando no hay VOE key o falla)
        if (!directUrl) throw new Error("No hay un link válido para exportar.");

        const stLogin = SelvaStream.STREAMTAPE_LOGIN;
        const stKey = SelvaStream.STREAMTAPE_KEY;

        if (stLogin && stKey) {
            if (window.showToast) window.showToast("📤 Subiendo a Streamtape...", "info");
            
            const stApiUrl = `https://api.streamtape.com/remotedl/add?login=${stLogin}&key=${stKey}&url=${encodeURIComponent(directUrl)}`;
            const stRes = await fetch(stApiUrl);
            const stData = await stRes.json();

            if (stData.status === 200 && stData.result && stData.result.id) {
                const ticketId = stData.result.id;
                if (window.showToast) window.showToast("✅ Subida iniciada en Streamtape.", "success");
                
                if (isAuto) {
                    try {
                        const { getFirestore, doc, updateDoc } = await import("firebase/firestore");
                        const db = getFirestore();
                        await updateDoc(doc(db, "movies", movieId), { 
                            exportStatus: 'processing', 
                            exportTicketId: ticketId,
                            updatedAt: Date.now() 
                        });
                        const memItem = _allInventoryItems.find(m => m.id === movieId);
                        if (memItem) memItem.exportStatus = 'processing';
                        if (window.filterInventoryByCategory) window.filterInventoryByCategory(); 
                    } catch (e) {
                         console.error("No se pudo iniciar processing status", e);
                    }
                    
                    ExportManager.startPolling({
                        movieId,
                        ticketId,
                        stLogin,
                        stKey,
                        onUpdate: async (update) => {
                            const { getFirestore, doc, updateDoc } = await import("firebase/firestore");
                            const db = getFirestore();
                            const updObj = { exportStatus: update.phase, updatedAt: Date.now() };
                            
                            if (update.url) updObj.embed = update.url;
                            if (update.fileId) updObj.exportFileId = update.fileId;
                            
                            await updateDoc(doc(db, "movies", movieId), updObj);

                            const memItem = _allInventoryItems.find(m => m.id === movieId);
                            if (memItem) {
                                memItem.exportStatus = update.phase;
                                if (update.url) memItem.embed = update.url;
                            }

                            if (update.message && window.showToast) {
                                window.showToast(update.message, update.phase === 'done' ? 'success' : 'info');
                            }

                            if (window.filterInventoryByCategory) window.filterInventoryByCategory();
                            
                            if (SelvaStream.currentPlayerMovie?.id === movieId) {
                                if (update.url) SelvaStream.currentPlayerMovie.embed = update.url;
                                SelvaStream.renderVipMenuList();
                            }
                        }
                    });
                }
            } else {
                console.warn("Error en API de Streamtape:", stData);
                if (window.showToast) window.showToast(`⚠️ Streamtape: ${stData.msg || 'Error desconocido'}`, "warning");
            }
        }

        // 5. Doodstream (Opcional)
        const dsKey = SelvaStream.DOODSTREAM_KEY;
        if (dsKey && directUrl) {
            if (window.showToast) window.showToast("📤 Subiendo a Doodstream...", "info");
            const dsApiUrl = `https://doodapi.com/api/remotedl/add?key=${dsKey}&url=${encodeURIComponent(directUrl)}`;
            await fetch(dsApiUrl);
        }

        if (!isAuto) {
            if (window.showToast) window.showToast("🚀 Exportación enviada con éxito. Revisa tus paneles en unos minutos.", "success");
        }

    } catch (e) {
        console.error("Error en exportación mágica:", e);
        if (window.showToast) window.showToast(`❌ Error: ${e.message}`, "error");
    }
};


// removed renderChannels

window.handleChannelClick = (url) => {
  const modal = document.getElementById('player-modal');
  modal.style.display = 'flex';
  document.getElementById('server-switcher').style.display = 'none';
  document.getElementById('ad-overlay').style.display = 'none';
  window.setIframeSource('player-iframe', url);
};

// Helper para normalizar texto (Quitar tildes y caracteres especiales)
window.normalizeText = (str) => {
  if (!str) return "";
  return str.toString()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .trim();
};

// 🔍 Buscador móvil: overlay a ancho completo que se abre desde la barra inferior.
// Reutiliza handleGlobalSearch (los resultados se pintan en #main-content del Home).
window.openMobileSearch = () => {
  const bar = document.getElementById('mobile-search-bar');
  const input = document.getElementById('mobile-search-input');
  if (!bar || !input) return;

  // Los resultados se pintan en el Home, así que nos aseguramos de estar ahí.
  const hash = window.location.hash.substring(1) || '';
  if (hash.startsWith('detail/') || hash === 'admin' || hash === 'mylist') {
    if (typeof SelvaStream !== 'undefined') SelvaStream.close();
    showView('home-view');
  }

  bar.style.display = 'flex';
  // Pequeño delay: en móvil el foco inmediato a veces no abre el teclado.
  setTimeout(() => input.focus(), 60);
};

window.closeMobileSearch = () => {
  const bar = document.getElementById('mobile-search-bar');
  const input = document.getElementById('mobile-search-input');
  if (input) {
    input.value = '';
    handleGlobalSearch(''); // limpia resultados → vuelve al Home normal
    input.blur();
  }
  if (bar) bar.style.display = 'none';
};

// Se apagan/prenden junto con la búsqueda — sin esto el banner (que además
// se re-muestra solo cada 10s por startHeroAutoRotation) y las filas de
// "Continuar viendo"/"Mi Lista" quedaban pisando los resultados en vez de
// dejar solo la lista filtrada.
const _searchExtraSectionIds = ['hero-section', 'genre-bar', 'continue-watching-row', 'my-list-row'];
let _isSearchActive = false;
let _preSearchDisplay = null;

// Global Search (Filter)
function handleGlobalSearch(query) {
  const normQuery = window.normalizeText(query);
  const allMovies = [...movieDatabase.trending].filter(m => m.status !== 'review');

  const filtered = allMovies.filter(m => {
    const title = window.normalizeText(m.title);
    const origTitle = window.normalizeText(m.original_title || "");
    const director = window.normalizeText(m.director || "");
    const aliases = (m.alternative_titles || []).map(a => window.normalizeText(a));

    return title.includes(normQuery) ||
           origTitle.includes(normQuery) ||
           director.includes(normQuery) ||
           aliases.some(a => a.includes(normQuery));
  });

  const container = document.getElementById('main-content');
  container.innerHTML = '';

  const extraSections = _searchExtraSectionIds.map(id => document.getElementById(id)).filter(Boolean);

  if (query) {
    _isSearchActive = true;
    if (!_preSearchDisplay) {
      _preSearchDisplay = {};
      extraSections.forEach(el => { _preSearchDisplay[el.id] = el.style.display; });
    }
    extraSections.forEach(el => { el.style.display = 'none'; });

    // Grilla (2-3 por fila, hacia abajo) en vez de carrusel horizontal — con
    // muchos resultados un carrusel de una sola fila obligaba a scrollear
    // de costado para verlos todos, en vez de bajar como cualquier listado.
    if (filtered.length > 0) renderGallery(`Resultados para "${query}"`, [{ label: `Resultados para "${query}"`, items: filtered }]);
    else container.insertAdjacentHTML('beforeend', `<p style="padding: 50px; text-align: center; color: var(--text-muted);">No se encontro nada en esta selva... 🕵️‍♂️🥥</p>`);
  } else {
    _isSearchActive = false;
    if (_preSearchDisplay) {
      extraSections.forEach(el => { el.style.display = _preSearchDisplay[el.id] || ''; });
      _preSearchDisplay = null;
    }
    initApp();
  }
}

// Render Movie Rows in Chunks (v4.4)
function _renderCardsInto(container, data, isTrending = false) {
  if (!data || data.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);padding:30px;">La selva está vacía aquí... 🌿</p>';
    return;
  }

  const CHUNK_SIZE = 12;
  let currentIndex = 0;
  container.innerHTML = '';

  function renderNextChunk() {
    const chunk = data.slice(currentIndex, currentIndex + CHUNK_SIZE);
    const html = chunk.map((item, idx) => {
        const isFavorite = window._myListIds && window._myListIds.has(item.id);
        const favClass = isFavorite ? 'active' : '';
        const favIcon = isFavorite ? '❤️' : '🤍';
        const rank = currentIndex + idx + 1;
        
        // Obtener género (traducido: TMDB da IDs numéricos, no nombres)
        const genreId = item.genres ? (Array.isArray(item.genres) ? item.genres[0] : item.genres) : '';
        const genre = GENRE_MAP[String(genreId)] || 'Película';

        const isBroken = item.status === 'broken' || (window._brokenIds && window._brokenIds.has(item.id));
        let statusBadgeHtml = '';
        if (isBroken) {
          statusBadgeHtml = `<div class="badge-maintenance" style="background:#FF5252; color:white;">Sin Fuentes</div>`;
        } else if (item.status === 'maintenance') {
          statusBadgeHtml = `<div class="badge-maintenance">Mantenimiento</div>`;
        }

        
        const cardHtml = `
            <div class="cinepulse-movie-card" data-id="${item.id}" tabindex="0" role="button" data-tvnav onclick="window.handleCardClick('${item.id}')">
              <img src="${item.img || ''}" alt="${item.title}" loading="lazy"
                onerror="window.rescatarPoster(this, '${item.tmdbId || ''}', '${item.type || 'movie'}')">
              <div class="cinepulse-card-overlay"></div>
              <div class="btn-add-list ${favClass}" onclick="event.stopPropagation(); window.toggleMyList('${item.id}', this)" title="Añadir a mi selva" style="position: absolute; top: 10px; right: 10px; z-index: 5; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); border-radius: 50%; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; border: 1px solid rgba(255,255,255,0.2);">
                ${favIcon}
              </div>
              ${statusBadgeHtml}
              ${item.isVIP ? `
                <div class="vip-badge-sm" style="position: absolute; top: 10px; left: 10px; z-index: 5; background: linear-gradient(45deg, #FFD700, #FFA500); color: black; font-size: 0.55rem; font-weight: 900; padding: 2px 6px; border-radius: 4px; display: flex; align-items: center; gap: 2px; box-shadow: 0 0 10px rgba(255,165,0,0.3);">
                  <span>👑</span>
                  <span>VIP</span>
                </div>
              ` : ''}
              ${item.vimeusDisponible ? `
                <div class="vimeus-badge-sm" style="position: absolute; top: ${item.isVIP ? '38px' : '10px'}; left: 10px; z-index: 5; background: rgba(46,204,113,0.92); color: #06210f; font-size: 0.55rem; font-weight: 900; padding: 2px 6px; border-radius: 4px; display: flex; align-items: center; gap: 2px; box-shadow: 0 0 8px rgba(46,204,113,0.35);" title="Confirmado en Vimeus: la fuente que mejor y más rápido funciona">
                  <span>⭐</span>
                  <span>ÓPTIMO</span>
                </div>
              ` : ''}
              <div class="cinepulse-card-content">
                <h3 class="cinepulse-card-title">${item.title}</h3>
                <div class="cinepulse-card-meta">
                  ${item.year ? `<span class="cinepulse-card-year">${item.year}</span>` : ''}
                  <span class="cinepulse-card-genre">${genre}</span>
                  ${item.rating ? `
                  <span class="cinepulse-card-rating">
                    <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1; font-size: 12px;">star</span>
                    ${(parseFloat(item.rating) || 0).toFixed(1)}
                  </span>` : ''}
                </div>
              </div>
            </div>
        `;

        if (isTrending) {
          return `
            <div class="trending-card-wrapper" style="position: relative;">
              <div class="trending-rank-number" style="position: absolute; top: -10px; left: -10px; background: var(--primary); color: black; font-size: 1.5rem; font-weight: 900; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 15px rgba(255,102,0,0.5); z-index: 10;">${rank}</div>
              ${cardHtml}
            </div>
          `;
        }
        return cardHtml;
    }).join('');

    container.insertAdjacentHTML('beforeend', html);
    currentIndex += CHUNK_SIZE;

    if (currentIndex < data.length) {
      requestAnimationFrame(renderNextChunk);
    }
  }

  renderNextChunk();
}

function renderRecommendedWide(data) {
  const container = document.getElementById('main-content');
  if (!container || !data || data.length < 2) return;
  
  const section = document.createElement('section');
  section.className = 'cinepulse-section';
  
  const cardsHtml = data.slice(0, 4).map(item => {
    const genre = item.genres ? (Array.isArray(item.genres) ? item.genres[0] : item.genres) : '';
    const badge = item.isVIP ? '👑 Estreno VIP' : (item.pinned ? '🔥 Destacado' : '🍹 Favorito');
    return `
      <div class="cinepulse-recommended-card" tabindex="0" role="button" data-tvnav onclick="window.handleCardClick('${item.id}')">
        <img src="${item.backdrop || item.img}" alt="${item.title}" loading="lazy"
          onerror="this.src='https://via.placeholder.com/800x400/1a1a1a/FF6600?text=SelvaFlix';">
        <div class="rec-gradient"></div>
        <div class="rec-content">
          <span class="cinepulse-rec-badge">${badge}</span>
          <h3 class="cinepulse-rec-title">${item.title}</h3>
          <p class="cinepulse-rec-desc">${item.description || item.overview || ''}</p>
          <div class="cinepulse-rec-buttons">
            <button class="cinepulse-rec-btn-play" onclick="event.stopPropagation(); window.handleCardClick('${item.id}')">
              <span class="material-symbols-outlined" style="font-size:1rem;font-variation-settings:'FILL' 1;">play_arrow</span> Ver Ahora
            </button>
            <button class="cinepulse-rec-btn-details" onclick="event.stopPropagation(); window.handleCardClick('${item.id}')">Detalles</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
  
  section.innerHTML = `
    <h2 class="cinepulse-section-title">Recomendado para ti</h2>
    <div class="cinepulse-recommended-grid">${cardsHtml}</div>
  `;
  
  container.appendChild(section);
}

function renderRow(title, data, seeAllHash = '') {
  const container = document.getElementById('main-content');
  if (!data) return;
  const section = document.createElement('section');
  section.className = 'cinepulse-section';
  section.innerHTML = `
    <h2 class="cinepulse-section-title">${title}</h2>
    <div class="cinepulse-movie-list"></div>
  `;
  container.appendChild(section);

  const list = section.querySelector('.cinepulse-movie-list');
  const isTrending = title.toLowerCase().includes('tendencias');
  _renderCardsInto(list, data, isTrending);
}

// Galería de página completa con Chunking (v4.4)
function renderGallery(title, groups) {
  const container = document.getElementById('main-content');
  container.innerHTML = '';

  groups.forEach(({ label, items }) => {
    if (!items || items.length === 0) return;
    const section = document.createElement('section');
    section.className = 'cinepulse-section';
    section.innerHTML = `
      <h2 class="cinepulse-section-title">${label} <span style="font-size:0.85rem;color:var(--on-surface-variant);font-weight:400;">(${items.length})</span></h2>
      <div class="gallery-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 24px; padding: 0 0 30px;"></div>
    `;
    container.appendChild(section);

    const grid = section.querySelector('.gallery-grid');
    const CHUNK_SIZE = 12;
    let currentIndex = 0;

    function renderNextChunk() {
      const chunk = items.slice(currentIndex, currentIndex + CHUNK_SIZE);
      const html = chunk.map(item => {
        const isFavorite = window._myListIds && window._myListIds.has(item.id);
        const favClass = isFavorite ? 'active' : '';
        const favIcon = isFavorite ? '❤️' : '🤍';
        const genreId = item.genres ? (Array.isArray(item.genres) ? item.genres[0] : item.genres) : '';
        const genre = GENRE_MAP[String(genreId)] || 'Película';

        const isBroken = item.status === 'broken' || (window._brokenIds && window._brokenIds.has(item.id));
        let statusBadgeHtml = '';
        if (isBroken) {
          statusBadgeHtml = `<div class="badge-maintenance" style="background:#FF5252; color:white;">Sin Fuentes</div>`;
        } else if (item.status === 'maintenance') {
          statusBadgeHtml = `<div class="badge-maintenance">Mantenimiento</div>`;
        }


        return `
          <div class="cinepulse-movie-card gallery-card" data-id="${item.id}" tabindex="0" role="button" data-tvnav onclick="window.handleCardClick('${item.id}')">
            <img src="${item.img || ''}" alt="${item.title}" loading="lazy"
              onerror="window.rescatarPoster(this, '${item.tmdbId || ''}', '${item.type || 'movie'}')">
            <div class="cinepulse-card-overlay"></div>
            <div class="btn-add-list ${favClass}" onclick="event.stopPropagation(); window.toggleMyList('${item.id}', this)" title="Añadir a mi selva" style="position: absolute; top: 10px; right: 10px; z-index: 5; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); border-radius: 50%; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; border: 1px solid rgba(255,255,255,0.2);">
                ${favIcon}
            </div>
            ${statusBadgeHtml}
            ${item.isVIP ? `
              <div class="vip-badge-sm" style="position: absolute; top: 10px; left: 10px; z-index: 5; background: linear-gradient(45deg, #FFD700, #FFA500); color: black; font-size: 0.55rem; font-weight: 900; padding: 2px 6px; border-radius: 4px; display: flex; align-items: center; gap: 2px; box-shadow: 0 0 10px rgba(255,165,0,0.3);">
                <span>👑</span>
                <span>VIP</span>
              </div>
            ` : ''}
            ${item.vimeusDisponible ? `
              <div class="vimeus-badge-sm" style="position: absolute; top: ${item.isVIP ? '38px' : '10px'}; left: 10px; z-index: 5; background: rgba(46,204,113,0.92); color: #06210f; font-size: 0.55rem; font-weight: 900; padding: 2px 6px; border-radius: 4px; display: flex; align-items: center; gap: 2px; box-shadow: 0 0 8px rgba(46,204,113,0.35);" title="Confirmado en Vimeus: la fuente que mejor y más rápido funciona">
                <span>⭐</span>
                <span>ÓPTIMO</span>
              </div>
            ` : ''}
            <div class="cinepulse-card-content">
              <h3 class="cinepulse-card-title">${item.title}</h3>
              <div class="cinepulse-card-meta">
                ${item.year ? `<span class="cinepulse-card-year">${item.year}</span>` : ''}
                <span class="cinepulse-card-genre">${genre}</span>
                ${item.rating ? `
                <span class="cinepulse-card-rating">
                  <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1; font-size: 12px;">star</span>
                  ${(parseFloat(item.rating) || 0).toFixed(1)}
                </span>` : ''}
              </div>
            </div>
          </div>
        `;
      }).join('');

      grid.insertAdjacentHTML('beforeend', html);
      currentIndex += CHUNK_SIZE;

      if (currentIndex < items.length) {
        requestAnimationFrame(renderNextChunk);
      }
    }

    renderNextChunk();
  });

  if (container.children.length === 0) {
    container.innerHTML = '<p style="padding:80px;text-align:center;color:var(--text-muted);">La selva está vacía por aquí... 🌿</p>';
  }
}


// Admin: Render Inventory Grid (Compact & Visual)
let _allInventoryItems = [];
let _inventoryPage = 1;
const _inventoryPerPage = 50;

function renderInventory() {
  // Incluir TODOS para admin (incluyendo review), ordenados por fecha
  _allInventoryItems = [...movieDatabase.trending].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  _inventoryPage = 1;

  // Cargar reportes primero para que el contador y filtro funcionen
  window.loadReports().then(() => {
    _updateDetailedStats(_allInventoryItems);
    
    // ✅ FIX NAVEGACIÓN: En lugar de renderizar el default 'all', usamos lo que esté en los selectores
    // para que al volver del player se mantengan los filtros aplicados.
    if (window.filterInventoryByCategory) {
        window.filterInventoryByCategory();
    } else {
        _renderInventoryRows(_allInventoryItems.filter(m => m.status !== 'review' && m.status !== 'waiting'));
    }
  });
}

function _updateDetailedStats(items) {
  const m = items.filter(i => i.type === 'movie' || !i.type).length;
  const s = items.filter(i => i.type === 'series' || i.type === 'tv' || i.type === 'anime').length;
  const b = items.filter(i => i.status === 'broken' || window._brokenIds.has(i.id)).length;
  const r = window._reportedIds ? window._reportedIds.size : 0;
  const w = items.filter(i => i.status === 'waiting').length;
  const rev = items.filter(i => i.status === 'review').length;

  // Actualizar estadísticas superiores (Mockeado del mock + Real)
  const totalVal = m + s;
  const liveVal = items.filter(i => i.status === 'healthy' && !window._brokenIds.has(i.id)).length;
  const curationVal = rev + items.filter(i => i.status === 'verify').length;
  const archivedVal = b + w;

  const countTotalEl = document.getElementById('count-total-titles');
  const countLiveEl = document.getElementById('count-live-now');
  const countCurationEl = document.getElementById('count-in-curation');
  const countArchivedEl = document.getElementById('count-archived');

  if (countTotalEl) countTotalEl.innerText = totalVal.toLocaleString();
  if (countLiveEl) countLiveEl.innerText = liveVal.toLocaleString();
  if (countCurationEl) countCurationEl.innerText = curationVal.toLocaleString();
  if (countArchivedEl) countArchivedEl.innerText = archivedVal.toLocaleString();

  // 📊 Resumen en la pestaña "Gestión de Catálogo": conteo por tipo, en
  // revisión, y cuántos títulos están confirmados en Vimeus vs. dependiendo
  // de las fuentes públicas de respaldo (FlixLatam, DiPelis, RepelisHD).
  const seriesVal = items.filter(i => i.type === 'series' || i.type === 'tv').length;
  const animeVal = items.filter(i => i.type === 'anime').length;
  const voeVal = items.filter(i => i.embed && i.embed.includes('voe')).length;
  const vimeusVal = items.filter(i => i.vimeusDisponible === true && (!i.embed || !i.embed.includes('voe'))).length;
  const respaldoVal = items.filter(i => i.vimeusDisponible === false && (!i.embed || !i.embed.includes('voe'))).length;
  const sinVerificarVal = items.length - vimeusVal - respaldoVal - voeVal;

  const setStat = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val.toLocaleString(); };
  setStat('cstat-total', items.length);
  setStat('cstat-movies', m);
  setStat('cstat-series', seriesVal);
  setStat('cstat-anime', animeVal);
  setStat('cstat-review', rev);
  setStat('cstat-voe', voeVal);
  setStat('cstat-vimeus', vimeusVal);
  setStat('cstat-respaldo', respaldoVal);
  setStat('cstat-sinverificar', sinVerificarVal);


  // 📡 Señales del Sistema con datos REALES (no mock)
  const catDesc = document.getElementById('insight-catalog-desc');
  if (catDesc) {
    catDesc.innerHTML = `<b>${totalVal}</b> títulos · <b style="color:#2ECC71;">${liveVal}</b> en línea · <b style="color:#E74C3C;">${b}</b> rotos · <b style="color:#f1c40f;">${curationVal}</b> en curación.`;
  }
  // Más reproducido: usa el conteo local de plays (selva_play_counts)
  try {
    const counts = JSON.parse(localStorage.getItem('selva_play_counts') || '{}');
    const entries = Object.entries(counts).sort((a, b2) => b2[1] - a[1]);
    const topDesc = document.getElementById('insight-top-desc');
    const topTitleEl = document.getElementById('insight-top-title');
    if (topDesc) {
      if (entries.length === 0) {
        topDesc.textContent = 'Aún no hay reproducciones registradas.';
        if (topTitleEl) topTitleEl.textContent = 'Más reproducido';
      } else {
        const [topKey, topPlays] = entries[0];
        const topMovie = items.find(i => String(i.tmdbId) === topKey || String(i.id) === topKey);
        if (topTitleEl) topTitleEl.textContent = topMovie ? topMovie.title : 'Título ' + topKey;
        topDesc.innerHTML = `<b>${topPlays}</b> reproducción(es). En total <b>${entries.reduce((s2, e) => s2 + e[1], 0)}</b> plays en ${entries.length} título(s).`;
      }
    }
  } catch (e) { /* ignore */ }
}

window.loadMoreInventory = () => {
  _inventoryPage++;
  _renderInventoryRows(_allInventoryItems);
};

// Mapea IDs de género a nombres amigables
// Mismos nombres en español que usan las chips de género públicas
// (Acción, Comedia, etc.) para que la tarjeta y el filtro digan lo mismo,
// en vez del ID crudo de TMDB ("16") que se mostraba antes.
const GENRE_MAP = {
  "28": "Acción", "12": "Aventura", "16": "Animación", "35": "Comedia", "80": "Crimen",
  "99": "Documental", "18": "Drama", "10751": "Familiar", "14": "Fantasía", "36": "Historia",
  "27": "Terror", "10402": "Música", "9648": "Misterio", "10749": "Romance", "878": "Sci-Fi",
  "10770": "TV Movie", "53": "Suspenso", "10752": "Bélica", "37": "Western", "10759": "Acción"
};

function _renderInventoryRows(items) {
  const tableBody = document.getElementById('admin-catalog-table-body');
  const status = document.getElementById('inventory-status');
  const loadMore = document.getElementById('load-more-container');

  if (!tableBody) return;

  if (items.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center; padding:50px; color:var(--admin-text-muted);">
          No se encontraron tesoros con ese filtro... 🍃🕵️‍♂️
        </td>
      </tr>
    `;
    if (loadMore) loadMore.style.display = 'none';
    if (status) status.innerText = "0 títulos encontrados.";
    return;
  }

  const end = _inventoryPage * _inventoryPerPage;
  const visibleItems = items.slice(0, end);

  if (status) status.innerText = `Showing 1-${visibleItems.length} of ${items.length} items`;
  if (loadMore) loadMore.style.display = end < items.length ? 'block' : 'none';

  tableBody.innerHTML = visibleItems.map(m => {
    // Mismo bug que el filtro "Sin Fuentes": _brokenIds es un Set aparte
    // que solo llena runBotHealthCheck/markAsBroken. auditarCatalogoCompleto()
    // marca sin fuentes escribiendo status:'broken' directo -- sin este OR,
    // el filtro ya encontraba la fila pero la etiqueta seguía diciendo "Live".
    const isBroken = m.status === 'broken' || window._brokenIds.has(m.id);
    const isWaiting = m.status === 'waiting';
    const isReview = m.status === 'review';
    
    // Status Pill Class & Label
    let statusClass = 'live';
    let statusLabel = 'Live';
    if (isBroken) {
      statusClass = 'archived';
      statusLabel = 'Broken';
    } else if (isWaiting) {
      statusClass = 'scheduled';
      statusLabel = 'Waiting';
    } else if (isReview) {
      statusClass = 'scheduled';
      statusLabel = 'Curation';
    }

    // Genre badges mapping
    const genres = (m.genreIds || []).slice(0, 2).map(id => {
      const gName = GENRE_MAP[String(id)] || 'Movie';
      return `<span class="genre-badge">${gName}</span>`;
    }).join('') || `<span class="genre-badge">${m.type === 'series' ? 'Series' : 'Movie'}</span>`;

    const cleanTitle = m.title || 'Untitled Movie';
    const cleanId = m.imdbId || m.tmdbId || m.id;
    const releaseDate = m.year ? `Dec 05, ${m.year}` : 'Unknown';

    // A pedido: marca a la vista cuáles títulos no tienen Vimeus (nunca
    // matcheó), son "Fantasma" (matcheó por tmdb/imdb pero sin contenido
    // real cargado del otro lado — ver vimeusEstadoTitulo), o directamente
    // nunca pasaron por la auditoría todavía (vimeusDisponible === undefined).
    // Antes ese último caso no mostraba ningún badge, indistinguible de un
    // título realmente confirmado — por eso títulos como "El polígamo" o
    // "Spider-Noir" parecían estar bien cuando en realidad solo faltaba
    // correr "Auditar Vimeus" sobre ellos.
    let vimeusBadge = '';
    if (m.vimeusFantasma) {
      vimeusBadge = `<span class="genre-badge" style="background:rgba(155,89,182,0.15); color:#9b59b6; border:1px solid rgba(155,89,182,0.35);" title="Vimeus matchea el título pero no hay video real: temporadas/embeds vacíos, o el host de video detrás del embed está caído">👻 Fantasma</span>`;
    } else if (m.vimeusDisponible === false) {
      vimeusBadge = `<span class="genre-badge" style="background:rgba(255,82,82,0.12); color:#FF5252; border:1px solid rgba(255,82,82,0.3);" title="Vimeus no tiene este título">🚫 Sin Vimeus</span>`;
    } else if (m.vimeusDisponible === undefined && (m.imdbId || m.tmdbId)) {
      vimeusBadge = `<span class="genre-badge" style="background:rgba(255,255,255,0.06); color:#888; border:1px solid rgba(255,255,255,0.12);" title="Todavía no pasó por 'Auditar Vimeus' — no se sabe si tiene fuente real o no">❔ Sin Verificar</span>`;
    }

    // A diferencia del resto de badges (que marcan la excepción con problema),
    // acá casi ningún título tiene downloadUrl todavía, así que remarcar
    // "Sin Descarga" en cada fila sería puro ruido — se marca solo la
    // excepción positiva (los que ya tienen link) y el resto se ve con el
    // filtro "⬇️ Sin Descarga" del combo de arriba.
    const downloadBadge = m.downloadUrl
      ? `<span class="genre-badge" style="background:rgba(46,204,113,0.12); color:#2ecc71; border:1px solid rgba(46,204,113,0.3);" title="Tiene link de descarga cargado">⬇️ Con Descarga</span>`
      : '';

    return `
      <tr data-id="${m.id}">
        <td style="text-align: center;">
          <input type="checkbox" class="selva-check" data-id="${m.id}" onchange="window.updateSelectedCount()" style="cursor:pointer; accent-color: var(--admin-accent-orange); width: 15px; height: 15px;">
        </td>
        <td>
          <div class="cell-poster">
            <img src="${m.img || ''}" loading="lazy" onerror="window.rescatarPoster(this, '${m.tmdbId || ''}', '${m.type || 'movie'}')" alt="poster">
          </div>
        </td>
        <td>
          <div class="cell-title-block">
            <span class="cell-title-name">${cleanTitle}</span>
            <span class="cell-title-id">ID: CP-${cleanId.toString().substring(0, 6)}</span>
          </div>
        </td>
        <td>
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
            ${genres}${vimeusBadge}${downloadBadge}
          </div>
        </td>
        <td>
          <span style="font-size: 0.78rem; color: #a1a1aa;">${releaseDate}</span>
        </td>
        <td>
          <span class="status-pill ${statusClass}">${statusLabel}</span>
        </td>
        <td>
          <div class="table-actions-container">
            <button class="table-action-btn" onclick="window.handleCardClick('${m.id}')" title="Probar / Reproducir">
              <span class="material-symbols-outlined">play_arrow</span>
            </button>
            <button class="table-action-btn" onclick="window.editMovie('${m.id}')" title="Editar Metadatos">
              <span class="material-symbols-outlined">edit</span>
            </button>
            <button class="table-action-btn delete-btn" onclick="window.deleteMovie('${m.id}')" title="Borrar">
              <span class="material-symbols-outlined">delete</span>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

window.updateSelectedCount = () => {
  const allChecks = Array.from(document.querySelectorAll('#admin-catalog-table-body .selva-check'));
  const selected = allChecks.filter(c => c.checked).length;
  
  const bulkPanel = document.getElementById('bulk-actions-panel');
  const countSpan = document.getElementById('selected-count');
  const checkAll = document.getElementById('check-all-inventory');

  if (countSpan) countSpan.innerText = selected;
  if (bulkPanel) bulkPanel.style.display = selected > 0 ? 'flex' : 'none';

  if (checkAll) {
    checkAll.checked = allChecks.length > 0 && selected === allChecks.length;
  }
};

// ─── Admin Tab Navigation (CinePulse Portal) ────────────────────────────────
const ADMIN_TABS = ['dashboard', 'catalog', 'users', 'analytics', 'ads', 'plans', 'actions', 'messages'];

// Carga perezosa del módulo de Analíticas: el import() solo se dispara la
// primera vez que se abre esa pestaña, y la promesa queda cacheada para no
// repetirlo. Un visitante que nunca entra al admin jamás pide este archivo.
let _analiticasPromesa = null;
const cargarAnaliticas = () => {
  if (!_analiticasPromesa) {
    _analiticasPromesa = import('./admin/analytics.js').then(m => {
      m.init({ db, collection, query, where, orderBy, getDocs });
      return m;
    }).catch(e => {
      _analiticasPromesa = null; // que un fallo de red no lo deje roto para siempre
      throw e;
    });
  }
  return _analiticasPromesa;
};

window.switchAdminTab = (tab) => {
  // Hide all tab panes
  ADMIN_TABS.forEach(t => {
    const pane = document.getElementById(`admin-${t}-tab`);
    if (pane) pane.style.display = 'none';

    // Also hide legacy IDs for backwards-compat
    const legacyMap = {
      catalog: 'admin-inventory-tab',
      analytics: 'admin-metrics-tab',
      actions: 'admin-actions-tab',
      ads: 'admin-ads-tab',
    };
    if (legacyMap[t]) {
      const legacy = document.getElementById(legacyMap[t]);
      if (legacy && legacy !== pane) legacy.style.display = 'none';
    }

    // Remove active class from all sidebar buttons
    const btn = document.getElementById(`btn-admin-${t}`);
    if (btn) btn.classList.remove('active');
  });

  // Show the selected pane
  const activePane = document.getElementById(`admin-${tab}-tab`);
  if (activePane) activePane.style.display = 'block';

  // Activate sidebar button
  const activeBtn = document.getElementById(`btn-admin-${tab}`);
  if (activeBtn) activeBtn.classList.add('active');

  // Tab-specific logic
  if (tab === 'catalog') {
    renderInventory();
  } else if (tab === 'analytics') {
    // El módulo de Analíticas se baja recién ahora, la primera vez que se abre
    // esta pestaña. init() le pasa Firestore para que no vuelva a arrancar
    // Firebase por su cuenta (ni genere un import circular con este archivo).
    cargarAnaliticas().then(() => {
      if (typeof window.initMetricsSelectors === 'function') window.initMetricsSelectors();
      // Respeta el rango ya elegido (o el default que acaba de fijar initMetricsSelectors)
      // en lugar de resetearlo siempre al mes actual.
      if (typeof window.applyMetricsFilters === 'function') window.applyMetricsFilters();
      if (typeof window._loadFcmSubsCount === 'function') window._loadFcmSubsCount();
    }).catch(e => {
      console.error('No se pudo cargar el módulo de Analíticas:', e);
      if (window.showToast) window.showToast('No se pudieron cargar las Analíticas.', 'error');
    });
  } else if (tab === 'ads') {
    // load* ya no dibuja (ver nota en loadAdConfig): pintar la lista es cosa del admin.
    if (typeof window.loadAdConfig === 'function') {
      Promise.resolve(window.loadAdConfig()).then(() => window.renderAdCampaignList?.());
    }
  } else if (tab === 'plans') {
    if (typeof window.loadPlansConfig === 'function') {
      Promise.resolve(window.loadPlansConfig()).then(() => window.renderPlansList?.());
    }
    if (typeof window.loadTrialOffers === 'function') window.loadTrialOffers();
    if (typeof window.loadStreakConfig === 'function') window.loadStreakConfig();
  } else if (tab === 'users') {
    if (typeof window.loadRegisteredUsers === 'function') window.loadRegisteredUsers();
  } else if (tab === 'messages') {
    if (typeof window.loadAdminMessages === 'function') window.loadAdminMessages();
  } else if (tab === 'dashboard') {
    // Refresh dashboard stats using already-loaded inventory
    if (_allInventoryItems && _allInventoryItems.length > 0) {
      _updateDetailedStats(_allInventoryItems);
    }
    if (typeof window.loadPremiumCount === 'function') window.loadPremiumCount();
  }
};

// ─── Upload / Edit Drawer ───────────────────────────────────────────────────
window.openUploadDrawer = () => {
  const drawer = document.getElementById('admin-form-drawer');
  const overlay = document.getElementById('admin-drawer-overlay');
  if (drawer) drawer.classList.add('open');
  if (overlay) overlay.style.display = 'block';

  // Reset form to "Add New" mode
  const formTitle = document.getElementById('drawer-form-title');
  const editingId = document.getElementById('editing-movie-id');
  const breadcrumb = document.getElementById('drawer-breadcrumb-action');
  if (formTitle) formTitle.textContent = 'Agregar Nuevo Título';
  if (breadcrumb) breadcrumb.textContent = 'Agregar Película';
  if (editingId) editingId.value = '';

  // Limpiar TODOS los campos del formulario: antes solo se reseteaban el
  // título/breadcrumb y las previsualizaciones de imagen, así que si venías
  // de editar una película "Sana" y apretabas "+ Agregar Título", el estado
  // (y el resto de los campos) se quedaban pegados con el valor anterior.
  const clearField = (id, val = '') => { const el = document.getElementById(id); if (el) el.value = val; };
  ['m-db-id', 'm-imdb-id', 'm-original-title', 'm-alternative-titles', 'm-title', 'm-tmdb-id',
   'm-synopsis', 'm-director', 'm-cast', 'm-genres', 'm-embed', 'm-img', 'm-backdrop',
   'm-release-date', 'm-preferred-provider', 'm-download-url', 'm-franchise'].forEach(id => clearField(id));

  poblarListaFranquicias();

  clearField('m-status', 'review');
  clearField('m-type', 'movie');
  clearField('m-rating', '4.8');
  clearField('m-lang', 'es-MX');

  const publicServersList = document.getElementById('drawer-public-servers-list'); if (publicServersList) publicServersList.innerHTML = '';

  const pinned = document.getElementById('m-pinned'); if (pinned) pinned.checked = false;
  const isVip = document.getElementById('m-is-vip'); if (isVip) isVip.checked = false;
  const vipOptions = document.getElementById('m-vip-options'); if (vipOptions) vipOptions.style.display = 'none';
  const showCountdown = document.getElementById('m-show-countdown'); if (showCountdown) showCountdown.checked = true;

  const genreTagsContainer = document.getElementById('genre-tags-container');
  if (genreTagsContainer) genreTagsContainer.innerHTML = '<button type="button" onclick="window.addGenreTag()" class="add-tag-btn">+ Agregar</button>';

  // Reset editor de episodios (Series/Anime)
  _currentEpisodesMap = {};
  _currentEpisodesSeasons = null;
  const epSeasonSelect = document.getElementById('ep-season-select'); if (epSeasonSelect) epSeasonSelect.innerHTML = '';
  const epRows = document.getElementById('ep-rows-container'); if (epRows) epRows.innerHTML = '';
  const epStatus = document.getElementById('ep-editor-status'); if (epStatus) epStatus.textContent = '';
  window.toggleEpisodesCardVisibility();

  const submitBtn = document.getElementById('submit-btn');
  const cancelEditBtn = document.getElementById('cancel-edit');
  if (submitBtn) submitBtn.innerHTML = '<span class="material-symbols-outlined">save</span> Guardar Cambios';
  if (cancelEditBtn) cancelEditBtn.style.display = 'none';

  const tmdbSearchInput = document.getElementById('tmdb-search-input');
  const tmdbResults = document.getElementById('tmdb-results');
  const tmdbImgSuggestions = document.getElementById('tmdb-img-suggestions');
  if (tmdbSearchInput) tmdbSearchInput.value = '';
  if (tmdbResults) tmdbResults.innerHTML = '';
  if (tmdbImgSuggestions) tmdbImgSuggestions.innerHTML = '';

  const scrapedSection = document.getElementById('drawer-scraped-links-section');
  const scrapedList = document.getElementById('drawer-scraped-links-list');
  if (scrapedSection) scrapedSection.style.display = 'none';
  if (scrapedList) scrapedList.innerHTML = '';

  const embedPreview = document.getElementById('admin-embed-preview');
  if (embedPreview) embedPreview.style.display = 'none';

  const vimeusStatus = document.getElementById('vimeus-auto-status');
  const vimeusList = document.getElementById('vimeus-auto-sources-list');
  if (vimeusStatus) vimeusStatus.textContent = '';
  if (vimeusList) vimeusList.innerHTML = '';

  // Reset media previews
  const imgPrev = document.getElementById('m-img-preview');
  const backdropPrev = document.getElementById('m-backdrop-preview');
  if (imgPrev) imgPrev.src = 'https://via.placeholder.com/300x450/111/555?text=Sin+P%C3%B3ster';
  if (backdropPrev) backdropPrev.src = 'https://via.placeholder.com/600x338/111/555?text=Sin+Banner';

  // Detener y resetear mini reproductor
  window.stopMiniPlayer();
};

window.closeUploadDrawer = () => {
  const drawer = document.getElementById('admin-form-drawer');
  const overlay = document.getElementById('admin-drawer-overlay');
  if (drawer) drawer.classList.remove('open');
  if (overlay) overlay.style.display = 'none';

  // Detener mini reproductor al cerrar
  window.stopMiniPlayer();
};






// --- Monetization Engine v3.0 (Campaigns & Calendar) 🎬📅 ---
window.adCampaigns = [];
let editingCampaignId = null;

window.loadAdConfig = async () => {
    try {
        console.log("🎬 Cargando configuración de monetización...");
        const docRef = doc(db, "configs", "monetization");
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            const data = docSnap.data();
            if (data) {
                window.adCampaigns = data.campaigns || [];
                console.log(`📋 ${window.adCampaigns.length} campañas cargadas.`);
                
                // Forzamos inyección si hay campañas, ignorando flags antiguos si es necesario
                console.log("🚀 Disparando inyección de campañas...");
                window.injectCampaignScripts();

                const debugToggle = document.getElementById('ad-debug-force');
                if (debugToggle) {
                    const forceAds = localStorage.getItem('selva_force_ads_debug') === 'true';
                    debugToggle.checked = forceAds;
                }

                // OJO: acá NO se llama a renderAdCampaignList. Esta función corre para
                // todo visitante (hay que inyectar los anuncios), y dibujar la lista es
                // cosa exclusiva del panel: lo hace switchAdminTab('ads').
            }
        }
    } catch (e) {
        console.error("❌ Error CRÍTICO cargando config de publicidad:", e);
    }
};

// ✅ SOLO ADMIN. Hasta el 2026-08-15 era una trampa: loadAdConfig() la llamaba en el
// arranque, así que corría para todo visitante (sin hacer nada, porque sale enseguida
// si no existe el contenedor). Se desacopló: ahora solo la llama switchAdminTab('ads').
// Se puede mover a un módulo solo-admin.
window.renderAdCampaignList = () => {
    const list = document.getElementById('ad-campaign-list');
    if (!list) return;

    const campaigns = window.adCampaigns || [];

    if (campaigns.length === 0) {
        list.innerHTML = '<p style="font-size: 0.7rem; color: #444; text-align: center; padding: 20px;">No hay campañas. Crea una para empezar. 🌴</p>';
        return;
    }

    list.innerHTML = campaigns.map(c => `
        <div class="ad-campaign-item ${editingCampaignId === c.id ? 'active' : ''}" style="padding: 12px; border-radius: 12px; background: ${editingCampaignId === c.id ? 'rgba(255,122,0,0.1)' : 'rgba(255,255,255,0.03)'}; border: 1px solid ${editingCampaignId === c.id ? 'var(--primary)' : 'rgba(255,255,255,0.08)'}; cursor: pointer; transition: 0.3s; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            
            <div onclick="window.editAdCampaign('${c.id}')" style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;">
                <div style="width: 36px; height: 36px; border-radius: 10px; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; font-size: 1.1rem; flex-shrink: 0;">
                    ${(c.placements || [c.placement]).includes('video_preroll') ? '🎬' : ((c.placements || [c.placement]).includes('in_player') ? '🕹️' : '🃏')}
                </div>
                <div style="overflow: hidden; flex: 1;">
                    <p style="color: white; font-size: 0.75rem; font-weight: 800; margin: 0; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; display:flex; align-items:center; gap:6px;">
                        ${c.name || 'Sin Nombre'}
                        ${c.source === 'code'
                            ? '<span style="background:rgba(155,89,182,0.15); color:#9b59b6; border:1px solid rgba(155,89,182,0.35); font-size:0.5rem; font-weight:900; padding:1px 6px; border-radius:4px; white-space:nowrap;">🖥️ CÓDIGO</span>'
                            : '<span style="background:rgba(255,122,0,0.12); color:var(--primary); border:1px solid rgba(255,122,0,0.3); font-size:0.5rem; font-weight:900; padding:1px 6px; border-radius:4px; white-space:nowrap;">✋ MANUAL</span>'}
                    </p>
                    <p style="color: ${c.active ? '#2ecc71' : '#666'}; font-size: 0.55rem; margin: 0; font-weight: bold; text-transform: uppercase; display: flex; align-items: center; gap: 4px;">
                        <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: ${c.active ? '#2ecc71' : '#666'};"></span>
                        ${c.active ? 'ACTIVA' : 'INACTIVA'} • ${Array.isArray(c.placements) ? c.placements.join(', ') : (c.placement || 'global')}
                    </p>
                </div>
            </div>
            
            <!-- Toggle Rápido Robusto -->
            <div onclick="window.toggleAdCampaignQuick('${c.id}')" style="flex-shrink: 0; padding: 4px;">
                <div style="width: 36px; height: 18px; background: ${c.active ? 'var(--primary)' : '#444'}; border-radius: 4px; position: relative; cursor: pointer; transition: 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); border: 1px solid rgba(255,255,255,0.05);">
                    <div style="width: 14px; height: 14px; background: white; border-radius: 50%; position: absolute; top: 1px; ${c.active ? 'right: 2px' : 'left: 2px'}; transition: 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); box-shadow: 0 2px 5px rgba(0,0,0,0.3);"></div>
                </div>
            </div>
        </div>
    `).join('');
};

window.toggleAdCampaignQuick = async (id) => {
    const camp = window.adCampaigns.find(c => c.id === id);
    if (!camp) return;
    camp.active = !camp.active;
    window.renderAdCampaignList();
    if (editingCampaignId === id) {
        const activeCheck = document.getElementById('ad-edit-active');
        if (activeCheck) activeCheck.checked = camp.active;
        const toggleLabel = document.getElementById('campaign-status-toggle');
        if (toggleLabel) {
            toggleLabel.innerText = camp.active ? 'CAMPAÑA ON' : 'CAMPAÑA OFF';
            toggleLabel.style.color = camp.active ? '#2ecc71' : '#555';
        }
    }
    // No guardamos a Firestore en cada click para evitar cuota, el usuario debe dar a GUARDAR TODO
};

// Catálogo de scripts de red conocidos (Monetag y lo que se sume después).
// Para agregar una red nueva alcanza con sumar un objeto acá — el mismo
// botón "Importar Scripts de Red" los crea a todos de una, sin duplicar
// los que ya estén importados.
window.KNOWN_NETWORK_SCRIPTS = [
  {
    id: 'monetag-vignette-11548083',
    name: 'Monetag · Viñeta / Interstitial (11548083)',
    media: `<script>(function(s){s.dataset.zone='11548083',s.src='https://n6wxm.com/vignette.min.js'})([document.documentElement, document.body].filter(Boolean).pop().appendChild(document.createElement('script')))</script>`
  }
  // 🚫 SACADO 2026-08-17: 'monetag-tag-11549958' (Push Notifications, tag.min.js).
  // Ese formato de anuncio pide permiso de notificaciones del navegador y,
  // una vez concedido, Monetag le puede seguir mandando avisos a esa cuenta
  // para siempre, mostrando el ícono de SelvaFlix aunque el anuncio sea de
  // ellos — y nada de esto es reversible por código, ni apagando la campaña.
  // Se saca del catálogo para que nadie la vuelva a sembrar sin querer con
  // "Importar Scripts de Red". La causa real de fondo era otra (ver sw.js).
];

// Crea las campañas de la lista de arriba como campañas normales (tipo
// Script, global_script) si todavía no existen — así quedan con el mismo
// interruptor ON/OFF que cualquier otra campaña, en vez de hardcodeadas
// en el <head>. Se marcan con source:'code' para distinguirlas en la lista
// de las que el admin arma a mano. Las que ya existen NO se duplican, pero
// sí se les actualiza el nombre si cambió en el catálogo (sin tocar active
// ni nada que el admin haya ajustado a mano) — así, si se corrige un
// nombre en el código, correr el mismo botón de nuevo alcanza para verlo
// reflejado sin perder el ON/OFF que ya tenía cada una.
window.seedNetworkScripts = async () => {
  if (!window.adCampaigns) window.adCampaigns = [];

  let added = 0;
  let renamed = 0;
  window.KNOWN_NETWORK_SCRIPTS.forEach(s => {
    const existing = window.adCampaigns.find(c => c.id === s.id);
    if (existing) {
      if (existing.name !== s.name) { existing.name = s.name; renamed++; }
      return;
    }
    window.adCampaigns.push({
      id: s.id,
      name: s.name,
      source: 'code',
      active: true,
      contentType: 'script',
      linkType: 'manual',
      link: '',
      placements: ['global_script'],
      coexistence: 'respect_global',
      layout: 'glass',
      canSkip: false,
      days: [0, 1, 2, 3, 4, 5, 6],
      startHour: 0,
      endHour: 23,
      message: '',
      media: s.media,
      timer: 5,
      priority: 2,
      freqMode: 'interval',
      freqTimes: 1,
      freqValue: 60
    });
    added++;
  });

  window.renderAdCampaignList();

  if (added === 0 && renamed === 0) {
    if (window.showToast) window.showToast('Los scripts de red ya estaban al día.', 'info');
    return;
  }

  await window.saveAdsCampaigns();
  const partes = [];
  if (added > 0) partes.push(`${added} nueva(s)`);
  if (renamed > 0) partes.push(`${renamed} renombrada(s)`);
  if (window.showToast) window.showToast(`⭐ ${partes.join(', ')}. Ya podés prenderlas/apagarlas desde acá.`, 'success');
};

window.createNewAdCampaign = () => {
    const campaigns = window.adCampaigns || [];
    const newCamp = {
        id: 'camp_' + Date.now().toString(36),
        name: 'Nueva Campaña ' + (campaigns.length + 1),
        active: true,
        contentType: 'media',
        linkType: 'manual', 
        link: '',
        placements: ['card_overlay'],
        coexistence: 'respect_global',
        layout: 'glass',
        canSkip: false,
        days: [0,1,2,3,4,5,6], 
        startHour: 0,
        endHour: 23,
        message: "¡Apóyanos viendo este pequeño anuncio para mantener la selva viva y gratuita para todos! 🌴🐒",
        media: "",
        timer: 5,
        priority: 2, 
        freqMode: 'interval',
        freqTimes: 1, 
        freqValue: 60, 
        link: ""
    };
    
    if (!window.adCampaigns) window.adCampaigns = [];
    window.adCampaigns.push(newCamp);
    window.renderAdCampaignList();
    window.editAdCampaign(newCamp.id);
};

window.editAdCampaign = (id) => {
    try {
        editingCampaignId = id;
        const camp = (window.adCampaigns || []).find(c => c.id === id);
        if (!camp) return;

        console.log(`✏️ Editando campaña: ${camp.name}`);
        window.renderAdCampaignList();
        
        const emptyHint = document.getElementById('ad-campaign-empty');
        if (emptyHint) emptyHint.style.display = 'none';
        
        const editor = document.getElementById('ad-campaign-editor');
        if (editor) editor.style.display = 'block';

        // Llenar campos con seguridad
        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) {
                if (el.type === 'checkbox') el.checked = val;
                else el.value = val;
            }
        };

        const setTxt = (id, txt) => {
            const el = document.getElementById(id);
            if (el) el.innerText = txt;
        };

        setTxt('ad-edit-id', camp.id);
        setVal('ad-edit-name', camp.name || '');
        setVal('ad-edit-active', camp.active);
        setVal('ad-edit-start', camp.startHour || 0);
        setVal('ad-edit-end', camp.endHour || 23);
        
        // Multi-Ubicación (Placements)
        const currentPlacements = camp.placements || [camp.placement];
        const placementBtns = document.querySelectorAll('.placement-btn');
        placementBtns.forEach(btn => {
            const p = btn.dataset.placement;
            if (currentPlacements.includes(p)) btn.classList.add('active');
            else btn.classList.remove('active');
            
            btn.onclick = () => {
                btn.classList.toggle('active');
                window.updateAdPlacementFields();
                if (window.refreshAdHelpMessage) window.refreshAdHelpMessage();
            };
        });

        setVal('ad-edit-coexistence', camp.coexistence || 'respect_global');
        setVal('ad-edit-message', camp.message || '');
        setVal('ad-edit-media', camp.media || '');
        setVal('ad-edit-timer', camp.timer || 5);
        setVal('ad-edit-priority', camp.priority || 2);
        setVal('ad-edit-layout', camp.layout || 'glass');
        setVal('ad-edit-can-skip', camp.canSkip || false);
        setVal('ad-edit-freq-mode', camp.freqMode || 'interval');
        setVal('ad-edit-freq-times', camp.freqTimes || 1);
        setVal('ad-edit-freq', camp.freqValue || 60);
        setVal('ad-edit-link', camp.link || "");

        // Días
        const dayBtns = document.querySelectorAll('.day-btn');
        dayBtns.forEach(btn => {
            const day = parseInt(btn.dataset.day);
            if (camp.days && camp.days.includes(day)) btn.classList.add('active');
            else btn.classList.remove('active');
            
            btn.onclick = () => {
                btn.classList.toggle('active');
            };
        });

        // Toggle label
        const toggleLabel = document.getElementById('campaign-status-toggle');
        if (toggleLabel) {
            toggleLabel.innerText = camp.active ? 'CAMPAÑA ON' : 'CAMPAÑA OFF';
            toggleLabel.style.color = camp.active ? '#2ecc71' : '#555';
        }
        
        const activeCheck = document.getElementById('ad-edit-active');
        if (activeCheck) {
            activeCheck.onchange = (e) => {
                if (toggleLabel) {
                    toggleLabel.innerText = e.target.checked ? 'CAMPAÑA ON' : 'CAMPAÑA OFF';
                    toggleLabel.style.color = e.target.checked ? '#2ecc71' : '#555';
                }
            };
        }

        const forceCheck = document.getElementById('ad-edit-force-campaign');
        if (forceCheck) forceCheck.checked = camp.force || false;

        const startDateInput = document.getElementById('ad-edit-start-date');
        const endDateInput = document.getElementById('ad-edit-end-date');
        if (startDateInput) startDateInput.value = camp.startDate || '';
        if (endDateInput) endDateInput.value = camp.endDate || '';

        window.updateAdPlacementFields();
        window.updateFreqFields();

        // 🔗 Smart Link Init
        const linkType = camp.linkType || 'manual';
        window.setAdLinkType(linkType);
        
        // 🚀 Content Type & Placement Mode Init
        const contType = camp.contentType || 'media';
        window.setAdContentType(contType);
        
        const placMode = camp.placementMode || 'manual';
        window.setPlacementMode(placMode);
        window.setAdLinkType(linkType, false);

        // 🎨 Content Type Init
        const contentType = camp.contentType || (camp.media && camp.media.includes('<script') ? 'script' : 'media');
        window.setAdContentType(contentType);
    } catch (err) {
        console.error("❌ Error editando campaña:", err);
    }
};

window.setAdLinkType = (type, resetInput = true) => {
    const freeBtn = document.getElementById('link-type-network');
    const manualBtn = document.getElementById('link-type-manual');
    const autoBtn = document.getElementById('link-type-auto');
    const linkContainer = document.getElementById('ad-edit-link-container');
    const linkInput = document.getElementById('ad-edit-link');

    // Estilos base (Inactivos)
    const inactiveStyle = { background: 'rgba(255,255,255,0.05)', borderColor: 'rgba(255,255,255,0.1)', color: '#777' };
    const activeStyle = { background: 'rgba(255,122,0,0.1)', borderColor: 'var(--primary)', color: 'var(--primary)' };

    [freeBtn, manualBtn, autoBtn].forEach(btn => {
        if (btn) Object.assign(btn.style, inactiveStyle);
    });

    if (type === 'network') {
        if (freeBtn) Object.assign(freeBtn.style, activeStyle);
        if (linkContainer) linkContainer.style.display = 'none';
        if (resetInput && linkInput) linkInput.value = '';
    } else if (type === 'auto') {
        if (autoBtn) Object.assign(autoBtn.style, activeStyle);
        if (linkContainer) linkContainer.style.display = 'none';
        if (resetInput && linkInput) linkInput.value = '';
    } else {
        // Manual por defecto
        if (manualBtn) Object.assign(manualBtn.style, activeStyle);
        if (linkContainer) linkContainer.style.display = 'block';
    }
    
    // Guardar temporalmente el tipo en un atributo data para el save
    const editor = document.getElementById('ad-campaign-editor');
    if (editor) {
        editor.dataset.currentLinkType = type;
        window.updateAdPlacementFields(); // Refrescar visibilidad de campos
    }
};

window.setAdContentType = (type) => {
    const scriptBtn = document.getElementById('ad-content-type-script');
    const mediaBtn = document.getElementById('ad-content-type-media');
    const mediaLabel = document.getElementById('ad-media-label');
    const mediaHint = document.getElementById('ad-media-hint');
    
    // Estilos botones
    if (type === 'script') {
        if (scriptBtn) {
            scriptBtn.style.background = 'rgba(0,242,255,0.1)';
            scriptBtn.style.color = '#00f2ff';
            scriptBtn.style.border = '1px solid rgba(0,242,255,0.2)';
        }
        if (mediaBtn) {
            mediaBtn.style.background = 'transparent';
            mediaBtn.style.color = '#555';
            mediaBtn.style.border = 'none';
        }

        if (mediaLabel) mediaLabel.innerText = "⚡ Código del Script (Red)";
        if (mediaHint) mediaHint.innerHTML = "* Pega el script de Adsterra, AdMob, etc.";
    } else {
        if (mediaBtn) {
            mediaBtn.style.background = 'rgba(255,122,0,0.1)';
            mediaBtn.style.color = 'var(--primary)';
            mediaBtn.style.border = '1px solid rgba(255,122,0,0.2)';
        }
        if (scriptBtn) {
            scriptBtn.style.background = 'transparent';
            scriptBtn.style.color = '#555';
            scriptBtn.style.border = 'none';
        }

        if (mediaLabel) mediaLabel.innerText = "🖼️ URL del Medio (Imagen/Video)";
        if (mediaHint) mediaHint.innerHTML = "* URL directa de un archivo .jpg, .png o .mp4";
    }
    
    // Guardar en data el tipo actual
    const editor = document.getElementById('ad-campaign-editor');
    if (editor) {
        editor.dataset.currentContentType = type;
        
        // Mostrar/Ocultar Selector de Ubicación si es Script
        const locSelector = document.getElementById('placement-mode-selector');
        if (locSelector) {
            locSelector.style.display = (type === 'script') ? 'block' : 'none';
        }

        // 💡 RECOMENDACIÓN AUTO: Si es Script, poner todo en automático para "Modo Pro"
        if (type === 'script') {
            window.setAdLinkType('network'); // Red Libre
            window.setPlacementMode('auto');  // Red Elige
            const freqSelect = document.getElementById('ad-edit-freq-mode');
            if (freqSelect) {
                freqSelect.value = 'unlimited'; 
                window.updateFreqFields();
            }
        }
        
    }
};

window.refreshAdHelpMessage = () => {
    const editor = document.getElementById('ad-campaign-editor');
    if (!editor) return;
    
    const type = editor.dataset.currentContentType || 'media';
    const mode = editor.dataset.currentPlacementMode || 'manual';
    const helpEl = document.getElementById('ad-edit-help-tip') || document.createElement('p');
    
    if (!helpEl.id) {
        helpEl.id = 'ad-edit-help-tip';
        helpEl.className = 'form-text text-muted';
        helpEl.style.fontSize = '0.6rem';
        helpEl.style.marginTop = '10px';
        helpEl.style.color = 'var(--primary)';
        helpEl.style.fontWeight = 'bold';
        const container = document.getElementById('placement-direction-container');
        if (container) container.appendChild(helpEl);
    }

    const descriptions = {
        'top_banner': 'Banner clásico en la parte superior.',
        'sidebar_banner': 'Widget lateral (útil en PC).',
        'footer_banner': 'Banner pequeño en el pie de página.',
        'landing_popup': '💎 POPUP DE BIENVENIDA: Aparece al cargar la web (¡Ideal estrenos!).',
        'card_overlay': 'Flotante que sale al tocar una película.',
        'video_preroll': 'Anuncio a pantalla completa antes del video.',
        'in_player': 'Superposición dentro del reproductor.',
        'global_script': 'Código invisible que trabaja en toda la app.'
    };

    if (type === 'script' && mode === 'auto') {
        helpEl.innerHTML = "✨ MODO PILOTO AUTOMÁTICO: La red decidirá ubicación y frecuencia.";
        helpEl.style.display = 'block';
    } else if (type === 'media' && mode === 'auto') {
        helpEl.innerHTML = "📱 MODO SOCIAL BAR: Tu imagen flotará elegantemente abajo.";
        helpEl.style.display = 'block';
    } else if (mode === 'manual') {
        // Encontrar descripciones de slots seleccionados
        const activeBtns = document.querySelectorAll('.placement-btn.active');
        let desc = "📍 MODO MANUAL: ";
        if (activeBtns.length > 0) {
            const first = activeBtns[0].dataset.placement;
            desc += descriptions[first] || "Tú eliges los slots.";
        } else {
            desc += "Tú eliges los slots abajo.";
        }
        helpEl.innerHTML = desc;
        helpEl.style.display = 'block';
    } else {
        helpEl.style.display = 'none';
    }
};

window.applyMagicAutoConfig = () => {
    // Forzar todo a modo automático profesional
    window.setAdContentType('script');
    window.setAdLinkType('network');
    window.setPlacementMode('auto');
    const freqSelect = document.getElementById('ad-edit-freq-mode');
    if (freqSelect) {
        freqSelect.value = 'unlimited';
        window.updateFreqFields();
    }
    
    if (window.showToast) {
        window.showToast("✨ MODO MÁGICO ACTIVADO: Todo en automático.", "success");
    }
};

window.setPlacementMode = (mode) => {
    const manualBtn = document.getElementById('placement-mode-manual');
    const autoBtn = document.getElementById('placement-mode-auto');
    
    if (mode === 'auto') {
        if (autoBtn) {
            autoBtn.style.background = 'rgba(0,242,255,0.1)';
            autoBtn.style.color = '#00f2ff';
            autoBtn.style.border = '1px solid rgba(0,242,255,0.2)';
        }
        if (manualBtn) {
            manualBtn.style.background = 'transparent';
            manualBtn.style.color = '#555';
            manualBtn.style.border = 'none';
        }
    } else {
        if (manualBtn) {
            manualBtn.style.background = 'rgba(255,122,0,0.1)';
            manualBtn.style.color = 'var(--primary)';
            manualBtn.style.border = '1px solid rgba(255,122,0,0.2)';
        }
        if (autoBtn) {
            autoBtn.style.background = 'transparent';
            autoBtn.style.color = '#555';
            autoBtn.style.border = 'none';
        }
    }
    
    const editor = document.getElementById('ad-campaign-editor');
    if (editor) {
        editor.dataset.currentPlacementMode = mode;
        const type = editor.dataset.currentContentType || 'media';
        
        // Alerta si es Media + Auto
        if (type === 'media' && mode === 'auto') {
            if (window.showToast) window.showToast("⚠️ 'Red Elige' activado. Tu imagen flotará como Social Bar.", "info");
        }

        window.refreshAdHelpMessage();

        // Refrescar el bloqueo de slots
        const placementGrid = document.getElementById('ad-edit-placements');
        if (placementGrid) {
            const isAuto = (type === 'script' && mode === 'auto');
            placementGrid.style.opacity = isAuto ? '0.2' : '1';
            placementGrid.style.pointerEvents = isAuto ? 'none' : 'auto';
        }
    }
};

window.updateFreqFields = () => {
    const modeEl = document.getElementById('ad-edit-freq-mode');
    if (!modeEl) return;
    const mode = modeEl.value;
    const group = document.getElementById('freq-value-group');
    const timesOnly = document.getElementById('freq-times-only-group'); // Nuevo contenedor para cuando solo queremos veces
    const freqLabel = document.getElementById('freq-value-label');
    const freqInput = document.getElementById('ad-edit-freq');

    if (group) {
        group.style.display = mode === 'interval' ? 'grid' : 'none';
    }

    if (mode === 'unlimited') {
        if (group) group.style.display = 'none';
        if (timesOnly) timesOnly.style.display = 'none';
    } else if (mode === 'per_movie_daily') {
        if (group) group.style.display = 'grid';
        if (freqLabel?.parentElement) freqLabel.parentElement.style.opacity = '0.3';
        if (freqInput) freqInput.disabled = true;
    } else if (mode === 'interval') {
        if (freqLabel?.parentElement) freqLabel.parentElement.style.opacity = '1';
        if (freqInput) freqInput.disabled = false;
    }
};

window.updateAdPlacementFields = () => {
    // Detectar si alguno de los placements activos requiere layout/mensaje
    const activeBtns = Array.from(document.querySelectorAll('.placement-btn.active'));
    const p = activeBtns.map(b => b.dataset.placement);
    
    // UI Helpers
    const label = document.getElementById('ad-media-label');
    const hint = document.getElementById('ad-media-hint');
    const layoutGroup = document.getElementById('ad-layout-group');
    const cardFields = document.getElementById('placement-card-fields');
    
    const needsCard = p.includes('card_overlay') || p.includes('app_banner') || p.includes('in_player');
    const isGlobal = p.length === 1 && p[0] === 'global_script';
    const isPreroll = p.length === 1 && p[0] === 'video_preroll';

    // Tipo de Contenido Actual
    const contentType = document.getElementById('ad-campaign-editor')?.dataset.currentContentType || 'media';
    const linkContainer = document.getElementById('ad-edit-link-container');

    if (contentType === 'script') {
        if (label) label.innerText = "⚡ Código del Script (Red Externa)";
        if (hint) hint.innerHTML = "* Pega el código de Adsterra, AdMob, etc.";
        if (layoutGroup) layoutGroup.style.display = 'none';
        if (cardFields) cardFields.style.display = 'none';
        // En modo Script, usualmente no quieres link manual a menos que lo fuerces
        if (linkContainer?.parentElement) linkContainer.parentElement.style.opacity = '1';
    } else {
        if (label) label.innerText = isPreroll ? "🎬 URL del Video / VAST Tag" : "🖼️ URL del Medio (Imagen/Video)";
        if (hint) hint.innerHTML = isPreroll ? "* URL directa a .mp4 o link de VAST." : "* URL de la imagen/video que verá el usuario.";
        if (layoutGroup) layoutGroup.style.display = needsCard ? 'block' : 'none';
        if (cardFields) cardFields.style.display = needsCard ? 'block' : 'none';
        if (linkContainer?.parentElement) linkContainer.parentElement.style.opacity = '1';
    }

    if (window.refreshAdHelpMessage) window.refreshAdHelpMessage();
};

window.deleteCurrentCampaign = async () => {
    if (!editingCampaignId) return;
    if (!confirm('¿Seguro que quieres borrar esta campaña de la selva? 🌴🗑️')) return;

    window.adCampaigns = (window.adCampaigns || []).filter(c => c.id !== editingCampaignId);
    editingCampaignId = null;
    
    // Sincronizar con Firebase inmediatamente
    await window.saveAdsCampaigns();
    
    document.getElementById('ad-campaign-editor').style.display = 'none';
    document.getElementById('ad-campaign-empty').style.display = 'flex';
    window.renderAdCampaignList();
};

window.saveAdsCampaigns = async () => {
    const btn = document.querySelector('#btn-save-ads');
    if (btn) btn.innerText = "💾 GUARDANDO...";

    // Primero sincronizar la campaña actual al array
    if (editingCampaignId) {
        const camp = adCampaigns.find(c => c.id === editingCampaignId);
        if (camp) {
            camp.name = document.getElementById('ad-edit-name').value;
            camp.active = document.getElementById('ad-edit-active').checked;
            camp.force = document.getElementById('ad-edit-force-campaign')?.checked || false;
            camp.startHour = parseInt(document.getElementById('ad-edit-start').value);
            camp.endHour = parseInt(document.getElementById('ad-edit-end').value);
            camp.startDate = document.getElementById('ad-edit-start-date')?.value || '';
            camp.endDate = document.getElementById('ad-edit-end-date')?.value || '';

            // Placements (Array)
            const selectedPlacements = [];
            document.querySelectorAll('.placement-btn.active').forEach(b => selectedPlacements.push(b.dataset.placement));
            camp.placements = selectedPlacements;
            camp.coexistence = document.getElementById('ad-edit-coexistence')?.value || camp.coexistence || 'respect_global';

            camp.message = document.getElementById('ad-edit-message').value;
            camp.media = document.getElementById('ad-edit-media').value;
            camp.timer = parseInt(document.getElementById('ad-edit-timer')?.value) || camp.timer || 5;
            camp.priority = parseInt(document.getElementById('ad-edit-priority')?.value) || camp.priority || 2;
            camp.layout = document.getElementById('ad-edit-layout')?.value || camp.layout || 'glass';
            camp.canSkip = document.getElementById('ad-edit-can-skip')?.checked || false;
            camp.freqMode = document.getElementById('ad-edit-freq-mode')?.value || camp.freqMode || 'interval';
            camp.freqTimes = parseInt(document.getElementById('ad-edit-freq-times')?.value) || camp.freqTimes || 1;
            camp.freqValue = parseInt(document.getElementById('ad-edit-freq')?.value) || camp.freqValue || 60;
            camp.link = document.getElementById('ad-edit-link').value;
            camp.linkType = document.getElementById('ad-campaign-editor').dataset.currentLinkType || 'manual';
            camp.contentType = document.getElementById('ad-campaign-editor').dataset.currentContentType || 'media';
            camp.placementMode = document.getElementById('ad-campaign-editor').dataset.currentPlacementMode || 'manual';
            
            // Días
            const activeDays = [];
            document.querySelectorAll('.day-btn.active').forEach(b => activeDays.push(parseInt(b.dataset.day)));
            camp.days = activeDays;
        }
    }

    const config = {
        globalActive: true, // Siempre activo por defecto
        globalCoexistenceMode: document.getElementById('ad-global-coexistence-mode')?.value || 'mixed',
        campaigns: window.adCampaigns || []
    };

    console.log("🌴 Intentando guardar configuración de anuncios:", config);

    try {
        await setDoc(doc(db, "configs", "monetization"), config);
        if(window.showToast) window.showToast("✅ Campañas actualizadas en la selva.", "success");
        window.renderAdCampaignList();
    } catch (e) {
        console.error("Error guardando campañas:", e);
        if(window.showToast) window.showToast("❌ Error al guardar las campañas.", "error");
    } finally {
        if (btn) btn.innerHTML = '<span style="font-size: 0.9rem;">💾</span><span>GUARDAR CAMPAÑA</span>';
    }
};

// --- Planes Premium (Paquetes) 💎 ---
// Guardados en el mismo documento que la config de monetización, pero bajo
// su propia key ("plans") para no pisar las campañas de anuncios.
window.plansConfig = [];
window.plansGlobalWhatsapp = '';
let editingPlanId = null;

const _escPlanHtml = (str) => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// El botón flotante de Premium hace fácil abrir "Hazte Premium" en el primer
// segundo de carga, antes de que el getDoc() de abajo termine — sin esto,
// window.plansConfig todavía era undefined y el modal mostraba "Todavía no
// hay planes disponibles" aunque sí los haya, solo que no habían llegado
// todavía. openPremiumModal() espera esta promesa antes de dibujar la grilla.
let _resolvePlansReady;
window._plansReadyPromise = new Promise((resolve) => { _resolvePlansReady = resolve; });

window.loadPlansConfig = async () => {
    try {
        const docRef = doc(db, "configs", "plans");
        const docSnap = await getDoc(docRef);
        const data = docSnap.exists() ? docSnap.data() : {};
        window.plansConfig = data.plans || [];
        window.plansGlobalWhatsapp = data.whatsapp || '';
        const globalWhatsappInput = document.getElementById('plans-global-whatsapp');
        if (globalWhatsappInput) globalWhatsappInput.value = window.plansGlobalWhatsapp;
        window.ensureFreePlanExists();
        // OJO: acá NO se llama a renderPlansList. Esta función corre para todo
        // visitante (la ventanita de Premium necesita los planes), y dibujar la
        // lista es cosa exclusiva del panel: lo hace switchAdminTab('plans').
        if (typeof window.maybeShowPremiumPromo === 'function') window.maybeShowPremiumPromo();
    } catch (e) {
        console.error("❌ Error cargando planes premium:", e);
    } finally {
        _resolvePlansReady();
    }
};

// Un solo WhatsApp opcional que aplica a todos los planes que no tengan el
// suyo propio cargado — se guarda aparte para no depender de tener un plan
// seleccionado en el editor.
window.saveGlobalWhatsapp = async () => {
    const raw = (document.getElementById('plans-global-whatsapp')?.value || '').trim().replace(/[^\d]/g, '');
    try {
        window.plansGlobalWhatsapp = raw;
        // Solo el campo whatsapp: escribir también los planes acá guardaría sin
        // querer un plan recién creado que todavía se está editando.
        await setDoc(doc(db, "configs", "plans"), { whatsapp: raw }, { merge: true });
        if (window.showToast) window.showToast("✅ WhatsApp general actualizado.", "success");
    } catch (e) {
        console.error("Error guardando WhatsApp general:", e);
        if (window.showToast) window.showToast("❌ Error al guardar el WhatsApp general.", "error");
    }
};

// --- Pruebas gratis de Premium (auto-servicio) 🎁 ---
// Pueden convivir VARIAS ofertas a la vez (ej. "3 horas" y "24 horas"), cada
// una con su propia duración y cadencia — por eso es una lista (trialOffers),
// no un config único como al principio. El usuario se activa el pase él
// mismo desde la ventanita de planes. Se guarda aparte (configs/freeTrial)
// porque no es un plan sino una promo transversal.
//
// Cada oferta: { id, name, durationHours, cadenceHours, active }. Duración y
// cadencia se guardan siempre en horas (aunque el admin las cargue en días)
// para no tener que arrastrar la unidad por todos lados en los cálculos.
window.trialOffers = [];
let editingTrialOfferId = null;

const _escTrialHtml = (str) => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Convierte {amount, unit} <-> horas, para no repetir la cuenta en cada lado.
const _trialHoras = (amount, unit) => (unit === 'days' ? amount * 24 : amount);
const _trialFormatoDuracion = (hours) => {
    if (hours % 24 === 0) { const d = hours / 24; return `${d} día${d !== 1 ? 's' : ''}`; }
    return `${hours} hora${hours !== 1 ? 's' : ''}`;
};

// Mismo motivo que _plansReadyPromise: el modal puede abrirse antes de que
// esto termine de cargar.
let _resolveTrialOffersReady;
window._trialOffersReadyPromise = new Promise((resolve) => { _resolveTrialOffersReady = resolve; });

window.loadTrialOffers = async () => {
    try {
        const docSnap = await getDoc(doc(db, "configs", "freeTrial"));
        const data = docSnap.exists() ? docSnap.data() : {};
        window.trialOffers = Array.isArray(data.offers) ? data.offers : [];
        window.renderTrialOffersList();
    } catch (e) {
        console.error("❌ Error cargando pruebas gratis:", e);
    } finally {
        _resolveTrialOffersReady();
    }
};

window.saveTrialOffers = async () => {
    try {
        await setDoc(doc(db, "configs", "freeTrial"), { offers: window.trialOffers || [] });
        if (window.showToast) window.showToast("✅ Pruebas gratis actualizadas.", "success");
    } catch (e) {
        console.error("Error guardando pruebas gratis:", e);
        if (window.showToast) window.showToast("❌ Error al guardar las pruebas gratis.", "error");
    }
};

// Ícono sugerido según duración — solo el default al crear una oferta nueva
// o si es una oferta vieja sin ícono elegido a mano (offer.icon). El admin
// puede pisarlo en el selector del modal.
const _trialIcon = (hours) => {
    if (hours <= 6) return '🍋';
    if (hours <= 24) return '🍊';
    if (hours <= 72) return '🍉';
    return '🍯';
};

const _TRIAL_ICON_OPTIONS = ['🍋', '🍊', '🍉', '🍇', '🍓', '🍯', '🫙', '🎁'];
let _selectedTrialModalIcon = '🍋';

const _renderTrialIconPicker = (selected) => {
    const wrap = document.getElementById('trial-modal-icon-picker');
    if (!wrap) return;
    wrap.innerHTML = _TRIAL_ICON_OPTIONS.map(ic => `
        <button type="button" onclick="window.selectTrialModalIcon('${ic}')" data-icon="${ic}" style="width: 34px; height: 34px; border-radius: 8px; font-size: 1.1rem; display: flex; align-items: center; justify-content: center; cursor: pointer; background: ${ic === selected ? 'rgba(255,122,0,0.2)' : 'rgba(255,255,255,0.04)'}; border: 1px solid ${ic === selected ? 'var(--primary)' : 'rgba(255,255,255,0.08)'};">${ic}</button>
    `).join('');
};

window.selectTrialModalIcon = (icon) => {
    _selectedTrialModalIcon = icon;
    document.querySelectorAll('#trial-modal-icon-picker button').forEach(b => {
        const isSel = b.dataset.icon === icon;
        b.style.background = isSel ? 'rgba(255,122,0,0.2)' : 'rgba(255,255,255,0.04)';
        b.style.border = '1px solid ' + (isSel ? 'var(--primary)' : 'rgba(255,255,255,0.08)');
    });
};

window.createNewTrialOffer = () => {
    window.openTrialOfferModal(null);
};

window.deleteTrialOffer = (id) => {
    window.trialOffers = (window.trialOffers || []).filter(o => o.id !== id);
    window.saveTrialOffers();
    window.renderTrialOffersList();
};

// Deshace horas -> {amount, unit} eligiendo días si entra justo, para que
// el admin vea "3 días" en vez de "72 horas" si así lo cargó.
const _trialDeshacerHoras = (hours) => (hours % 24 === 0 && hours >= 24)
    ? { amount: hours / 24, unit: 'days' }
    : { amount: hours, unit: 'hours' };

// id === null significa alta nueva; si no, precarga esa oferta para editarla.
window.openTrialOfferModal = (id) => {
    editingTrialOfferId = id;
    const offer = id ? (window.trialOffers || []).find(o => o.id === id) : null;

    const dur = _trialDeshacerHoras(offer?.durationHours || 24);
    const cad = _trialDeshacerHoras(offer?.cadenceHours || 168);

    const setVal = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
    setVal('trial-modal-name', offer?.name || '');
    setVal('trial-modal-duration-amount', dur.amount);
    setVal('trial-modal-duration-unit', dur.unit);
    setVal('trial-modal-cadence-amount', cad.amount);
    setVal('trial-modal-cadence-unit', cad.unit);
    const activeCheck = document.getElementById('trial-modal-active');
    if (activeCheck) activeCheck.checked = offer ? !!offer.active : true;

    _selectedTrialModalIcon = offer?.icon || _trialIcon(offer?.durationHours || 24);
    _renderTrialIconPicker(_selectedTrialModalIcon);

    const deleteBtn = document.getElementById('btn-trial-modal-delete');
    if (deleteBtn) deleteBtn.style.display = offer ? 'flex' : 'none';

    const modal = document.getElementById('trial-offer-modal');
    if (modal) modal.style.display = 'flex';
};

window.closeTrialOfferModal = () => {
    const modal = document.getElementById('trial-offer-modal');
    if (modal) modal.style.display = 'none';
    editingTrialOfferId = null;
};

window.saveTrialOfferFromModal = () => {
    const name = (document.getElementById('trial-modal-name')?.value || '').trim() || 'Nueva prueba';
    const durAmount = Math.max(1, parseFloat(document.getElementById('trial-modal-duration-amount')?.value) || 1);
    const durUnit = document.getElementById('trial-modal-duration-unit')?.value || 'hours';
    const cadAmount = Math.max(1, parseFloat(document.getElementById('trial-modal-cadence-amount')?.value) || 1);
    const cadUnit = document.getElementById('trial-modal-cadence-unit')?.value || 'days';
    const active = document.getElementById('trial-modal-active')?.checked ?? true;

    if (!window.trialOffers) window.trialOffers = [];
    let offer = editingTrialOfferId ? window.trialOffers.find(o => o.id === editingTrialOfferId) : null;
    if (!offer) {
        offer = { id: 'trial_' + Date.now().toString(36) };
        window.trialOffers.push(offer);
    }
    offer.name = name;
    offer.durationHours = _trialHoras(durAmount, durUnit);
    offer.cadenceHours = _trialHoras(cadAmount, cadUnit);
    offer.active = active;
    offer.icon = _selectedTrialModalIcon;

    window.saveTrialOffers();
    window.renderTrialOffersList();
    window.closeTrialOfferModal();
};

window.deleteTrialOfferFromModal = () => {
    if (!editingTrialOfferId) return;
    if (!confirm('¿Borrar esta prueba gratis? 🎁🗑️')) return;
    window.deleteTrialOffer(editingTrialOfferId);
    window.closeTrialOfferModal();
};

window.renderTrialOffersList = () => {
    const list = document.getElementById('trial-offers-list');
    if (!list) return;
    const offers = window.trialOffers || [];

    if (offers.length === 0) {
        list.innerHTML = '<p style="font-size: 0.7rem; color: #444; text-align: center; padding: 20px;">No hay pruebas gratis. Creá una para empezar. 🎁</p>';
        return;
    }

    list.innerHTML = offers.map(o => `
        <div onclick="window.openTrialOfferModal('${o.id}')" style="display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); cursor: pointer; transition: 0.2s;">
            <div style="width: 38px; height: 38px; border-radius: 10px; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; font-size: 1.2rem; flex-shrink: 0; opacity: ${o.active ? '1' : '0.4'};">${o.icon || _trialIcon(o.durationHours || 24)}</div>
            <div style="flex: 1; min-width: 0;">
                <p style="color: white; font-size: 0.78rem; font-weight: 800; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${_escTrialHtml(o.name)}</p>
                <p style="color: #888; font-size: 0.65rem; margin: 2px 0 0;">Dura ${_trialFormatoDuracion(o.durationHours || 24)} · se repite cada ${_trialFormatoDuracion(o.cadenceHours || 168)}</p>
            </div>
            <span style="width: 8px; height: 8px; border-radius: 50%; background: ${o.active ? '#2ecc71' : '#666'}; flex-shrink: 0;" title="${o.active ? 'Activa' : 'Inactiva'}"></span>
        </div>
    `).join('');
};

// --- Rachas (racha diaria de días seguidos viendo algo) 🔥 ---
// A diferencia de Pruebas gratis (el usuario aprieta "Activar"), esto se
// otorga solo al llegar a un escalón — ver registerStreakProgress() más
// abajo. Acá solo vive el CRUD de qué escalones existen (configs/streaks).
window.streakMilestones = [];
let editingStreakMilestoneId = null;

// Mismo motivo que _plansReadyPromise/_trialOffersReadyPromise: el modal de
// Premium puede abrirse antes de que esto termine de cargar.
let _resolveStreakConfigReady;
window._streakConfigReadyPromise = new Promise((resolve) => { _resolveStreakConfigReady = resolve; });

window.loadStreakConfig = async () => {
    try {
        const docSnap = await getDoc(doc(db, "configs", "streaks"));
        const data = docSnap.exists() ? docSnap.data() : {};
        window.streakMilestones = Array.isArray(data.milestones) ? data.milestones : [];
        window.renderStreakMilestonesList();
    } catch (e) {
        console.error("❌ Error cargando racha:", e);
    } finally {
        _resolveStreakConfigReady();
    }
};

window.saveStreakMilestones = async () => {
    try {
        await setDoc(doc(db, "configs", "streaks"), { milestones: window.streakMilestones || [] });
        if (window.showToast) window.showToast("✅ Racha actualizada.", "success");
    } catch (e) {
        console.error("Error guardando racha:", e);
        if (window.showToast) window.showToast("❌ Error al guardar la racha.", "error");
    }
};

window.createNewStreakMilestone = () => {
    window.openStreakMilestoneModal(null);
};

window.deleteStreakMilestone = (id) => {
    window.streakMilestones = (window.streakMilestones || []).filter(m => m.id !== id);
    window.saveStreakMilestones();
    window.renderStreakMilestonesList();
};

// id === null significa alta nueva; si no, precarga ese escalón para editarlo.
window.openStreakMilestoneModal = (id) => {
    editingStreakMilestoneId = id;
    const milestone = id ? (window.streakMilestones || []).find(m => m.id === id) : null;
    const reward = _trialDeshacerHoras(milestone?.hours || 24);

    const setVal = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
    setVal('streak-modal-days', milestone?.days || 3);
    setVal('streak-modal-reward-amount', reward.amount);
    setVal('streak-modal-reward-unit', reward.unit);
    const activeCheck = document.getElementById('streak-modal-active');
    if (activeCheck) activeCheck.checked = milestone ? !!milestone.active : true;

    const deleteBtn = document.getElementById('btn-streak-modal-delete');
    if (deleteBtn) deleteBtn.style.display = milestone ? 'flex' : 'none';

    const modal = document.getElementById('streak-milestone-modal');
    if (modal) modal.style.display = 'flex';
};

window.closeStreakMilestoneModal = () => {
    const modal = document.getElementById('streak-milestone-modal');
    if (modal) modal.style.display = 'none';
    editingStreakMilestoneId = null;
};

window.saveStreakMilestoneFromModal = () => {
    const days = Math.max(1, parseInt(document.getElementById('streak-modal-days')?.value, 10) || 1);
    const rewardAmount = Math.max(1, parseFloat(document.getElementById('streak-modal-reward-amount')?.value) || 1);
    const rewardUnit = document.getElementById('streak-modal-reward-unit')?.value || 'hours';
    const active = document.getElementById('streak-modal-active')?.checked ?? true;

    if (!window.streakMilestones) window.streakMilestones = [];
    let milestone = editingStreakMilestoneId ? window.streakMilestones.find(m => m.id === editingStreakMilestoneId) : null;
    if (!milestone) {
        milestone = { id: 'streak_' + Date.now().toString(36) };
        window.streakMilestones.push(milestone);
    }
    milestone.days = days;
    milestone.hours = _trialHoras(rewardAmount, rewardUnit);
    milestone.active = active;

    window.streakMilestones.sort((a, b) => a.days - b.days);
    window.saveStreakMilestones();
    window.renderStreakMilestonesList();
    window.closeStreakMilestoneModal();
};

window.deleteStreakMilestoneFromModal = () => {
    if (!editingStreakMilestoneId) return;
    if (!confirm('¿Borrar este escalón de racha? 🔥🗑️')) return;
    window.deleteStreakMilestone(editingStreakMilestoneId);
    window.closeStreakMilestoneModal();
};

window.renderStreakMilestonesList = () => {
    const list = document.getElementById('streak-milestones-list');
    if (!list) return;
    const milestones = window.streakMilestones || [];

    if (milestones.length === 0) {
        list.innerHTML = '<p style="font-size: 0.7rem; color: #444; text-align: center; padding: 20px;">No hay escalones de racha. Creá uno para empezar. 🔥</p>';
        return;
    }

    list.innerHTML = milestones.map(m => `
        <div onclick="window.openStreakMilestoneModal('${m.id}')" style="display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); cursor: pointer; transition: 0.2s;">
            <div style="width: 38px; height: 38px; border-radius: 10px; background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; font-size: 1.2rem; flex-shrink: 0; opacity: ${m.active ? '1' : '0.4'};">🔥</div>
            <div style="flex: 1; min-width: 0;">
                <p style="color: white; font-size: 0.78rem; font-weight: 800; margin: 0;">${m.days} día${m.days !== 1 ? 's' : ''} seguidos</p>
                <p style="color: #888; font-size: 0.65rem; margin: 2px 0 0;">Regala ${_trialFormatoDuracion(m.hours || 24)} de Premium</p>
            </div>
            <span style="width: 8px; height: 8px; border-radius: 50%; background: ${m.active ? '#2ecc71' : '#666'}; flex-shrink: 0;" title="${m.active ? 'Activo' : 'Inactivo'}"></span>
        </div>
    `).join('');
};

// El usuario reclama el pase de UNA oferta puntual (offerId). La cadencia se
// respeta por oferta: users/{uid}.freeTrialClaims = { [offerId]: timestampMs }.
// Si ya tiene Premium activo (pago o de otra prueba en curso) no se le toca
// nada — ni para acortarlo, ni para "sumarle" de más: hay que esperar a que
// se le venza lo que ya tiene para poder pedir otra.
window.claimFreeTrial = async (offerId) => {
    const offer = (window.trialOffers || []).find(o => o.id === offerId);
    if (!offer || !offer.active) return;

    const user = auth.currentUser;
    if (!user) {
        window.closePremiumModal();
        if (window.showToast) window.showToast('Inicia sesión para probar Premium 🐒', 'primary');
        const authModal = document.getElementById('auth-modal');
        if (authModal) authModal.style.display = 'flex';
        return;
    }

    try {
        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);
        const userData = userSnap.exists() ? userSnap.data() : {};
        const now = Date.now();

        const hasActivePremium = userData.tier === 'admin'
            || (userData.tier === 'premium' && (!userData.premiumUntil || userData.premiumUntil > now));
        if (hasActivePremium) {
            if (window.showToast) window.showToast('Ya tenés acceso Premium activo 💎', 'info');
            return;
        }

        const claims = userData.freeTrialClaims || {};
        const lastClaim = claims[offerId];
        const cadenceMs = offer.cadenceHours * 60 * 60 * 1000;
        if (lastClaim && (now - lastClaim) < cadenceMs) {
            const nextDate = new Date(lastClaim + cadenceMs).toLocaleString();
            if (window.showToast) window.showToast(`Ya usaste "${offer.name}". Podés volver a usarla el ${nextDate}.`, 'info');
            return;
        }

        const durationMs = offer.durationHours * 60 * 60 * 1000;
        await setDoc(userRef, {
            tier: 'premium',
            premiumUntil: now + durationMs,
            premiumGrantedAt: now,
            freeTrialClaims: { ...claims, [offerId]: now }
        }, { merge: true });
        await window.refreshUserTier(user.uid);
        // Sin esto, los anuncios ya inyectados (como invitado/free, antes de
        // reclamar) seguían visibles hasta el próximo login — el beneficio
        // "sin publicidad" no se notaba hasta refrescar la página.
        if (typeof window.hideAllAdSlots === 'function') window.hideAllAdSlots();
        window.closePremiumModal();
        if (window.showToast) window.showToast(`🎁 ¡Listo! Premium activado: ${_trialFormatoDuracion(offer.durationHours)}.`, 'success');
    } catch (e) {
        console.error('Error activando prueba gratis:', e);
        if (window.showToast) window.showToast('No se pudo activar la prueba gratis. Intenta de nuevo.', 'error');
    }
};

window.renderFreeTrialBanner = (isAlreadyPaid) => {
    const wrap = document.getElementById('free-trial-offers');
    if (!wrap) return;
    const trialClaims = window.currentUserFreeTrialClaims || {};
    const trialNow = Date.now();
    // Las que están en cooldown (ya reclamadas, todavía no vuelven a estar
    // disponibles) no se listan acá — ese estado ya lo muestra el ícono
    // gris con ✓ de la fila de arriba; repetirlo acá con un cartel "Usada"
    // solo era ruido en el modal.
    const activas = (window.trialOffers || []).filter(o => {
        if (!o.active) return false;
        const lastClaim = trialClaims[o.id];
        const cadenceMs = (o.cadenceHours || 0) * 60 * 60 * 1000;
        return !(lastClaim && (trialNow - lastClaim) < cadenceMs);
    });
    if (activas.length === 0 || isAlreadyPaid) {
        wrap.style.display = 'none';
        if (typeof window._updateRewardsSectionVisibility === 'function') window._updateRewardsSectionVisibility();
        return;
    }
    wrap.innerHTML = activas.map(o => `
        <div style="padding:14px 16px; background:rgba(46,204,113,0.08); border:1px solid rgba(46,204,113,0.3); border-radius:12px; display:flex; align-items:center; gap:12px;">
            <div style="width:44px; height:44px; border-radius:12px; background:rgba(46,204,113,0.15); border:2px solid rgba(46,204,113,0.4); display:flex; align-items:center; justify-content:center; font-size:1.4rem; flex-shrink:0;">${o.icon || _trialIcon(o.durationHours || 24)}</div>
            <div style="flex:1; min-width:0;">
                <p style="color:#2ecc71; font-weight:800; font-size:0.85rem; margin:0 0 2px;">${_escTrialHtml(o.name)}</p>
                <p style="color:#aaa; font-size:0.72rem; margin:0;">${_trialFormatoDuracion(o.durationHours)} de acceso VIP sin costo, hasta una vez cada ${_trialFormatoDuracion(o.cadenceHours)}.</p>
            </div>
            <button onclick="window.claimFreeTrial('${o.id}')" style="background:#2ecc71; color:#000; border:none; border-radius:10px; padding:10px 16px; font-weight:800; font-size:0.78rem; cursor:pointer; white-space:nowrap; flex-shrink:0;">Activar</button>
        </div>
    `).join('');
    wrap.style.display = 'flex';
    if (typeof window._updateRewardsSectionVisibility === 'function') window._updateRewardsSectionVisibility();
};

// #free-trial-offers y #streak-detail viven juntos adentro de #rewards-section
// ("🎁 Recompensas"), separados de los planes pagos — pero cada uno se
// muestra u oculta de forma independiente, así que hace falta este chequeo
// aparte para saber si el contenedor común tiene que aparecer o no.
window._updateRewardsSectionVisibility = () => {
    const section = document.getElementById('rewards-section');
    if (!section) return;
    const trialVisible = document.getElementById('free-trial-offers')?.style.display !== 'none';
    const streakVisible = document.getElementById('streak-detail')?.style.display !== 'none';
    const referralVisible = document.getElementById('referral-card')?.style.display !== 'none';
    section.style.display = (trialVisible || streakVisible || referralVisible) ? 'block' : 'none';
};

// El plan Gratuito antes era una tarjeta fija en el código (no se veía ni
// se podía tocar desde el admin). Ahora es un plan más con id fijo 'free' —
// se autogenera la primera vez si no existe todavía, así el admin puede
// editar qué incluye (o no) sin tener que tocar código.
window.ensureFreePlanExists = () => {
    if (!window.plansConfig) window.plansConfig = [];
    if (window.plansConfig.some(p => p.id === 'free')) return;
    window.plansConfig.unshift({
        id: 'free',
        name: 'Gratuito',
        price: 0,
        currency: 'USD',
        period: 'mes',
        badge: '',
        highlighted: false,
        noAds: false,
        features: ['Con publicidad', 'Estrenos VIP bloqueados', 'Calidad estándar'],
        active: true,
        order: -1
    });
};

// ✅ SOLO ADMIN. Hasta el 2026-08-15 era una trampa: loadPlansConfig() la llamaba en el
// arranque (para la ventanita de Premium), así que corría para todo visitante sin hacer
// nada. Se desacopló: ahora solo la llaman switchAdminTab('plans') y las acciones del
// editor (guardar/crear/borrar). Se puede mover a un módulo solo-admin.
window.renderPlansList = () => {
    const list = document.getElementById('plan-list');
    if (!list) return;

    const plans = window.plansConfig || [];

    if (plans.length === 0) {
        list.innerHTML = '<p style="grid-column: 1/-1; font-size: 0.7rem; color: #444; text-align: center; padding: 30px;">No hay planes. Crea uno para empezar. 💎</p>';
        return;
    }

    list.innerHTML = plans.map(p => {
        const icon = p.id === 'free' ? '🐾' : (p.highlighted ? '⭐' : '💎');
        const feats = (p.features || []).slice(0, 3);
        const extra = (p.features || []).length - feats.length;
        return `
        <div onclick="window.editPlan('${p.id}')" style="position: relative; background: ${p.highlighted ? 'linear-gradient(160deg, rgba(255,122,0,0.18), rgba(255,122,0,0.02))' : 'rgba(255,255,255,0.03)'}; border: 1px solid ${p.highlighted ? 'var(--primary)' : 'rgba(255,255,255,0.08)'}; border-radius: 16px; padding: 18px; cursor: pointer; transition: 0.25s; display: flex; flex-direction: column; gap: 10px;">
            ${p.badge ? `<span style="position: absolute; top: -10px; left: 16px; background: var(--primary); color: #000; font-size: 0.6rem; font-weight: 800; padding: 3px 10px; border-radius: 20px; text-transform: uppercase;">${_escPlanHtml(p.badge)}</span>` : ''}
            <div onclick="event.stopPropagation(); window.togglePlanActiveQuick('${p.id}')" title="${p.active ? 'Activo' : 'Inactivo'}" style="position: absolute; top: 16px; right: 16px; width: 32px; height: 18px; background: ${p.active ? 'var(--primary)' : '#444'}; border-radius: 10px; cursor: pointer; transition: 0.3s;">
                <div style="width: 14px; height: 14px; background: white; border-radius: 50%; position: relative; top: 2px; ${p.active ? 'left: 16px' : 'left: 2px'}; transition: 0.3s; box-shadow: 0 2px 5px rgba(0,0,0,0.3);"></div>
            </div>

            <div style="font-size: 1.6rem;">${icon}</div>
            <div>
                <p style="color: white; font-size: 0.95rem; font-weight: 800; margin: 0;">${_escPlanHtml(p.name || 'Sin Nombre')}</p>
                <p style="color: #666; font-size: 0.6rem; margin: 2px 0 0; text-transform: uppercase; letter-spacing: 0.5px;">${p.active ? '● Activo' : '○ Inactivo'}</p>
            </div>
            <div style="display: flex; align-items: baseline; gap: 4px;">
                <span style="font-size: 1.6rem; font-weight: 900; color: white;">${p.price ?? 0}</span>
                <span style="font-size: 0.75rem; color: #999;">${_escPlanHtml(p.currency || 'USD')} / ${_escPlanHtml(p.period || 'mes')}</span>
            </div>
            ${feats.length ? `<ul style="margin: 4px 0 0; padding-left: 18px; color: #999; font-size: 0.7rem; display: flex; flex-direction: column; gap: 3px;">${feats.map(f => `<li>${_escPlanHtml(f)}</li>`).join('')}${extra > 0 ? `<li style="color: #555;">+${extra} más</li>` : ''}</ul>` : ''}
        </div>`;
    }).join('');
};

window.togglePlanActiveQuick = (id) => {
    const plan = (window.plansConfig || []).find(p => p.id === id);
    if (!plan) return;
    plan.active = !plan.active;
    window.renderPlansList();
    if (editingPlanId === id) {
        const activeCheck = document.getElementById('plan-edit-active');
        if (activeCheck) activeCheck.checked = plan.active;
    }
    // No guardamos a Firestore en cada click, hay que darle a GUARDAR.
};

// Un plan recién creado con "+ Nuevo Plan" vive en memoria (window.plansConfig)
// desde antes de guardarlo, para que el modal tenga algo que editar. Si el
// admin cierra el modal sin tocar "Guardar", hay que sacarlo de la lista para
// que no quede un plan fantasma sin persistir.
let _pendingNewPlanId = null;

window.createNewPlan = () => {
    const plans = window.plansConfig || [];
    const newPlan = {
        id: 'plan_' + Date.now().toString(36),
        name: 'Nuevo Plan ' + (plans.length + 1),
        price: 4.99,
        currency: 'USD',
        period: 'mes',
        badge: '',
        highlighted: false,
        noAds: true,
        features: ['Sin publicidad'],
        active: true,
        order: plans.length
    };

    if (!window.plansConfig) window.plansConfig = [];
    window.plansConfig.push(newPlan);
    _pendingNewPlanId = newPlan.id;
    window.editPlan(newPlan.id);
};

window.editPlan = (id) => {
    editingPlanId = id;
    const plan = (window.plansConfig || []).find(p => p.id === id);
    if (!plan) return;

    const setVal = (elId, val) => {
        const el = document.getElementById(elId);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!val;
        else el.value = val;
    };
    const setTxt = (elId, txt) => {
        const el = document.getElementById(elId);
        if (el) el.innerText = txt;
    };

    setTxt('plan-edit-id', plan.id);
    setVal('plan-edit-name', plan.name || '');
    setVal('plan-edit-price', plan.price ?? 0);
    setVal('plan-edit-currency', plan.currency || 'USD');
    setVal('plan-edit-period', plan.period || 'mes');
    setVal('plan-edit-badge', plan.badge || '');
    setVal('plan-edit-whatsapp', plan.whatsapp || '');
    setVal('plan-edit-highlighted', !!plan.highlighted);
    setVal('plan-edit-noads', !!plan.noAds);
    setVal('plan-edit-features', (plan.features || []).join('\n'));
    setVal('plan-edit-active', !!plan.active);

    // El plan Gratuito siempre tiene que existir — no se puede borrar.
    const deleteBtn = document.getElementById('btn-delete-plan');
    if (deleteBtn) deleteBtn.style.display = (plan.id === 'free') ? 'none' : 'flex';

    const modal = document.getElementById('plan-edit-modal');
    if (modal) modal.style.display = 'flex';
};

window.closePlanEditModal = () => {
    if (_pendingNewPlanId && _pendingNewPlanId === editingPlanId) {
        window.plansConfig = (window.plansConfig || []).filter(p => p.id !== _pendingNewPlanId);
    }
    _pendingNewPlanId = null;
    const modal = document.getElementById('plan-edit-modal');
    if (modal) modal.style.display = 'none';
    editingPlanId = null;
};

window.deleteCurrentPlan = async () => {
    if (!editingPlanId) return;
    if (editingPlanId === 'free') {
        if (window.showToast) window.showToast('El plan Gratuito no se puede borrar — es la base de todos los demás.', 'info');
        return;
    }
    if (!confirm('¿Seguro que quieres borrar este plan? 💎🗑️')) return;

    window.plansConfig = (window.plansConfig || []).filter(p => p.id !== editingPlanId);
    editingPlanId = null;
    _pendingNewPlanId = null;

    await window.savePlansConfig();

    const modal = document.getElementById('plan-edit-modal');
    if (modal) modal.style.display = 'none';
};

window.savePlansConfig = async () => {
    const btn = document.getElementById('btn-save-plans');
    if (btn) btn.innerText = "💾 GUARDANDO...";

    if (editingPlanId) {
        const plan = (window.plansConfig || []).find(p => p.id === editingPlanId);
        if (plan) {
            plan.name = document.getElementById('plan-edit-name')?.value || plan.name;
            // Acepta coma o punto como separador decimal (en español lo natural es la coma,
            // pero el dato interno siempre se guarda con punto).
            const priceRaw = (document.getElementById('plan-edit-price')?.value || '').trim().replace(',', '.');
            plan.price = parseFloat(priceRaw) || 0;
            plan.currency = document.getElementById('plan-edit-currency')?.value || 'USD';
            plan.period = document.getElementById('plan-edit-period')?.value || 'mes';
            plan.badge = document.getElementById('plan-edit-badge')?.value || '';
            plan.whatsapp = (document.getElementById('plan-edit-whatsapp')?.value || '').trim().replace(/[^\d]/g, '');
            plan.highlighted = document.getElementById('plan-edit-highlighted')?.checked || false;
            plan.noAds = document.getElementById('plan-edit-noads')?.checked || false;
            plan.active = document.getElementById('plan-edit-active')?.checked || false;
            plan.features = (document.getElementById('plan-edit-features')?.value || '')
                .split('\n').map(f => f.trim()).filter(Boolean);
        }
    }

    try {
        // merge: true para no pisar el resto del documento (ej: el WhatsApp
        // general, que se guarda aparte con su propio botón).
        await setDoc(doc(db, "configs", "plans"), { plans: window.plansConfig || [] }, { merge: true });
        if (window.showToast) window.showToast("✅ Planes actualizados en la selva.", "success");
        _pendingNewPlanId = null;
        editingPlanId = null;
        const modal = document.getElementById('plan-edit-modal');
        if (modal) modal.style.display = 'none';
        window.renderPlansList();
        if (typeof window.maybeShowPremiumPromo === 'function') window.maybeShowPremiumPromo();
    } catch (e) {
        console.error("Error guardando planes:", e);
        if (window.showToast) window.showToast("❌ Error al guardar los planes.", "error");
    } finally {
        if (btn) btn.innerText = "💾 GUARDAR";
    }
};

// --- Vitrina pública de Planes Premium (banner + modal) 🍿 ---
window.openPremiumModal = (movie) => {
    const tier = window.currentUserTier || 'free';
    const isAlreadyPaid = tier === 'premium' || tier === 'admin';

    const title = document.getElementById('premium-modal-title');
    if (title) title.innerText = isAlreadyPaid ? '💎 Mi Plan' : '🌴 Hazte Premium';

    const subtitle = document.getElementById('premium-modal-subtitle');
    if (subtitle) {
        subtitle.innerText = (movie && movie.title)
            ? `"${movie.title}" es contenido VIP — disponible para suscriptores Premium.`
            : (isAlreadyPaid ? 'Estos son los beneficios de tu plan actual.' : 'Sin publicidad, acceso VIP y más.');
    }
    const modal = document.getElementById('premium-plans-modal');
    if (modal) modal.style.display = 'flex';

    // Si loadPlansConfig/loadTrialOffers todavía no terminaron (típico si se
    // abre esto apenas carga la página — el botón flotante nuevo lo hace muy
    // fácil), dibuja primero un estado de carga y vuelve a pintar en cuanto
    // lleguen los datos reales; si no, se veía "Todavía no hay planes" aunque
    // sí hubiera, solo que no habían llegado todavía.
    if (Array.isArray(window.plansConfig)) {
        window.renderPremiumPlansGrid();
    } else {
        const grid = document.getElementById('premium-plans-grid');
        if (grid) grid.innerHTML = '<p style="text-align:center; color:#666; font-size:0.8rem; grid-column: 1/-1;">Cargando planes...</p>';
    }
    if (typeof window.renderFreeTrialBanner === 'function' && Array.isArray(window.trialOffers)) window.renderFreeTrialBanner(isAlreadyPaid);
    if (typeof window.renderPremiumTimeRemaining === 'function') window.renderPremiumTimeRemaining();
    if (typeof window.renderStreakDetail === 'function' && Array.isArray(window.streakMilestones)) window.renderStreakDetail();
    if (typeof window.renderRewardsIconStrip === 'function') window.renderRewardsIconStrip();
    if (typeof window.updateReferralCard === 'function') window.updateReferralCard();

    Promise.all([window._plansReadyPromise, window._trialOffersReadyPromise, window._streakConfigReadyPromise]).then(() => {
        if (!modal || modal.style.display === 'none') return; // se cerró mientras esperábamos
        window.renderPremiumPlansGrid();
        if (typeof window.renderFreeTrialBanner === 'function') window.renderFreeTrialBanner(isAlreadyPaid);
        if (typeof window.renderStreakDetail === 'function') window.renderStreakDetail();
        if (typeof window.renderRewardsIconStrip === 'function') window.renderRewardsIconStrip();
    });
};

// Fila única con TODOS los íconos de recompensa (pruebas gratis + escalones
// de racha) juntos, aparte de la tarjeta de la racha y de las tarjetas de
// prueba gratis — un "vistazo" general antes de entrar en el detalle de
// cada una. 4 estados visuales: 'claimed' (verde+✓, racha ya cobrada),
// 'ready' (naranja, disponible ahora), 'locked' (gris/apagado, racha que
// todavía no llegaste a ese día) y 'cooldown' (gris+✓, prueba gratis ya
// usada — no se pinta en verde para no leerse como "disponible").
window.renderRewardsIconStrip = () => {
    const strip = document.getElementById('rewards-icon-strip');
    if (!strip) return;

    const trialClaims = window.currentUserFreeTrialClaims || {};
    const trialNow = Date.now();
    const trialItems = (window.trialOffers || []).filter(o => o.active).map(o => {
        const lastClaim = trialClaims[o.id];
        const cadenceMs = (o.cadenceHours || 0) * 60 * 60 * 1000;
        const onCooldown = !!(lastClaim && (trialNow - lastClaim) < cadenceMs);
        const nextDate = onCooldown ? new Date(lastClaim + cadenceMs).toLocaleString() : null;
        return {
            icon: o.icon || _trialIcon(o.durationHours || 24),
            label: o.name,
            state: onCooldown ? 'cooldown' : 'ready',
            title: onCooldown ? `${o.name} — ya usada, disponible el ${nextDate}` : `${o.name} — ${_trialFormatoDuracion(o.durationHours || 24)} disponible`,
            type: 'trial',
            offerId: o.id,
            onCooldown,
            detailText: onCooldown
                ? `✅ Ya usaste "${o.name}". Podés volver a usarla el ${nextDate}.`
                : `${_trialFormatoDuracion(o.durationHours)} de acceso VIP sin costo, hasta una vez cada ${_trialFormatoDuracion(o.cadenceHours)}.`,
        };
    });

    const count = window.currentStreakCount || 0;
    const claimedMilestones = window.currentStreakClaimedMilestones || [];
    const streakItems = (window.streakMilestones || []).filter(m => m.active !== false).sort((a, b) => a.days - b.days).map(m => {
        const isClaimed = claimedMilestones.includes(m.days);
        const isReached = count >= m.days;
        const state = isClaimed ? 'claimed' : (isReached ? 'ready' : 'locked');
        const detailText = isClaimed
            ? '✅ Ya cobraste este premio — vuelve a estar disponible si arrancás otra racha.'
            : (isReached ? '🎁 ¡Ya es tuyo! Se acredita solo.' : `Te faltan ${m.days - count} día${(m.days - count) !== 1 ? 's' : ''} seguidos para desbloquearlo.`);
        return {
            icon: _trialIcon(m.hours || 24),
            label: `${m.days}d`,
            state,
            title: `${m.days} días seguidos → ${_trialFormatoDuracion(m.hours || 24)} de Premium`,
            type: 'streak',
            days: m.days,
            hours: m.hours,
            detailText,
        };
    });

    const items = [...trialItems, ...streakItems];
    window._rewardsIconStripItems = items; // lo lee window.showRewardIconDetail() al tocar un ícono

    if (items.length === 0) {
        strip.style.display = 'none';
        const detailPanel = document.getElementById('rewards-icon-detail');
        if (detailPanel) detailPanel.style.display = 'none';
        return;
    }

    // El panel no arranca vacío/escondido: mientras no toques ningún ícono,
    // muestra un texto general (se re-dibuja así cada vez que cambian los
    // datos, para no dejar pegado el detalle de un ícono que ya no aplica).
    const detailPanel = document.getElementById('rewards-icon-detail');
    if (detailPanel) {
        detailPanel.style.display = 'flex';
        detailPanel.innerHTML = `
            <div style="width:40px; height:40px; border-radius:10px; background:rgba(0,0,0,0.3); display:flex; align-items:center; justify-content:center; font-size:1.2rem; flex-shrink:0;">🎁</div>
            <div style="flex:1; min-width:0;">
                <p style="color:#aaa; font-size:0.75rem; margin:0;">Tocá un ícono para ver el detalle de esa recompensa y activarla.</p>
            </div>
        `;
    }

    const estilo = {
        claimed: { bg: 'rgba(46,204,113,0.15)', border: '#2ecc71', opacity: '1', grayscale: 'none', check: '✓', checkBg: '#2ecc71', checkColor: '#06210f' },
        ready: { bg: 'rgba(255,122,0,0.15)', border: 'var(--primary)', opacity: '1', grayscale: 'none', check: '' },
        locked: { bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.12)', opacity: '0.45', grayscale: 'grayscale(85%)', check: '' },
        // Prueba gratis ya reclamada, todavía en cooldown: gris como "locked"
        // (verde ahí se leía como "disponible", que es justo lo contrario),
        // incluido el circulito de la esquina — antes quedaba verde fijo
        // sin importar el estado, y seguía leyéndose como "disponible".
        cooldown: { bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.12)', opacity: '0.5', grayscale: 'grayscale(85%)', check: '✓', checkBg: '#555', checkColor: '#ccc' },
    };

    strip.style.display = 'flex';
    strip.innerHTML = items.map((item, idx) => {
        const s = estilo[item.state];
        return `
        <div onclick="window.showRewardIconDetail(${idx})" style="display:flex; flex-direction:column; align-items:center; gap:4px; width:52px; cursor:pointer;" title="${_escTrialHtml(item.title)}">
            <div style="position:relative; width:44px; height:44px; border-radius:13px; display:flex; align-items:center; justify-content:center; font-size:1.35rem; background:${s.bg}; border:2px solid ${s.border}; filter:${s.grayscale}; opacity:${s.opacity};">
                ${item.icon}
                ${s.check ? `<span style="position:absolute; bottom:-4px; right:-4px; background:${s.checkBg}; color:${s.checkColor}; font-size:0.55rem; width:15px; height:15px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:900;">${s.check}</span>` : ''}
            </div>
            <span style="font-size:0.58rem; color:#ccc; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:52px;">${_escTrialHtml(item.label)}</span>
        </div>`;
    }).join('');
};

// Se dispara al tocar un ícono de la fila de arriba — muestra info de esa
// recompensa puntual, y un botón de "Activar" solo si es una prueba gratis
// (los escalones de racha se cobran solos, no hay nada para "activar").
window.showRewardIconDetail = (idx) => {
    const item = (window._rewardsIconStripItems || [])[idx];
    const panel = document.getElementById('rewards-icon-detail');
    if (!item || !panel) return;

    const actionHtml = (item.type === 'trial' && !item.onCooldown)
        ? `<button onclick="window.claimFreeTrial('${item.offerId}')" style="background:#2ecc71; color:#000; border:none; border-radius:10px; padding:10px 16px; font-weight:800; font-size:0.78rem; cursor:pointer; white-space:nowrap; flex-shrink:0;">Activar</button>`
        : (item.type === 'trial' ? `<span style="color:#888; font-size:0.68rem; font-weight:700; white-space:nowrap; flex-shrink:0;">✅ Ya usada</span>` : '');

    panel.innerHTML = `
        <div style="width:40px; height:40px; border-radius:10px; background:rgba(0,0,0,0.3); display:flex; align-items:center; justify-content:center; font-size:1.2rem; flex-shrink:0;">${item.icon}</div>
        <div style="flex:1; min-width:0;">
            <p style="color:#fff; font-weight:800; font-size:0.8rem; margin:0 0 2px;">${_escTrialHtml(item.type === 'trial' ? item.label : `${item.label} de racha`)}</p>
            <p style="color:#aaa; font-size:0.72rem; margin:0;">${_escTrialHtml(item.detailText)}</p>
        </div>
        ${actionHtml}
    `;
    panel.style.display = 'flex';
};

// Ladder de escalones dentro del modal de Premium: cuántos días lleva el
// usuario, y qué falta para el próximo premio. Reusa window.streakMilestones
// (cargado para todo visitante desde DOMContentLoaded) y el progreso cacheado
// en refreshUserTier (currentStreakCount/currentStreakClaimedMilestones).
window.renderStreakDetail = () => {
    const wrap = document.getElementById('streak-detail');
    if (!wrap) return;

    const milestones = (window.streakMilestones || []).filter(m => m.active !== false).sort((a, b) => a.days - b.days);
    if (milestones.length === 0) {
        wrap.style.display = 'none';
        if (typeof window._updateRewardsSectionVisibility === 'function') window._updateRewardsSectionVisibility();
        return;
    }

    const count = window.currentStreakCount || 0;
    const claimed = window.currentStreakClaimedMilestones || [];
    const maxDays = milestones[milestones.length - 1].days;
    const fillPct = Math.min(100, (count / maxDays) * 100);

    wrap.style.display = 'block';
    wrap.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
            <span style="font-size:1.1rem;">🔥</span>
            <span style="color:#fff; font-size:0.82rem; font-weight:800;">${count > 0 ? `Llevás ${count} día${count !== 1 ? 's' : ''} seguido${count !== 1 ? 's' : ''}` : 'Empezá tu racha viendo algo hoy'}</span>
        </div>

        <!-- La fila de íconos por escalón ahora vive arriba, en #rewards-icon-strip
             (junto con las pruebas gratis) — tenerla acá también era mostrar
             lo mismo dos veces. Adentro de la racha queda solo la barrita +
             el detalle. -->

        <!-- Barrita de progreso hasta el escalón más grande, con una marca por
             cada premio (verde+✓ = ya lo cobraste, gris = todavía no). Más
             compacta que dibujar un frasco por escalón, y de un vistazo se ve
             cuánto falta para el próximo. -->
        <div style="position:relative; height:8px; background:rgba(255,255,255,0.08); border-radius:5px; margin:6px 7px 20px;">
            <div style="height:100%; width:${fillPct}%; background:linear-gradient(90deg, var(--primary), #ffb347); border-radius:5px; transition:width .3s;"></div>
            ${milestones.map(m => {
                const isClaimed = claimed.includes(m.days);
                const leftPct = (m.days / maxDays) * 100;
                return `
                <div style="position:absolute; left:${leftPct}%; top:50%; transform:translate(-50%,-50%);" title="${m.days} días seguidos → ${_trialFormatoDuracion(m.hours || 24)} de Premium">
                    <div style="width:14px; height:14px; border-radius:50%; background:${isClaimed ? '#2ecc71' : '#1a1a1a'}; border:2px solid ${isClaimed ? '#2ecc71' : 'rgba(255,255,255,0.3)'}; display:flex; align-items:center; justify-content:center; font-size:0.5rem; color:#06210f; font-weight:900;">${isClaimed ? '✓' : ''}</div>
                    <span style="position:absolute; top:16px; left:50%; transform:translateX(-50%); font-size:0.55rem; color:${isClaimed ? '#fff' : '#888'}; white-space:nowrap;">${m.days}d</span>
                </div>`;
            }).join('')}
        </div>

        <!-- Desplegable en vez de la lista siempre abierta: con varios escalones
             cargados (ej. 4) ocupaba tanto que en desktop empujaba los planes
             pagos fuera de la vista. Colapsado por defecto, el detalle sigue
             ahí para quien lo quiera abrir. -->
        <details>
            <summary style="cursor:pointer; font-size:0.68rem; color:#999; font-weight:700;">Ver detalle de cada escalón</summary>
            <div style="display:flex; flex-direction:column; gap:6px; margin-top:8px;">
                ${milestones.map(m => {
                    const isClaimed = claimed.includes(m.days);
                    const isReached = count >= m.days;
                    const statusTxt = isClaimed ? '✅ Ya la cobraste' : (isReached ? '🎁 ¡Lista para el próximo día!' : `Faltan ${m.days - count} día${(m.days - count) !== 1 ? 's' : ''}`);
                    return `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-radius:8px; background:rgba(255,255,255,0.03); opacity:${isClaimed ? '0.6' : '1'};">
                        <span style="color:#ccc; font-size:0.75rem;">${m.days} día${m.days !== 1 ? 's' : ''} seguidos → <b style="color:#fff;">${_trialFormatoDuracion(m.hours || 24)}</b> de Premium</span>
                        <span style="color:${isClaimed ? '#2ecc71' : (isReached ? 'var(--primary)' : '#888')}; font-size:0.68rem; font-weight:700; white-space:nowrap; margin-left:8px;">${statusTxt}</span>
                    </div>`;
                }).join('')}
            </div>
        </details>
        <p style="font-size:0.6rem; color:#666; margin:10px 0 0;">Mirá algo (2+ min) todos los días para no perder la racha.</p>
    `;
    if (typeof window._updateRewardsSectionVisibility === 'function') window._updateRewardsSectionVisibility();
};

// Barra grande (con % real, usando premiumGrantedAt como inicio) que vive
// dentro del modal — el badge de la navbar es el resumen rápido, esto es el
// detalle completo para cuando el usuario abre "Hazte Premium"/"Mi Plan".
window.renderPremiumTimeRemaining = () => {
    const wrap = document.getElementById('premium-time-remaining');
    if (!wrap) return;

    const isPremium = window.currentUserTier === 'premium' || window.currentUserTier === 'admin';
    const remaining = window.currentUserPremiumUntil ? window.currentUserPremiumUntil - Date.now() : 0;
    if (!isPremium || !window.currentUserPremiumUntil || remaining <= 0) {
        wrap.style.display = 'none';
        return;
    }

    // Sin premiumGrantedAt (cuentas viejas de antes de este campo) no sabemos
    // cuándo arrancó — mostramos la barra casi llena en vez de esconderla.
    const grantedAt = window.currentUserPremiumGrantedAt || (window.currentUserPremiumUntil - remaining);
    const total = Math.max(1, window.currentUserPremiumUntil - grantedAt);
    const pct = Math.max(2, Math.min(100, Math.round((remaining / total) * 100)));

    wrap.style.display = 'block';
    wrap.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <span style="color:#ccc; font-size:0.72rem; font-weight:700;">⏳ Tiempo Premium restante</span>
            <span style="color:var(--primary); font-size:0.78rem; font-weight:800;">${_formatTiempoRestante(remaining)}</span>
        </div>
        <div style="width:100%; height:10px; background:rgba(255,255,255,0.08); border-radius:6px; overflow:hidden;">
            <div style="width:${pct}%; height:100%; background:linear-gradient(90deg, var(--primary), #ffb347); border-radius:6px; transition: width 1s linear;"></div>
        </div>
    `;

    if (!_premiumModalBarTimer) _premiumModalBarTimer = setInterval(() => {
        const modal = document.getElementById('premium-plans-modal');
        if (modal && modal.style.display !== 'none') {
            window.renderPremiumTimeRemaining();
        } else {
            clearInterval(_premiumModalBarTimer);
            _premiumModalBarTimer = null;
        }
    }, 30000);
};
let _premiumModalBarTimer = null;

window.closePremiumModal = () => {
    const modal = document.getElementById('premium-plans-modal');
    if (modal) modal.style.display = 'none';
};

// El bloqueo VIP (openPlayer) llama a esta función al toparse con contenido
// aún no liberado para usuarios free — reutiliza el mismo modal de planes.
window.showVipLockModal = (movie) => {
    window.openPremiumModal(movie);
};

window.renderPremiumPlansGrid = () => {
    const grid = document.getElementById('premium-plans-grid');
    if (!grid) return;

    const plans = (window.plansConfig || [])
        .filter(p => p.active)
        .sort((a, b) => (a.order || 0) - (b.order || 0));

    if (plans.length === 0) {
        grid.innerHTML = '<p style="text-align:center; color:#666; font-size:0.8rem; grid-column: 1/-1;">Todavía no hay planes disponibles. 🌴</p>';
        return;
    }

    // El plan Gratuito es un plan real más (id fijo 'free', ver
    // ensureFreePlanExists) — se dibuja con la misma tarjeta que los pagos,
    // solo que sin poder pedirlo (ya lo tenés por defecto) y marcando cuál
    // es tu plan actual según el tier real.
    const currentTier = window.currentUserTier || 'free';

    grid.innerHTML = plans.map(p => {
        const isFree = p.id === 'free';
        const isCurrentPlan = isFree
            ? currentTier === 'free'
            : (currentTier === 'premium' || currentTier === 'admin');
        const periodTxt = isFree ? '' : (p.period === 'unico' ? 'pago único' : `/ ${_escPlanHtml(p.period || 'mes')}`);
        const priceTxt = isFree ? '$0' : `${p.price ?? 0} ${_escPlanHtml(p.currency || 'USD')}`;

        // El plan Gratuito nunca se "pide" — o ya lo tenés (Plan actual) o
        // simplemente no aplica si ya sos premium/admin.
        const actionHtml = isCurrentPlan
            ? `<div style="text-align:center; padding:10px; font-weight:800; font-size:0.8rem; color:#555;">Plan actual</div>`
            : (isFree ? '' : `<button onclick="window.requestPlanInterest('${p.id}')" style="background:${p.highlighted ? 'var(--primary,#FF6600)' : 'rgba(255,255,255,0.08)'}; color:${p.highlighted ? '#000' : '#fff'}; border:none; border-radius:10px; padding:10px; font-weight:800; font-size:0.8rem; cursor:pointer;">Quiero este plan</button>`);

        return `
        <div style="background:rgba(255,255,255,0.03); border:2px solid ${p.highlighted ? 'var(--primary,#FF6600)' : 'rgba(255,255,255,0.08)'}; border-radius:14px; padding:20px; display:flex; flex-direction:column; ${isFree ? 'opacity:0.9;' : ''}">
            ${p.badge ? `<span style="align-self:flex-start; background:rgba(255,122,0,0.15); color:var(--primary,#FF6600); font-size:0.6rem; font-weight:900; padding:3px 8px; border-radius:6px; margin-bottom:10px; text-transform:uppercase;">${_escPlanHtml(p.badge)}</span>` : ''}
            <h3 style="color:#fff; margin:0 0 6px; font-size:1rem;">${isFree ? '🐾 ' : ''}${_escPlanHtml(p.name || 'Plan')}</h3>
            <p style="color:${isFree ? '#888' : 'var(--primary,#FF6600)'}; font-weight:800; font-size:1.3rem; margin:0 0 14px;">${priceTxt} ${periodTxt ? `<span style="color:#888; font-size:0.7rem; font-weight:600;">${periodTxt}</span>` : ''}</p>
            <ul style="list-style:none; padding:0; margin:0 0 16px; flex:1; display:flex; flex-direction:column; gap:8px;">
                ${(p.features || []).map(f => `<li style="color:${isFree ? '#999' : '#ccc'}; font-size:0.78rem; display:flex; gap:6px;"><span>${isFree ? '•' : '✅'}</span>${_escPlanHtml(f)}</li>`).join('')}
            </ul>
            ${actionHtml}
        </div>`;
    }).join('');
};

// Todavía no hay pasarela de pago conectada: el CTA manda el pedido al chat
// de soporte (ya existente) para que el admin lo cierre a mano mientras
// tanto — así el botón hace algo real en vez de un "Próximamente" muerto.
window.requestPlanInterest = async (planId) => {
    const plan = (window.plansConfig || []).find(p => p.id === planId);
    if (!plan) return;

    const user = auth.currentUser;
    if (!user) {
        window.closePremiumModal();
        if (window.showToast) window.showToast('Inicia sesión para contratar un plan 🐒', 'primary');
        const authModal = document.getElementById('auth-modal');
        if (authModal) authModal.style.display = 'flex';
        return;
    }

    window.closePremiumModal();

    const periodTxt = plan.period === 'unico' ? 'pago único' : `/${plan.period}`;
    const text = `Hola 👋 Quiero contratar el plan "${plan.name}" (${plan.price} ${plan.currency} ${periodTxt}). ¿Cómo sigo?`;

    // Si el plan tiene un WhatsApp propio, se usa ese. Si no, cae al WhatsApp
    // general (aplica a todos los planes). Si tampoco hay uno general, el
    // pedido va al chat de soporte interno como antes.
    const whatsappTarget = plan.whatsapp || window.plansGlobalWhatsapp;
    if (whatsappTarget) {
        window.open(`https://wa.me/${whatsappTarget}?text=${encodeURIComponent(text)}`, '_blank');
        return;
    }

    await window.openSupportChat();

    try {
        await addDoc(collection(db, SUPPORT_COL), {
            uid: user.uid,
            userName: user.displayName || user.email || 'Usuario',
            userEmail: user.email || '',
            profileName: (_currentProfile && _currentProfile.name) || '',
            sender: 'user',
            text,
            createdAt: Date.now(),
            readByAdmin: false,
            readByUser: true
        });
        await window._loadSupportMessages();
        if (window.showToast) window.showToast('✅ Le avisamos al equipo, te responden por acá mismo.', 'success');
    } catch (e) {
        console.error('Error solicitando plan:', e);
        if (window.showToast) window.showToast('No se pudo enviar la solicitud. Intenta de nuevo.', 'error');
    }
};

// Ventanita "invitación a Premium" para usuarios free — aparece sola una vez
// por día como máximo (respetando el dismiss) y solo si hay algún plan activo.
window.maybeShowPremiumPromo = () => {
    try {
        const banner = document.getElementById('premium-promo-banner');
        if (!banner) return;

        const userTier = window.currentUserTier || 'free';
        const isPremiumUser = userTier === 'premium' || userTier === 'admin';
        if (isPremiumUser) { banner.style.display = 'none'; return; }

        const activePlans = (window.plansConfig || []).filter(p => p.active);
        if (activePlans.length === 0) { banner.style.display = 'none'; return; }

        const dismissedAt = Number(localStorage.getItem('selva_premium_promo_dismissed') || 0);
        const oneDay = 24 * 60 * 60 * 1000;
        if (Date.now() - dismissedAt < oneDay) return;

        banner.style.display = 'block';
    } catch (e) {
        console.warn('No se pudo mostrar la promo de Premium:', e);
    }
};

window.dismissPremiumPromo = () => {
    localStorage.setItem('selva_premium_promo_dismissed', String(Date.now()));
    const banner = document.getElementById('premium-promo-banner');
    if (banner) banner.style.display = 'none';
};

// --- GESTIÓN DE BANNER (Featured) ---
window.searchForBanner = () => {
    const queryStr = document.getElementById('admin-banner-search').value.toLowerCase().trim();
    const resultsContainer = document.getElementById('admin-banner-results');
    if (!queryStr) return;

    const matches = allContent.filter(m => m.title.toLowerCase().includes(queryStr)).slice(0, 10);
    
    resultsContainer.innerHTML = matches.map(m => `
        <div class="banner-search-item" style="flex: 0 0 80px; text-align: center; cursor: pointer;" onclick="window.toggleBannerPin('${m.id}', true)">
            <img src="${m.img}" style="width: 100%; border-radius: 8px; border: 2px solid transparent;" onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor='transparent'">
            <p style="font-size: 0.6rem; color: #aaa; margin-top: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${m.title}</p>
        </div>
    `).join('') || '<p style="font-size: 0.8rem; color: #555;">No se encontró nada en la selva. 🌴</p>';
};

window.renderAdminBannerList = () => {
    const container = document.getElementById('admin-banner-pinned-list');
    if (!container) return;

    const pinned = allContent.filter(m => m.pinned === true);
    
    if (pinned.length === 0) {
        container.innerHTML = '<p style="font-size: 0.8rem; color: #555;">No hay tesoros fijados en el banner. La selva decidirá automáticamente. 🍃</p>';
        return;
    }

    container.innerHTML = pinned.map(m => `
        <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255,122,0,0.05); padding: 10px; border-radius: 12px; border: 1px solid rgba(255,122,0,0.1); margin-bottom: 10px;">
            <div style="display: flex; align-items: center; gap: 15px;">
                <img src="${m.backdrop || m.img}" style="width: 70px; height: 40px; border-radius: 4px; object-fit: cover; border: 1px solid rgba(255,255,255,0.1);">
                <div>
                    <p style="color: white; font-weight: bold; font-size: 0.85rem; margin: 0;">${m.title}</p>
                    <div style="display: flex; gap: 8px; margin-top: 5px;">
                        <button class="btn" style="background: rgba(52, 152, 219, 0.2); color: #3498DB; border: 1px solid rgba(52,152,219,0.3); padding: 2px 8px; font-size: 0.6rem;" onclick="document.getElementById('banner-art-${m.id}').click()">🎨 Cambiar Arte</button>
                        <input type="file" id="banner-art-${m.id}" style="display:none;" onchange="window.uploadBannerArt('${m.id}', this.files[0])">
                    </div>
                </div>
            </div>
            <button class="btn" style="background: rgba(231,76,60,0.1); color: #E74C3C; border: 1px solid rgba(231,76,60,0.2); padding: 5px 10px; font-size: 0.7rem;" onclick="window.toggleBannerPin('${m.id}', false)">Quitar ✖</button>
        </div>
    `).join('');
};

window.uploadBannerArt = async (movieId, file) => {
    if (!file) return;
    try {
        if (window.showToast) window.showToast("Subiendo arte de banner... 🎨🌩️", "info");
        const url = await window.handleImageUpload(file, true); // Retorna la URL
        if (!url) throw new Error("No se pudo subir la imagen");

        const movieRef = doc(db, "movies", movieId);
        await updateDoc(movieRef, { backdrop: url });
        
        // Actualizar caché local
        const idx = allContent.findIndex(m => m.id === movieId);
        if (idx !== -1) allContent[idx].backdrop = url;

        if (window.showToast) window.showToast("¡Banner actualizado! 🌈🌴", "success");
        window.renderAdminBannerList();
        localStorage.removeItem('selvaflix_full_database');
    } catch (e) {
        console.error("Error subiendo banner art:", e);
        if (window.showToast) window.showToast("Error al subir el arte. 🐒", "error");
    }
};

window.toggleBannerPin = async (movieId, isPinned) => {
    try {
        const movieRef = doc(db, "movies", movieId);
        await updateDoc(movieRef, { pinned: isPinned });
        
        // Actualizar caché local
        const idx = allContent.findIndex(m => m.id === movieId);
        if (idx !== -1) allContent[idx].pinned = isPinned;
        
        if (isPinned && window.showToast) window.showToast("¡Tesoro fijado en el Banner! 🚩🌴", "success");
        if (!isPinned && window.showToast) window.showToast("Quitado del Banner. 🍃", "primary");
        
        window.renderAdminBannerList();
        document.getElementById('admin-banner-results').innerHTML = '';
        document.getElementById('admin-banner-search').value = '';
        
        // Invalidar caché de BD para que se refleje globalmente si es necesario
        localStorage.removeItem('selvaflix_full_database');
    } catch (e) {
        console.error("Error al fijar banner:", e);
        if (window.showToast) window.showToast("No se pudo clavar la bandera en la selva. 🐒", "error");
    }
};

window.handleSmartDate = (type) => {
  if (type === 'start') {
    const startVal = document.getElementById('metrics-start-date').value;
    if (!startVal) return;
    
    // Si tocas el primero, autocompletamos el fin de ese mes en el segundo
    const [year, month, day] = startVal.split('-').map(Number);
    const lastDayOfMonth = new Date(year, month, 0);
    document.getElementById('metrics-end-date').value = lastDayOfMonth.toISOString().split('T')[0];
  }
};

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ 📊 ANALÍTICAS — MUDADO A src/admin/analytics.js (2026-08-15)              ║
// ╠═══════════════════════════════════════════════════════════════════════════╣
// ║ Las ~600 líneas que estaban acá (loadMetrics, renderDayChart, los         ║
// ║ selectores de rango, etc.) viven ahora en su propio módulo, que se carga  ║
// ║ con import() dinámico desde switchAdminTab('analytics'). Un visitante     ║
// ║ normal ya no se lo descarga.                                              ║
// ║                                                                           ║
// ║ Quedó acá el modal de detalle de visitantes, que lee los datos por        ║
// ║ window._lastMetricsData (lo escribe loadMetrics desde el módulo).         ║
// ║                                                                           ║
// ║ ⚠️ Antes de mudar CUALQUIER otra cosa, leer                               ║
// ║    .agents/knowledge/KI_SEPARAR_ADMIN.md — ahí está explicado por qué     ║
// ║    mirar el código quieto da resultados FALSOS en este proyecto.          ║
// ╚═══════════════════════════════════════════════════════════════════════════╝


// Limpieza única: la "Etiqueta/Doblaje" (Latino/España/Inglés) que se guarda
// en cada título NO verifica nada real, es solo lo que estaba elegido en el
// desplegable al sembrar. Si se sembró anime/dramas asiáticos con "Latino"
// de default (lo normal, es el valor inicial del select), quedaron marcados
// con un doblaje que casi seguro no existe en las fuentes reales. Corregimos
// esa etiqueta para no prometer un doblaje latino que probablemente no está.
window.cleanupNonLatinoLabels = async () => {
    const affected = movieDatabase.trending.filter(m => {
        const esAsiatico = m.type === 'anime' || (m.original_title && CJK_REGEX.test(m.original_title));
        const marcadoLatino = (m.lang || 'es-MX') === 'es-MX';
        return esAsiatico && marcadoLatino;
    });

    if (affected.length === 0) {
        if (window.showToast) window.showToast('No hay títulos de anime/origen asiático marcados como Latino para corregir. 🎉', 'info');
        return { fixed: 0, total: 0 };
    }

    let fixed = 0;
    for (const m of affected) {
        try {
            await updateDoc(doc(db, "movies", m.id), { lang: 'en-US' });
            console.log(`✅ Etiqueta corregida: "${m.title}" (Latino → Inglés/Sub)`);
            m.lang = 'en-US'; // reflejar en memoria sin esperar un reload
            fixed++;
        } catch (e) {
            console.error('Error corrigiendo etiqueta de idioma:', m.title, e);
        }
    }

    localStorage.removeItem('selvaflix_full_database');
    localStorage.removeItem('selvaflix_cache_timestamp');
    if (document.getElementById('admin-view')?.style.display === 'block') renderInventory();
    if (window.showToast) window.showToast(`✅ ${fixed} etiqueta(s) corregida(s): ya no dicen "Latino" sin serlo.`, 'success');

    return { fixed, total: affected.length };
};

// Limpieza única de títulos guardados en japonés/chino (de siembras previas
// al fix de rescatarTituloLatino). Reusa esa misma lógica, pero sobre el
// catálogo ya existente en vez de sobre resultados nuevos de TMDB.
window.cleanupCJKTitles = async () => {
    const affected = movieDatabase.trending.filter(m => m.title && CJK_REGEX.test(m.title) && m.tmdbId);
    if (affected.length === 0) {
        if (window.showToast) window.showToast('No hay títulos en japonés/chino para limpiar. 🎉', 'info');
        return { fixed: 0, skipped: 0, total: 0 };
    }

    let fixed = 0, skipped = 0;
    for (const m of affected) {
        const endpoint = ['series', 'tv', 'anime'].includes(m.type) ? 'tv' : 'movie';
        try {
            const newTitle = await rescatarTituloLatino(m.title, endpoint, m.tmdbId);
            if (newTitle && newTitle !== m.title) {
                await updateDoc(doc(db, "movies", m.id), { title: newTitle });
                console.log(`✅ "${m.title}" → "${newTitle}"`);
                m.title = newTitle; // reflejar en memoria sin esperar un reload
                fixed++;
            } else {
                skipped++;
            }
        } catch (e) {
            console.error('Error limpiando título CJK:', m.title, e);
            skipped++;
        }
    }

    localStorage.removeItem('selvaflix_full_database');
    localStorage.removeItem('selvaflix_cache_timestamp');
    if (document.getElementById('admin-view')?.style.display === 'block') renderInventory();
    if (window.showToast) window.showToast(`✅ ${fixed} título(s) traducido(s), ${skipped} sin versión en inglés disponible.`, 'success');

    return { fixed, skipped, total: affected.length };
};

// Prueba las 5 fuentes del player contra un titulo puntual y dice si ALGUNA
// tiene contenido real. Reutiliza las mismas firmas de "no encontrado" que
// ya se verificaron a mano en el player (Vimeus por CORS directo desde el
// cliente; FlixLatam/PelisPlus/RepelisHD por el worker, que no mandan CORS;
// DiPelis ya tiene su propio endpoint que sirve para esto tal cual).
// Devuelve { tieneFuente, vimeusDisponible } en vez de un solo boolean: el
// home necesita saber puntualmente si Vimeus la tiene (para el distintivo en
// las tarjetas), no solo si ALGUNA fuente la tiene.
// Vimeus indexa de forma mas confiable por TMDB que por IMDB (su propia API
// de catalogo, sincronizarCatalogoVimeus, solo entrega tmdb_id) — se
// confirmo un titulo con IMDB valido que Vimeus SI tiene, pero devuelve 404
// real por imdb= y 200 por tmdb= (Avatar: Aang, El ultimo Maestro Aire). Se
// prueba TMDB primero y, si falla o no hay tmdbId, se cae a IMDB.
//
// "Vimeus Fantasma": a veces la pagina responde 200 (no es un "not found"
// real, asi que el chequeo viejo lo daba por bueno) pero con el titulo
// vacio y sin contenido — matchea el tmdb_id contra algo que no tiene video
// cargado (caso real: "Jose Jose: El Principe de la Cancion", tmdb 76541;
// tambien visto con title:"" en vez de null — "Black Torch", tmdb 285993 —
// asi que se chequea con !title, no solo !== null).
// Se detecta leyendo el `<script id="data">` que Vimeus manda server-side
// (sin ejecutar su JS): title vacio, o seasons/embeds vacios = fantasma.
// Un embed de Vimeus puede "existir" (el JSON no viene vacío) pero apuntar a
// un host de video de terceros que lleva años caído -- confirmado con
// Friends T1E1: Vimeus lista un embed en fembed.com, pero fembed.com hoy es
// solo una pagina "Redirecting..." con detector de adblock, sin reproductor
// real detras. El chequeo de "tiene embeds" por sí solo no lo detecta. Si
// este chequeo en sí falla (host lento, worker caído), no se penaliza al
// título por un hipo nuestro -- se asume vivo.
async function embedDeVimeusEstaMuerto(embedUrl) {
    if (!embedUrl) return false;
    try {
        const r = await fetch(`${SelvaStream.MASTER_WORKER_URL}/flix/check-embed?url=${encodeURIComponent(embedUrl)}`, {
            headers: { 'x-selva-auth': SelvaStream.AUTH_TOKEN }
        });
        const d = await r.json();
        return !!d.muerto;
    } catch (e) { return false; }
}

async function vimeusEstadoTitulo(tmdbId, imdbId, tipo) {
    // Para series/anime, sin especificar episodio Vimeus solo devuelve la
    // lista de temporadas -- el JSON nunca trae `embeds`, así que el chequeo
    // de contenido vacío no puede pescar nada ahí. Se pide T1E1 (mismo
    // default que usa la previsualización del admin) para que sí venga.
    const esSerie = tipo !== 'movie';
    const epParams = esSerie ? '&se=1&ep=1' : '';
    const build = (idParam) => `https://vimeus.com/e/${tipo}?${idParam}${epParams}&view_key=${SelvaStream.VIMEUS_VIEW_KEY}`;

    // Un intento suelto. Distingue "Vimeus respondió y dijo que no" (texto
    // "not found" con 200 — negativo real, no hace falta reintentar) de
    // "el pedido en sí falló" (fetch tiró excepción, o un status no-2xx tipo
    // 503 por sobrecarga momentánea — un hipo de red, no una respuesta real
    // de Vimeus). Sin esta distinción, un solo hipo pasajero durante la
    // auditoría marcaba para siempre "Sin Vimeus" a un título que sí lo
    // tiene (caso real: Rick y Morty — reproducía bien a mano, pero el
    // audit lo había marcado como no disponible).
    const intentar = async (idParam) => {
        try {
            const r = await fetch(build(idParam));
            if (!r.ok) return { resultado: 'no-match', transitorio: true };
            const html = await r.text();
            if (/not found/i.test(html)) return { resultado: 'no-match', transitorio: false };
            const m = html.match(/<script type="text\/json" id="data">([\s\S]*?)<\/script>/);
            if (!m) return { resultado: 'no-match', transitorio: false };
            const data = JSON.parse(m[1]);
            const sinContenido = !data.title
                || (Array.isArray(data.seasons) && data.seasons.length === 0)
                || (Array.isArray(data.embeds) && data.embeds.length === 0);
            if (sinContenido) return { resultado: 'fantasma', transitorio: false };

            if (await embedDeVimeusEstaMuerto(data.embeds?.[0]?.url)) {
                return { resultado: 'fantasma', transitorio: false };
            }
            return { resultado: 'ok', transitorio: false };
        } catch (e) { return { resultado: 'no-match', transitorio: true }; }
    };

    const probar = async (idParam) => {
        for (let intento = 1; intento <= 3; intento++) {
            const { resultado, transitorio } = await intentar(idParam);
            if (resultado !== 'no-match' || !transitorio) return resultado;
            if (intento < 3) await new Promise(r => setTimeout(r, 800));
        }
        return 'no-match';
    };

    if (tmdbId) {
        const estado = await probar(`tmdb=${tmdbId}`);
        if (estado !== 'no-match') return estado;
    }
    if (imdbId) return probar(`imdb=${imdbId}`);
    return 'no-match';
}

// Compat: varias llamadas viejas solo necesitan el boolean.
async function vimeusTieneTitulo(tmdbId, imdbId, tipo) {
    return (await vimeusEstadoTitulo(tmdbId, imdbId, tipo)) === 'ok';
}

async function tieneAlgunaFuente(m) {
    const isTv = ['series', 'tv', 'anime'].includes(m.type);
    const imdbId = m.imdbId;
    const tmdbId = m.tmdbId;
    if (!imdbId && !tmdbId) return { tieneFuente: false, vimeusDisponible: false, vimeusFantasma: false };

    const slug = m.title ? m.title.toString().toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s-]/g, "").trim()
        .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") : "";

    let vimeusEstadoPromise = Promise.resolve('no-match');
    if (imdbId || tmdbId) {
        const tipo = m.type === 'anime' ? 'anime' : (isTv ? 'serie' : 'movie');
        vimeusEstadoPromise = vimeusEstadoTitulo(tmdbId, imdbId, tipo);
    }

    const checks = [vimeusEstadoPromise];

    const workerCheck = (params) => fetch(`${SelvaStream.MASTER_WORKER_URL}/flix/check?${params}`, {
        headers: { 'x-selva-auth': SelvaStream.AUTH_TOKEN }
    }).then(r => r.json()).then(d => !!d.available).catch(() => false);

    if (imdbId) {
        checks.push(workerCheck(`provider=flixlatam&imdb=${imdbId}`));
        // PelisMart es espejo de FlixLatam (mismo backend EMBED69) pero puede tener
        // catálogo distinto — el reproductor real y "Revisar Enlaces" ya lo chequean,
        // acá faltaba: la auditoría marcaba "Sin Fuentes" títulos que sí tenían PelisMart.
        checks.push(workerCheck(`provider=pelismart&imdb=${imdbId}`));
        if (!isTv) checks.push(workerCheck(`provider=repelishd&imdb=${imdbId}`));
    }
    if (slug) {
        checks.push(workerCheck(`provider=pelisplus&slug=${encodeURIComponent(slug)}&tmdb=${tmdbId || ''}`));
        if (!isTv) {
            checks.push(fetch(`${SelvaStream.MASTER_WORKER_URL}/flix/dipelis?slug=${encodeURIComponent(slug)}`, {
                headers: { 'x-selva-auth': SelvaStream.AUTH_TOKEN }
            }).then(r => r.json()).then(d => !!d.url).catch(() => false));
        }
    }

    const [vimeusEstado, ...resto] = await Promise.all(checks);
    const vimeusDisponible = vimeusEstado === 'ok';
    const vimeusFantasma = vimeusEstado === 'fantasma';
    return { tieneFuente: vimeusDisponible || resto.some(Boolean), vimeusDisponible, vimeusFantasma };
}

// Auditoría completa del catálogo: revisa cada título contra las 5 fuentes.
// - Sin ninguna fuente + título en chino/japonés (siembra vieja sin arreglar)
//   → se BORRA (a pedido: un título ilegible y sin video no sirve de nada).
// - Sin ninguna fuente, título normal → se marca status:'broken' (ya existe
//   el campo, las tarjetas ya muestran "Sin Fuentes" para esto — no hace
//   falta inventar nada nuevo, y no se borra nada de por sí: un sitio caído
//   momentáneamente no es un título muerto para siempre).
// - Con alguna fuente + título en chino/japonés → se intenta traducir con
//   rescatarTituloLatino (misma lógica que cleanupCJKTitles).
// Dos confirm(): uno antes de arrancar (avisa que tarda) y otro con los
// números exactos antes de tocar la base de datos.
//
// Tarda varios minutos (215 títulos × hasta 5 fuentes cada uno). Si el
// navegador manda la pestaña a segundo plano (Memory Saver de Chrome, o el
// SO al cambiar de app en el celular) puede matar el script a mitad de
// camino sin avisar — todo lo que solo vivía en memoria se perdía en
// silencio: se volvía y no había resumen, ni cambios, ni rastro de que
// corrió. Por eso el progreso se guarda en localStorage en cada título:
// si se corta, la próxima vez que se abra "Auditar Vimeus" se puede
// retomar donde quedó en vez de arrancar de cero.
const AUDIT_PROGRESS_KEY = 'selvaflix_audit_progress';
function guardarProgresoAuditoria(data) {
    try { localStorage.setItem(AUDIT_PROGRESS_KEY, JSON.stringify({ ...data, savedAt: Date.now() })); } catch (e) { /* localStorage lleno o bloqueado: no es crítico, se sigue sin checkpoint */ }
}
function cargarProgresoAuditoria() {
    try {
        const raw = localStorage.getItem(AUDIT_PROGRESS_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}
function borrarProgresoAuditoria() {
    try { localStorage.removeItem(AUDIT_PROGRESS_KEY); } catch (e) { /* no-op */ }
}

// Reemplaza el confirm() nativo del navegador (gris, sin estilo, "sale de otro
// sistema" — a pedido) por un modal con la misma estética que ya usa el resto
// del admin (overlay oscuro + tarjeta #111 + acento var(--primary), igual que
// #delete-progress-overlay). Devuelve una Promise<boolean> para poder seguir
// usando `if (await mostrarConfirmBonito(...))` en vez de `if (confirm(...))`.
function mostrarConfirmBonito({ titulo, mensaje, textoOk = 'Continuar', textoCancelar = 'Cancelar', tipo = 'info' }) {
    return new Promise((resolve) => {
        const acento = tipo === 'danger' ? '#FF5252' : 'var(--primary)';
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:10020; display:flex; align-items:center; justify-content:center; padding:20px;';
        overlay.innerHTML = `
          <div style="width:min(480px, 92vw); max-height:85vh; overflow:auto; background:#111; padding:26px; border-radius:15px; border:1px solid var(--glass-border); box-shadow:0 20px 60px rgba(0,0,0,0.6); font-family:'Outfit', sans-serif;">
            <h3 style="color:white; margin:0 0 14px; font-size:1.05rem;">${titulo}</h3>
            <div style="color:rgba(255,255,255,0.85); font-size:0.88rem; line-height:1.65; white-space:pre-line;">${mensaje}</div>
            <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:22px;">
              <button data-accion="cancelar" style="padding:9px 18px; border-radius:8px; border:1px solid var(--glass-border); background:transparent; color:#ccc; cursor:pointer; font-family:inherit; font-size:0.85rem;">${textoCancelar}</button>
              <button data-accion="ok" style="padding:9px 18px; border-radius:8px; border:none; background:${acento}; color:#111; font-weight:600; cursor:pointer; font-family:inherit; font-size:0.85rem;">${textoOk}</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        const cerrar = (resultado) => { overlay.remove(); resolve(resultado); };
        overlay.querySelector('[data-accion="cancelar"]').onclick = () => cerrar(false);
        overlay.querySelector('[data-accion="ok"]').onclick = () => cerrar(true);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrar(false); });
    });
}

window.auditarCatalogoCompleto = async () => {
    const buscarPorId = (id) => movieDatabase.trending.find(m => m.id === id);

    let totalOrdenado = movieDatabase.trending.filter(m => m.imdbId || m.tmdbId);
    if (totalOrdenado.length === 0) {
        if (window.showToast) window.showToast('No hay títulos con imdbId/tmdbId para auditar.', 'info');
        return;
    }

    let startIndex = 0;
    let paraBorrar = [];
    let paraMarcarRoto = [];
    let paraArreglarTitulo = [];
    let paraActualizarVimeus = []; // { m, vimeusDisponible, vimeusFantasma } -- se guarda siempre que cambió algo
    let fantasmasEncontrados = 0;
    let fallosDeTitulo = 0;
    let yaTerminadaPendienteDeConfirmar = false;

    const progreso = cargarProgresoAuditoria();
    if (progreso && Array.isArray(progreso.ids) && progreso.ids.length) {
        const minutos = Math.max(1, Math.round((Date.now() - progreso.savedAt) / 60000));
        const titulo = progreso.done ? '📋 Auditoría pendiente de confirmar' : '🔄 Auditoría interrumpida';
        const mensaje = progreso.done
            ? `Ya había terminado de revisar todo (guardada hace ${minutos} min) pero se quedó sin confirmar los cambios.\n\nCancelar para descartarla y empezar de cero.`
            : `Se cortó al ${Math.round((progreso.index / progreso.ids.length) * 100)}% (${progreso.index}/${progreso.ids.length}), guardada hace ${minutos} min — probablemente por cambiar de pestaña/app.\n\nCancelar para empezar una auditoría nueva desde cero (se descarta el progreso guardado).`;

        if (await mostrarConfirmBonito({ titulo, mensaje, textoOk: progreso.done ? 'Ver resumen' : 'Retomar', textoCancelar: 'Empezar de cero' })) {
            totalOrdenado = progreso.ids.map(buscarPorId).filter(Boolean);
            startIndex = progreso.done ? totalOrdenado.length : Math.min(progreso.index, totalOrdenado.length);
            paraBorrar = progreso.paraBorrar.map(buscarPorId).filter(Boolean);
            paraMarcarRoto = progreso.paraMarcarRoto.map(buscarPorId).filter(Boolean);
            paraArreglarTitulo = progreso.paraArreglarTitulo.map(buscarPorId).filter(Boolean);
            paraActualizarVimeus = progreso.paraActualizarVimeus
                .map(({ id, vimeusDisponible, vimeusFantasma }) => { const m = buscarPorId(id); return m ? { m, vimeusDisponible, vimeusFantasma } : null; })
                .filter(Boolean);
            fantasmasEncontrados = progreso.fantasmasEncontrados || 0;
            fallosDeTitulo = progreso.fallosDeTitulo || 0;
            yaTerminadaPendienteDeConfirmar = !!progreso.done;
        } else {
            borrarProgresoAuditoria();
        }
    }

    if (startIndex === 0 && !yaTerminadaPendienteDeConfirmar) {
        const arrancar = await mostrarConfirmBonito({
            titulo: '👻 Auditar Vimeus y demás fuentes',
            mensaje: `Esto va a revisar ${totalOrdenado.length} títulos contra las 5 fuentes (puede tardar varios minutos, hay una pausa chica entre cada uno para no saturar los sitios).\n\nNo cambies de pestaña ni de app mientras corre — si el navegador la manda a segundo plano puede cortarse (igual queda guardado el progreso para retomar).`,
            textoOk: 'Auditar'
        });
        if (!arrancar) return;
    }

    // Misma barra de progreso que usa "Revisar Enlaces" (runBotHealthCheck):
    // sin esto la auditoría corría en silencio varios minutos y parecía
    // trabada / que no hacía nada.
    const overlay = document.getElementById('delete-progress-overlay');
    const bar = document.getElementById('progress-bar-fill');
    const percentText = document.getElementById('progress-percent');
    const statusText = document.getElementById('progress-text');

    if (!yaTerminadaPendienteDeConfirmar) {
        if (statusText) statusText.innerText = '👻 Auditando Vimeus y demás fuentes... 🔎🌴';
        if (overlay) overlay.style.display = 'flex';

        for (let i = startIndex; i < totalOrdenado.length; i++) {
            const m = totalOrdenado[i];
            console.log(`🔎 [${i + 1}/${totalOrdenado.length}] Revisando: ${m.title}`);

            // Si UN título falla de forma rara (ej. la laptop se suspende a
            // mitad de la auditoría, o el navegador pausa la pestaña en segundo
            // plano y algún fetch queda en un estado raro al despertar), esto
            // evita que se corte TODO el proceso en silencio sin llegar nunca al
            // resumen final — reportado como "dejé la laptop sola auditando y
            // al volver no había pasado nada, ni el popup de confirmar cambios".
            // Se saltea ese título (queda como estaba) y se sigue con el resto.
            let resultado;
            try {
                resultado = await tieneAlgunaFuente(m);
            } catch (e) {
                console.error(`❌ Falló el chequeo de "${m.title}", se saltea:`, e);
                fallosDeTitulo++;
                const percent = Math.round(((i + 1) / totalOrdenado.length) * 100);
                if (bar) bar.style.width = `${percent}%`;
                if (percentText) percentText.innerText = `${percent}% (${i + 1}/${totalOrdenado.length}) — ${m.title} (falló, saltado)`;
                guardarProgresoAuditoria({
                    ids: totalOrdenado.map(x => x.id), index: i + 1,
                    paraBorrar: paraBorrar.map(x => x.id), paraMarcarRoto: paraMarcarRoto.map(x => x.id),
                    paraArreglarTitulo: paraArreglarTitulo.map(x => x.id),
                    paraActualizarVimeus: paraActualizarVimeus.map(({ m: x, vimeusDisponible, vimeusFantasma }) => ({ id: x.id, vimeusDisponible, vimeusFantasma })),
                    fantasmasEncontrados, fallosDeTitulo, done: false
                });
                await new Promise(r => setTimeout(r, 400));
                continue;
            }
            const { tieneFuente, vimeusDisponible, vimeusFantasma } = resultado;
            const esCJK = m.title && CJK_REGEX.test(m.title);

            if (esCJK) {
                if (tieneFuente) paraArreglarTitulo.push(m);
                else paraBorrar.push(m);
            } else if (!tieneFuente && m.status !== 'broken') {
                paraMarcarRoto.push(m);
            }

            if (vimeusFantasma) {
                fantasmasEncontrados++;
                console.warn(`👻 Vimeus Fantasma (matchea pero sin contenido): ${m.title}`);
            }

            // El distintivo del home lee esto; se guarda para todos, no solo los
            // que ya iban a cambiar de status, porque puede cambiar sin que el
            // resto del título cambie (ej. Vimeus suma un titulo que ya tenia otra fuente).
            if (m.vimeusDisponible !== vimeusDisponible || m.vimeusFantasma !== vimeusFantasma) {
                paraActualizarVimeus.push({ m, vimeusDisponible, vimeusFantasma });
            }

            const percent = Math.round(((i + 1) / totalOrdenado.length) * 100);
            if (bar) bar.style.width = `${percent}%`;
            if (percentText) percentText.innerText = `${percent}% (${i + 1}/${totalOrdenado.length}) — ${m.title}`;

            guardarProgresoAuditoria({
                ids: totalOrdenado.map(x => x.id), index: i + 1,
                paraBorrar: paraBorrar.map(x => x.id), paraMarcarRoto: paraMarcarRoto.map(x => x.id),
                paraArreglarTitulo: paraArreglarTitulo.map(x => x.id),
                paraActualizarVimeus: paraActualizarVimeus.map(({ m: x, vimeusDisponible, vimeusFantasma }) => ({ id: x.id, vimeusDisponible, vimeusFantasma })),
                fantasmasEncontrados, fallosDeTitulo, done: false
            });

            await new Promise(r => setTimeout(r, 400)); // no bombardear los sitios de golpe
        }

        if (overlay) overlay.style.display = 'none';

        // Se marca "done" ANTES del confirm final: si la pestaña se corta justo
        // acá (esperando que el confirm() nativo del navegador vuelva a foco),
        // la próxima vez se salta directo al resumen en vez de re-escanear todo.
        guardarProgresoAuditoria({
            ids: totalOrdenado.map(x => x.id), index: totalOrdenado.length,
            paraBorrar: paraBorrar.map(x => x.id), paraMarcarRoto: paraMarcarRoto.map(x => x.id),
            paraArreglarTitulo: paraArreglarTitulo.map(x => x.id),
            paraActualizarVimeus: paraActualizarVimeus.map(({ m: x, vimeusDisponible, vimeusFantasma }) => ({ id: x.id, vimeusDisponible, vimeusFantasma })),
            fantasmasEncontrados, fallosDeTitulo, done: true
        });
    }

    const resumen = `Resultado de la auditoría:\n\n`
        + `🗑️ ${paraBorrar.length} sin fuente y con título en chino/japonés → se BORRAN\n`
        + `🔴 ${paraMarcarRoto.length} sin ninguna fuente → se marcan "Sin Fuentes"\n`
        + `✏️ ${paraArreglarTitulo.length} con título chino/japonés pero SÍ tienen fuente → se traduce el título\n`
        + `👻 ${fantasmasEncontrados} "Vimeus Fantasma" (matchean por ID pero sin contenido real) → filtrables en Catálogo como "Vimeus Fantasma"\n`
        + `🎬 ${paraActualizarVimeus.length} título(s) cambian su distintivo de Vimeus (para el home y el filtro)\n`
        + (fallosDeTitulo > 0 ? `⚠️ ${fallosDeTitulo} título(s) no se pudieron chequear (fallo de red) y quedaron como estaban — se pueden reintentar corriendo la auditoría de nuevo.\n` : '');

    const aplicar = await mostrarConfirmBonito({
        titulo: '✅ Resultado de la auditoría',
        mensaje: resumen + '\n¿Aplicar estos cambios?',
        textoOk: 'Aplicar cambios',
        tipo: paraBorrar.length > 0 ? 'danger' : 'info'
    });
    if (!aplicar) {
        if (window.showToast) window.showToast('Auditoría cancelada, no se aplicó ningún cambio.', 'info');
        borrarProgresoAuditoria();
        return { paraBorrar, paraMarcarRoto, paraArreglarTitulo };
    }

    // Los catch de abajo antes solo hacían console.error: si Firestore rechazaba
    // un updateDoc puntual (doc borrado por otra vía, regla de permisos, etc.)
    // el título se quedaba "Sin Verificar"/roto para siempre sin que nadie se
    // enterara — reportado como "sigo viendo que muchos quedan sin verificar".
    // Ahora se juntan los fallos y salen en el mensaje final para poder
    // identificar cuáles son y por qué.
    const fallosAplicar = [];

    let borrados = 0, marcados = 0, arreglados = 0;

    for (const m of paraBorrar) {
        try {
            await deleteDoc(doc(db, "movies", m.id));
            movieDatabase.trending = movieDatabase.trending.filter(x => x.id !== m.id);
            console.log(`🗑️ Borrado (sin fuente + CJK): ${m.title}`);
            borrados++;
        } catch (e) { console.error('Error borrando', m.title, e); fallosAplicar.push(`${m.title} (borrar: ${e.message || e})`); }
    }

    for (const m of paraMarcarRoto) {
        try {
            await updateDoc(doc(db, "movies", m.id), { status: 'broken' });
            m.status = 'broken';
            console.log(`🔴 Marcado sin fuentes: ${m.title}`);
            marcados++;
        } catch (e) { console.error('Error marcando', m.title, e); fallosAplicar.push(`${m.title} (marcar: ${e.message || e})`); }
    }

    for (const m of paraArreglarTitulo) {
        try {
            const endpoint = ['series', 'tv', 'anime'].includes(m.type) ? 'tv' : 'movie';
            const newTitle = await rescatarTituloLatino(m.title, endpoint, m.tmdbId);
            if (newTitle && newTitle !== m.title) {
                await updateDoc(doc(db, "movies", m.id), { title: newTitle });
                console.log(`✅ "${m.title}" → "${newTitle}"`);
                m.title = newTitle;
                arreglados++;
            }
        } catch (e) { console.error('Error arreglando título', m.title, e); fallosAplicar.push(`${m.title} (traducir título: ${e.message || e})`); }
    }

    let vimeusActualizados = 0;
    for (const { m, vimeusDisponible, vimeusFantasma } of paraActualizarVimeus) {
        try {
            await updateDoc(doc(db, "movies", m.id), { vimeusDisponible, vimeusFantasma });
            m.vimeusDisponible = vimeusDisponible;
            m.vimeusFantasma = vimeusFantasma;
            vimeusActualizados++;
        } catch (e) { console.error('Error actualizando vimeusDisponible', m.title, e); fallosAplicar.push(`${m.title} (distintivo Vimeus: ${e.message || e})`); }
    }

    localStorage.removeItem('selvaflix_full_database');
    localStorage.removeItem('selvaflix_cache_timestamp');
    // Sin condicionar a "¿admin-view está en display:block ahora mismo?":
    // ese chequeo podía fallar (otra sub-pestaña, timing) y entonces
    // _allInventoryItems se quedaba con los datos de ANTES de auditar —
    // ni cambiando el filtro a mano aparecía nada, porque la lista en
    // memoria nunca se refrescó. renderInventory() es barata igual.
    if (document.getElementById('admin-catalog-table-body')) renderInventory();

    // A pedido: sin esto había que ir a mano al filtro "Salud" y elegir
    // "Vimeus Fantasma" — no quedaba claro dónde ver el resultado de la
    // auditoría. Si encontró Fantasmas, los deja filtrados de una; si no
    // hubo Fantasmas pero sí "Sin Vimeus", filtra esos en su lugar.
    const filtroSalud = document.getElementById('inventory-filter');
    if (filtroSalud) {
        if (fantasmasEncontrados > 0) filtroSalud.value = 'vimeus-fantasma';
        else if (vimeusActualizados > fantasmasEncontrados) filtroSalud.value = 'no-vimeus';
        if (window.filterInventoryByCategory) window.filterInventoryByCategory();
    }

    const msg = `✅ Auditoría completa: ${borrados} borrados, ${marcados} marcados sin fuentes, ${arreglados} títulos traducidos, ${vimeusActualizados} distintivos de Vimeus actualizados (${fantasmasEncontrados} Vimeus Fantasma). Filtro "Salud" ya te muestra el resultado.`;
    console.log(msg);

    if (fallosAplicar.length > 0) {
        console.error(`⚠️ ${fallosAplicar.length} título(s) no se pudieron guardar en la base:`, fallosAplicar);
        await mostrarConfirmBonito({
            titulo: '⚠️ Algunos cambios no se guardaron',
            mensaje: `${msg}\n\nPero ${fallosAplicar.length} título(s) fallaron al guardar en la base (por eso pueden seguir viéndose "Sin Verificar" o sin actualizar):\n\n${fallosAplicar.join('\n')}\n\nSe pueden reintentar corriendo la auditoría de nuevo.`,
            textoOk: 'Entendido', textoCancelar: 'Cerrar', tipo: 'danger'
        });
        if (window.showToast) window.showToast(`⚠️ Auditoría completa con ${fallosAplicar.length} error(es) al guardar — ver detalle.`, 'warning');
    } else {
        if (window.showToast) window.showToast(msg, 'success');
    }

    borrarProgresoAuditoria();
    return { borrados, marcados, arreglados, vimeusActualizados, fantasmasEncontrados, fallosAplicar };
};

// Trae el catálogo que Vimeus YA tiene confirmado (via su API Key, server-only
// por el worker — ver /flix/vimeus-catalog) y agrega a SelvaFlix lo que todavía
// no esté, en vez de cargar títulos a mano y descubrir después si tienen
// fuente o no: estos nacen "garantizados" con al menos Vimeus funcionando.
//
// Uso: sincronizarCatalogoVimeus() trae los 3 tipos. Si el catálogo de Vimeus
// es grande (puede ser miles de títulos, varias páginas cada uno), conviene
// probar de a uno: sincronizarCatalogoVimeus(['movies']) primero.
window.sincronizarCatalogoVimeus = async (tipos = ['movies', 'series', 'animes']) => {
    // La respuesta real de Vimeus NO es la que muestra su propia
    // documentación (esa describía data.movies/data.series/data.animes +
    // data.pagination.total_pages, con id/content_type/imdb_id/synced_at).
    // Comprobado a mano: viene siempre en data.result (mismo nombre sin
    // importar el tipo pedido) + data.pages (número plano, no un objeto de
    // paginación), sin imdb_id, y con un embed_url ya armado con el
    // view_key correcto. Se usa esta forma real, no la de la doc.
    const nuevos = [];

    for (const tipo of tipos) {
        let page = 1;
        let totalPages = 1;
        do {
            console.log(`📚 Vimeus ${tipo} — página ${page}${totalPages > 1 ? `/${totalPages}` : ''}`);
            let data;
            try {
                const res = await fetch(`${SelvaStream.MASTER_WORKER_URL}/flix/vimeus-catalog?type=${tipo}&page=${page}`, {
                    headers: { 'x-selva-auth': SelvaStream.AUTH_TOKEN }
                });
                data = await res.json();
            } catch (e) {
                console.error(`Error pidiendo página ${page} de ${tipo}:`, e);
                break;
            }
            if (data.error || !data.data) {
                console.error(`Vimeus catalog (${tipo}) devolvió error:`, data);
                break;
            }

            const items = data.data.result || [];
            totalPages = data.data.pages || 1;

            for (const it of items) {
                if (!it.tmdb_id) continue; // sin tmdb_id no hay con qué buscar detalles ni deduplicar
                const yaExiste = movieDatabase.trending.some(m => String(m.tmdbId) === String(it.tmdb_id));
                if (!yaExiste) nuevos.push({ ...it, _tipoLocal: tipo });
            }

            page++;
            await new Promise(r => setTimeout(r, 300)); // no bombardear el worker/Vimeus de golpe
        } while (page <= totalPages);
    }

    if (nuevos.length === 0) {
        if (window.showToast) window.showToast('El catálogo ya tiene todo lo que Vimeus ofrece. 🎉', 'info');
        return { agregados: 0 };
    }

    if (!confirm(`Vimeus tiene ${nuevos.length} título(s) que todavía no están en tu catálogo. Se van a agregar con detalles de TMDB (título, póster, género, año). ¿Continuar?`)) {
        if (window.showToast) window.showToast('Sincronización cancelada, no se agregó nada.', 'info');
        return { agregados: 0, pendientes: nuevos.length };
    }

    let agregados = 0, fallidos = 0;
    for (let i = 0; i < nuevos.length; i++) {
        const it = nuevos[i];
        console.log(`➕ [${i + 1}/${nuevos.length}] Agregando: ${it.title}`);
        try {
            // La API de Vimeus no manda content_type ni imdb_id (a diferencia
            // de lo que decía su doc) — el tipo real sale de qué endpoint se
            // pidió (_tipoLocal), y el imdbId hay que sacarlo aparte de TMDB
            // (external_ids), si se necesita para las otras fuentes (FlixLatam,
            // RepelisHD) que sí lo piden.
            const esSerie = it._tipoLocal === 'series' || it._tipoLocal === 'animes';
            const tipoTMDB = esSerie ? 'tv' : 'movie';
            const [detailsRes, extIdsRes] = await Promise.all([
                fetch(`${TMDB_URL}/${tipoTMDB}/${it.tmdb_id}?api_key=${TMDB_API_KEY}&language=es-MX`),
                fetch(`${TMDB_URL}/${tipoTMDB}/${it.tmdb_id}/external_ids?api_key=${TMDB_API_KEY}`)
            ]);
            const details = await detailsRes.json();
            const extIds = await extIdsRes.json();

            const nuevoDoc = {
                title: details.title || details.name || it.title,
                tmdbId: String(it.tmdb_id),
                imdbId: extIds.imdb_id || '',
                type: it._tipoLocal === 'animes' ? 'anime' : (it._tipoLocal === 'series' ? 'series' : 'movie'),
                img: (details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : (it.poster ? `https://image.tmdb.org/t/p/w500${it.poster}` : '')),
                backdrop: details.backdrop_path ? `https://image.tmdb.org/t/p/original${details.backdrop_path}` : (it.backdrop ? `https://image.tmdb.org/t/p/original${it.backdrop}` : ''),
                genres: (details.genres || []).map(g => String(g.id)),
                rating: details.vote_average ? details.vote_average.toFixed(1) : '',
                year: (details.release_date || details.first_air_date || '').slice(0, 4),
                original_title: details.original_title || details.original_name || '',
                lang: 'es-MX',
                status: 'healthy',
                embed: ''
            };

            const docRef = await addDoc(collection(db, "movies"), { ...nuevoDoc, createdAt: Date.now() });
            // El listener en vivo de loadSelvaFlixData() (onSnapshot) suele
            // enterarse de esta misma escritura (aunque sea local/optimista)
            // antes de que lleguemos a esta línea, y ya la empuja a trending
            // por su cuenta. Empujar de nuevo sin chequear generaba una fila
            // duplicada en la tabla del admin (mismo ID, dos objetos) hasta
            // el próximo reload — se chequea primero, igual que hace el
            // propio handler del listener.
            const idxYaEmpujado = movieDatabase.trending.findIndex(m => m.id === docRef.id);
            if (idxYaEmpujado === -1) movieDatabase.trending.push({ id: docRef.id, ...nuevoDoc });
            else movieDatabase.trending[idxYaEmpujado] = { id: docRef.id, ...nuevoDoc };
            agregados++;
        } catch (e) {
            console.error('Error agregando título de Vimeus:', it.title, e);
            fallidos++;
        }
        await new Promise(r => setTimeout(r, 300));
    }

    localStorage.removeItem('selvaflix_full_database');
    localStorage.removeItem('selvaflix_cache_timestamp');
    if (document.getElementById('admin-view')?.style.display === 'block') renderInventory();

    const msg = `✅ Sincronización completa: ${agregados} título(s) agregados desde Vimeus${fallidos ? `, ${fallidos} fallaron` : ''}.`;
    console.log(msg);
    if (window.showToast) window.showToast(msg, 'success');

    return { agregados, fallidos, total: nuevos.length };
};

// Encadena sincronizarCatalogoVimeus() + auditarCatalogoCompleto() para que
// los títulos nuevos no se queden mostrando "❔ Sin Verificar" en la home
// hasta que alguien se acuerde de auditar a mano. Cada paso conserva sus
// propios confirm() (uno pregunta antes de agregar, el otro antes de
// borrar/marcar), así que sigue pudiéndose cancelar en el medio sin que
// se toque nada.
window.sincronizarYAuditarVimeus = async (tipos = ['movies', 'series', 'animes']) => {
    if (window.showToast) window.showToast('📚 Paso 1/2: sincronizando catálogo de Vimeus...', 'info');
    const resultadoSync = await window.sincronizarCatalogoVimeus(tipos);

    if (window.showToast) window.showToast('👻 Paso 2/2: auditando catálogo completo...', 'info');
    const resultadoAudit = await window.auditarCatalogoCompleto();

    return { sync: resultadoSync, audit: resultadoAudit };
};

// Migración de una sola vez: copia el catálogo actual de Firestore a la tabla
// "movies" de Supabase, con los mismos IDs (para no romper Mi Lista/Continuar
// Viendo de los usuarios, que guardan ese ID). No borra ni toca nada en
// Firestore — es una copia. Usa upsert, así que se puede volver a correr sin
// duplicar nada si se corta a la mitad.
window.migrarCatalogoASupabase = async () => {
  if (!confirm('📦 MIGRAR CATÁLOGO A SUPABASE:\nVoy a leer todo el catálogo actual de Firestore y copiarlo a la tabla "movies" de Supabase, con los mismos IDs. No borra ni modifica nada en Firestore.\n\n¿Continuar? 📦🌴')) return;

  const overlay = document.getElementById('delete-progress-overlay');
  const bar = document.getElementById('progress-bar-fill');
  const text = document.getElementById('progress-percent');
  const statusText = document.getElementById('progress-text');
  if (statusText) statusText.innerText = 'Migrando catálogo a Supabase... 📦';
  if (overlay) overlay.style.display = 'flex';

  let docs = [];
  try {
    const snap = await getDocs(fsCollection(db, 'movies'));
    docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    if (overlay) overlay.style.display = 'none';
    alert('❌ No se pudo leer el catálogo de Firestore: ' + (e.message || e));
    return;
  }

  let migrados = 0, fallidos = 0;
  const errores = [];
  for (let i = 0; i < docs.length; i++) {
    const m = docs[i];
    try {
      const row = movieToSupaRow(m);
      row.id = m.id;
      const { error } = await supabase.from('movies').upsert(row);
      if (error) throw error;
      migrados++;
    } catch (e) {
      console.error('Error migrando', m.title, e);
      fallidos++;
      errores.push(`${m.title || m.id}: ${e.message || e}`);
    }

    const percent = Math.round(((i + 1) / docs.length) * 100);
    if (bar) bar.style.width = `${percent}%`;
    if (text) text.innerText = `${percent}% (${i + 1}/${docs.length})`;
  }

  if (overlay) overlay.style.display = 'none';
  alert(`📦 MIGRACIÓN COMPLETA:\n- Total en Firestore: ${docs.length}\n- Migrados a Supabase: ${migrados}\n- Fallidos: ${fallidos}${errores.length ? '\n\n' + errores.slice(0, 5).join('\n') : ''}`);
};

// --- Panel de Usuarios: cuentas reales + logins + dispositivos (v2.45) ---
window.loadRegisteredUsers = async () => {
    const tableBody = document.getElementById('admin-users-table-body');
    const countEl = document.getElementById('admin-users-count');
    if (!tableBody) return;

    tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px;">Cargando usuarios... 📡</td></tr>`;

    try {
        // 1. Cuentas (documento de "users" con email = cuenta real, no suscriptor anónimo de push)
        const usersSnap = await getDocs(collection(db, "users"));
        const accounts = [];
        usersSnap.forEach(d => {
            const data = d.data();
            if (data.email) accounts.push({ uid: d.id, ...data });
        });

        // 2. Logins agrupados por uid — lo hace Postgres (login_stats_by_uid),
        // no un loop en el navegador sobre miles de filas como antes.
        const loginsByUid = {};
        const { data: loginStats } = await supabase.rpc('login_stats_by_uid');
        (loginStats || []).forEach(row => {
            loginsByUid[row.uid] = {
                count: Number(row.login_count) || 0,
                platforms: new Set(row.platforms || []),
                last: row.last_login ? Date.parse(row.last_login) : 0
            };
        });
        // quién ya se logueó alguna vez, para no contarlo como "invitado"
        const { data: loggedInVisitors } = await supabase.rpc('logged_in_visitor_ids');
        const visitorIdsConCuenta = new Set((loggedInVisitors || []).map(r => r.visitor_id));

        window.loadVisitorInsights(visitorIdsConCuenta);

        // 3. Quién tiene la app instalada (PWA) ACTUALMENTE — mismo criterio
        // de 30 días que usa el contador "Con App Instalada" de arriba
        // (loadVisitorInsights), para que el badge signifique lo mismo que
        // ese número. Sin este límite de fecha, alguien que instaló y
        // desinstaló hace meses seguía apareciendo como "instalada".
        const desde30diasPwa = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const { data: pwaRows } = await supabase.rpc('pwa_uids_since', { since: new Date(desde30diasPwa).toISOString() });
        const pwaUids = new Set((pwaRows || []).map(r => r.uid));

        if (countEl) countEl.innerText = `${accounts.length} cuenta(s) registrada(s)`;

        if (accounts.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--admin-text-muted);">Nadie se ha registrado con Google todavía. 🐒</td></tr>`;
            return;
        }

        accounts.sort((a, b) => (b.lastLoginAt || 0) - (a.lastLoginAt || 0));

        tableBody.innerHTML = accounts.map(acc => {
            const stats = loginsByUid[acc.uid] || { count: 0, platforms: new Set(), last: acc.lastLoginAt || 0 };
            const devices = Array.from(stats.platforms).join(', ') || '—';
            const tieneAppInstalada = pwaUids.has(acc.uid);
            const registered = acc.createdAt ? new Date(acc.createdAt).toLocaleDateString() : '—';
            const lastSeen = stats.last ? new Date(stats.last).toLocaleString() : '—';
            const avatarLetter = (acc.displayName || acc.email || '?').charAt(0).toUpperCase();
            const safeName = (acc.displayName || acc.email || '').replace(/'/g, "\\'");

            // 💎 Plan efectivo: un premium vencido se trata como free acá también.
            const rawTier = acc.tier || 'free';
            const expired = rawTier === 'premium' && acc.premiumUntil && acc.premiumUntil < Date.now();
            const effTier = expired ? 'free' : rawTier;

            let planCell;
            if (effTier === 'admin') {
                planCell = `<span style="color:#9b59b6; font-weight:800; font-size:0.7rem; white-space:nowrap;">🛡️ Admin</span>`;
            } else if (effTier === 'premium') {
                const untilTxt = acc.premiumUntil ? `hasta ${new Date(acc.premiumUntil).toLocaleDateString()}` : 'sin vencimiento';
                planCell = `
                    <div style="display:flex; flex-direction:column; align-items:center; gap:4px;">
                        <span style="color:#f1c40f; font-weight:800; font-size:0.7rem; white-space:nowrap;">💎 Premium</span>
                        <span style="font-size:0.6rem; color:var(--admin-text-muted); white-space:nowrap;">${untilTxt}</span>
                        <button onclick="window.revokePremium('${acc.uid}', '${safeName}')" style="background:rgba(231,76,60,0.1); border:1px solid rgba(231,76,60,0.3); color:#e74c3c; font-size:0.62rem; font-weight:700; padding:3px 8px; border-radius:6px; cursor:pointer;">Quitar</button>
                    </div>`;
            } else {
                planCell = `<button onclick="window.grantPremium('${acc.uid}', '${safeName}')" style="background:rgba(241,196,15,0.1); border:1px solid rgba(241,196,15,0.3); color:#f1c40f; font-size:0.68rem; font-weight:800; padding:6px 10px; border-radius:6px; cursor:pointer; white-space:nowrap;">⭐ Hacer Premium</button>`;
            }

            return `
                <tr>
                    <td>
                        <div style="display:flex; align-items:center; gap:10px;">
                            ${acc.photoURL
                                ? `<img src="${acc.photoURL}" style="width:32px; height:32px; border-radius:50%; object-fit:cover;">`
                                : `<div style="width:32px; height:32px; border-radius:50%; background:var(--admin-accent-orange); color:#111; display:flex; align-items:center; justify-content:center; font-weight:800;">${avatarLetter}</div>`}
                            <div>
                                <div style="font-weight:700; color:#fff; font-size:0.8rem;">${acc.displayName || 'Sin nombre'}</div>
                                <div style="font-size:0.7rem; color:var(--admin-text-muted);">${acc.email}</div>
                            </div>
                        </div>
                    </td>
                    <td style="font-size:0.78rem;">${registered}</td>
                    <td style="text-align:center; font-weight:800; color:var(--admin-accent-orange);">${stats.count}</td>
                    <td style="font-size:0.75rem;">
                        ${devices}
                        ${tieneAppInstalada ? `<div style="margin-top:3px;"><span title="Entró en modo app instalada (PWA) en los últimos 30 días" style="background:rgba(46,204,113,0.12); color:#2ecc71; font-size:0.62rem; font-weight:700; padding:2px 6px; border-radius:6px; white-space:nowrap;">📲 App instalada</span></div>` : ''}
                    </td>
                    <td style="font-size:0.78rem;">${lastSeen}</td>
                    <td style="text-align:center;">${planCell}</td>
                    <td style="text-align:center;">
                        <div style="display:flex; flex-direction:column; gap:4px; align-items:center;">
                            <button onclick="window.viewAccountProfiles('${acc.uid}', '${safeName}')" style="background:rgba(0,242,255,0.1); border:1px solid rgba(0,242,255,0.3); color:#00f2ff; font-size:0.7rem; font-weight:700; padding:6px 10px; border-radius:6px; cursor:pointer; white-space:nowrap;">
                                👤 Ver Perfiles
                            </button>
                            <button onclick="window.viewAccountSessions('${acc.uid}', '${safeName}')" style="background:rgba(155,89,182,0.1); border:1px solid rgba(155,89,182,0.3); color:#9b59b6; font-size:0.7rem; font-weight:700; padding:6px 10px; border-radius:6px; cursor:pointer; white-space:nowrap;">
                                🕐 Ver Sesiones
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (e) {
        console.error("Error cargando usuarios registrados:", e);
        tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:#E74C3C;">Fallo cargando usuarios: ${e.message}</td></tr>`;
    }
};

// Otorga/renueva Premium a mano (todavía no hay cobro automático: esto es
// lo que usa el admin cuando alguien le escribe por el chat de soporte
// pidiendo un plan). Vencimiento opcional en días; vacío = sin vencer.
window.grantPremium = async (uid, name) => {
    const daysStr = prompt(`¿Por cuántos días será Premium ${name}?\n\nDejá vacío para que no venza nunca.`, '30');
    if (daysStr === null) return; // canceló

    const days = daysStr.trim() === '' ? null : parseInt(daysStr, 10);
    if (days !== null && (isNaN(days) || days <= 0)) {
        if (window.showToast) window.showToast('Ingresá un número de días válido.', 'error');
        return;
    }

    try {
        await updateDoc(doc(db, "users", uid), {
            tier: 'premium',
            premiumUntil: days ? Date.now() + days * 24 * 60 * 60 * 1000 : null,
            premiumGrantedAt: Date.now()
        });
        if (window.showToast) window.showToast(`💎 ${name} ya es Premium.`, 'success');
        window.loadRegisteredUsers();
        if (typeof window.loadPremiumCount === 'function') window.loadPremiumCount();
    } catch (e) {
        console.error('Error otorgando premium:', e);
        if (window.showToast) window.showToast('No se pudo actualizar el plan.', 'error');
    }
};

window.revokePremium = async (uid, name) => {
    if (!confirm(`¿Quitarle Premium a ${name}?`)) return;
    try {
        await updateDoc(doc(db, "users", uid), { tier: 'free', premiumUntil: null });
        if (window.showToast) window.showToast(`${name} vuelve a plan Gratuito.`, 'info');
        window.loadRegisteredUsers();
        if (typeof window.loadPremiumCount === 'function') window.loadPremiumCount();
    } catch (e) {
        console.error('Error quitando premium:', e);
        if (window.showToast) window.showToast('No se pudo actualizar el plan.', 'error');
    }
};

// Conteo de usuarios Premium activos para la tarjeta del Dashboard. Cuenta
// solo tier:'premium' vigente (los admin no suman acá, son otra categoría),
// descontando los que ya vencieron aunque el doc todavía diga 'premium'.
window.loadPremiumCount = async () => {
    const el = document.getElementById('count-premium-users');
    if (!el) return;
    try {
        const snap = await getDocs(query(collection(db, "users"), where("tier", "==", "premium")));
        const now = Date.now();
        let active = 0;
        snap.forEach(d => {
            const data = d.data();
            if (!data.premiumUntil || data.premiumUntil > now) active++;
        });
        el.innerText = active;
    } catch (e) {
        console.warn("No se pudo cargar el conteo de premium:", e);
    }
};

// Filtro en vivo de la tabla de cuentas por nombre o email — solo esconde
// filas ya renderizadas, no vuelve a pegarle a Firestore.
window.filterUsersTable = (queryStr) => {
    const q = (queryStr || '').toLowerCase().trim();
    document.querySelectorAll('#admin-users-table-body tr').forEach(tr => {
        const text = tr.innerText.toLowerCase();
        tr.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
};

// Pills de "Visitantes / Invitados / App instalada" arriba de la tabla de
// cuentas. Se arma con "analytics_geo" (que ya guarda 1 visita por
// dispositivo cada 24h, ver trackUserGeo) — desde que se le agregaron los
// campos visitorId/isPwa se puede separar invitados de cuentas (cruzando
// contra quién ya logueó alguna vez, recibido de loadRegisteredUsers) y
// navegador de PWA instalada. No hay forma de reconstruir esto para visitas
// de antes de ese cambio, así que arranca en 0 y crece desde ahí.
window.loadVisitorInsights = async (visitorIdsConCuenta = new Set()) => {
    const elVisitantes = document.getElementById('ustat-visitantes');
    const elInvitados = document.getElementById('ustat-invitados');
    const elPwa = document.getElementById('ustat-pwa');
    const elCelular = document.getElementById('ustat-celular');
    const elEscritorio = document.getElementById('ustat-escritorio');
    if (!elVisitantes) return;

    try {
        const desde30dias = Date.now() - 30 * 24 * 60 * 60 * 1000;
        // visitor_flags_since ya agrupa por visitante en Postgres (bool_or de
        // is_pwa/is_mobile) — acá solo queda clasificar, no sumar miles de filas.
        const { data: flagRows } = await supabase.rpc('visitor_flags_since', { since: new Date(desde30dias).toISOString() });
        const porVisitante = flagRows || [];

        const ids = porVisitante.map(v => v.visitor_id);
        const invitados = ids.filter(vid => !visitorIdsConCuenta.has(vid)).length;
        const conPwa = porVisitante.filter(v => v.is_pwa).length;
        // "Celular sin instalar" y "Escritorio" son ambos "solo navegador" (no
        // instalaron la app), separados por si entraron desde el celu o la PC —
        // separado de conPwa arriba, que ya cubre "instalada" sin importar el dispositivo.
        const celularSinInstalar = porVisitante.filter(v => !v.is_pwa && v.is_mobile).length;
        const escritorio = porVisitante.filter(v => !v.is_pwa && !v.is_mobile).length;

        elVisitantes.innerText = ids.length;
        if (elInvitados) elInvitados.innerText = invitados;
        if (elPwa) elPwa.innerText = conPwa;
        if (elCelular) elCelular.innerText = celularSinInstalar;
        if (elEscritorio) elEscritorio.innerText = escritorio;
    } catch (e) {
        console.error('Error cargando insights de visitantes:', e);
    }
};

// Soporte: ver los perfiles de una cuenta y poder quitarle el PIN a uno
// puntual sin tocar los demás (caso real: un chico se traba en su perfil
// principal porque olvidó el PIN y termina creando otro perfil sin PIN para
// poder entrar, dejando su historial/favoritos abandonados en el original).
// No se muestra el PIN en texto plano — solo si tiene uno puesto o no.
window.viewAccountProfiles = async (uid, displayName) => {
    const modal = document.getElementById('account-profiles-modal');
    const title = document.getElementById('account-profiles-modal-title');
    const list = document.getElementById('account-profiles-list');
    if (!modal || !list) return;

    if (title) title.textContent = `Perfiles de ${displayName || 'esta cuenta'}`;
    list.innerHTML = '<p style="color:#888; text-align:center; font-size:0.8rem;">Cargando perfiles... 📡</p>';
    modal.style.display = 'flex';

    try {
        const snap = await getDocs(collection(db, "users", uid, "profiles"));
        const profiles = [];
        snap.forEach(d => profiles.push({ id: d.id, ...d.data() }));

        if (profiles.length === 0) {
            list.innerHTML = '<p style="color:#888; text-align:center; font-size:0.8rem;">Esta cuenta no tiene perfiles todavía.</p>';
            return;
        }

        const cantidadPrincipales = profiles.filter(p => p.isPrimary).length;

        list.innerHTML = profiles.map(p => {
            const tienePin = p.pin && p.pin.trim() !== '';
            const nombreEscapado = (p.name || '').replace(/'/g, "\\'");
            return `
                <div style="display:flex; flex-direction:column; gap:8px; padding:10px 12px; background:rgba(255,255,255,0.03); border:1px solid ${p.isPrimary && cantidadPrincipales > 1 ? 'rgba(241,196,15,0.4)' : 'rgba(255,255,255,0.08)'}; border-radius:10px;">
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <span style="font-size:1.5rem;">${p.avatar || '🐯'}</span>
                            <div>
                                <div style="color:#fff; font-weight:700; font-size:0.85rem;">${p.name || 'Sin nombre'}${p.isPrimary ? ' 👑' : ''}</div>
                                <div style="color:${tienePin ? '#f1c40f' : '#666'}; font-size:0.7rem;">${tienePin ? '🔒 Con PIN' : '🔓 Sin PIN'}</div>
                            </div>
                        </div>
                    </div>
                    ${p.isPrimary && cantidadPrincipales > 1 ? `<p style="margin:0; font-size:0.65rem; color:#f1c40f;">⚠️ Hay ${cantidadPrincipales} perfiles "principales" en esta cuenta — debería haber solo uno.</p>` : ''}
                    <div style="display:flex; gap:6px; flex-wrap:wrap;">
                        ${tienePin
                            ? `<button onclick="window.adminResetProfilePin('${uid}', '${p.id}', '${nombreEscapado}')" style="background:rgba(241,196,15,0.1); border:1px solid rgba(241,196,15,0.3); color:#f1c40f; font-size:0.68rem; font-weight:700; padding:5px 9px; border-radius:6px; cursor:pointer; white-space:nowrap;">Quitar PIN</button>`
                            : ''}
                        ${p.isPrimary
                            ? `<button onclick="window.adminUnsetPrimary('${uid}', '${p.id}', '${nombreEscapado}')" style="background:rgba(0,242,255,0.1); border:1px solid rgba(0,242,255,0.3); color:#00f2ff; font-size:0.68rem; font-weight:700; padding:5px 9px; border-radius:6px; cursor:pointer; white-space:nowrap;">Quitar Corona</button>`
                            : ''}
                        <button onclick="window.adminDeleteProfile('${uid}', '${p.id}', '${nombreEscapado}')" style="background:rgba(231,76,60,0.1); border:1px solid rgba(231,76,60,0.3); color:#e74c3c; font-size:0.68rem; font-weight:700; padding:5px 9px; border-radius:6px; cursor:pointer; white-space:nowrap;">🗑️ Eliminar Perfil</button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Error cargando perfiles de la cuenta:', e);
        list.innerHTML = `<p style="color:#e74c3c; text-align:center; font-size:0.8rem;">Error cargando perfiles: ${e.message}</p>`;
    }
};

// Historial de inicios de sesión de una cuenta puntual — para ver si es
// alguien recurrente o entró una sola vez. Reusa user_activity (misma
// colección que ya alimenta el conteo de logins de la tabla). Sin orderBy
// en la query, mismo motivo que loadRegisteredUsers: dos where("==") no
// piden índice compuesto, pero sumarle un orderBy sí — se ordena en el
// cliente, que para el historial de un solo uid es un puñado de docs.
window.viewAccountSessions = async (uid, displayName) => {
    const modal = document.getElementById('account-sessions-modal');
    const title = document.getElementById('account-sessions-modal-title');
    const list = document.getElementById('account-sessions-list');
    if (!modal || !list) return;

    if (title) title.textContent = `Sesiones de ${displayName || 'esta cuenta'}`;
    list.innerHTML = '<p style="color:#888; text-align:center; font-size:0.8rem;">Cargando sesiones... 📡</p>';
    modal.style.display = 'flex';

    try {
        const { data: rows, error } = await supabase
            .from('user_activity')
            .select('ts, platform')
            .eq('uid', uid)
            .eq('action', 'login')
            .order('ts', { ascending: false })
            .limit(200);
        if (error) throw error;
        const sessions = (rows || []).map(r => ({ timestamp: Date.parse(r.ts), platform: r.platform }));

        if (sessions.length === 0) {
            list.innerHTML = '<p style="color:#888; text-align:center; font-size:0.8rem;">No hay inicios de sesión registrados para esta cuenta.</p>';
            return;
        }

        list.innerHTML = `
            <p style="margin:0 0 4px; color:#888; font-size:0.7rem;">${sessions.length} inicio${sessions.length !== 1 ? 's' : ''} de sesión registrados${sessions.length >= 200 ? ' (mostrando los últimos 200)' : ''}.</p>
            ${sessions.map(s => `
                <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 12px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:8px;">
                    <span style="color:#fff; font-size:0.78rem;">${s.timestamp ? new Date(s.timestamp).toLocaleString() : '—'}</span>
                    <span style="color:#9b59b6; font-size:0.7rem; font-weight:700;">${s.platform || '—'}</span>
                </div>
            `).join('')}
        `;
    } catch (e) {
        console.error('Error cargando sesiones de la cuenta:', e);
        list.innerHTML = `<p style="color:#e74c3c; text-align:center; font-size:0.8rem;">Error cargando sesiones: ${e.message}</p>`;
    }
};

window.adminResetProfilePin = async (uid, profileId, profileName) => {
    if (!confirm(`¿Quitarle el PIN al perfil "${profileName}"? Va a poder entrar sin PIN hasta que le pongan uno nuevo.`)) return;
    try {
        await updateDoc(doc(db, "users", uid, "profiles", profileId), { pin: "" });
        if (window.showToast) window.showToast(`🔓 PIN de "${profileName}" eliminado.`, 'success');
        window.viewAccountProfiles(uid, document.getElementById('account-profiles-modal-title').textContent.replace('Perfiles de ', ''));
    } catch (e) {
        console.error('Error quitando PIN:', e);
        if (window.showToast) window.showToast('Error al quitar el PIN: ' + e.message, 'error');
    }
};

// Quitar la marca de "principal" de un perfil (para arreglar el caso de
// varios perfiles fantasma que quedaron con isPrimary:true a la vez — solo
// debería haber uno). No requiere confirmación porque no borra nada, solo
// destraba para poder eliminar el perfil después con el botón normal.
window.adminUnsetPrimary = async (uid, profileId, profileName) => {
    try {
        await updateDoc(doc(db, "users", uid, "profiles", profileId), { isPrimary: false });
        if (window.showToast) window.showToast(`👑 "${profileName}" ya no es principal.`, 'success');
        window.viewAccountProfiles(uid, document.getElementById('account-profiles-modal-title').textContent.replace('Perfiles de ', ''));
    } catch (e) {
        console.error('Error quitando marca de principal:', e);
        if (window.showToast) window.showToast('Error: ' + e.message, 'error');
    }
};

// Borrado de perfil desde el admin: a diferencia de window.deleteProfile
// (la versión que usa el propio usuario, que bloquea borrar el principal),
// esta es una acción de soporte de confianza y no tiene esa traba — sirve
// justamente para limpiar perfiles fantasma marcados como principales por
// error, que el usuario no podría borrar por su cuenta.
window.adminDeleteProfile = async (uid, profileId, profileName) => {
    if (!confirm(`¿Eliminar el perfil "${profileName}"? Esto borra su historial y favoritos. No se puede deshacer.`)) return;
    try {
        await deleteDoc(doc(db, "users", uid, "profiles", profileId));
        if (window.showToast) window.showToast(`🗑️ Perfil "${profileName}" eliminado.`, 'success');
        window.viewAccountProfiles(uid, document.getElementById('account-profiles-modal-title').textContent.replace('Perfiles de ', ''));
    } catch (e) {
        console.error('Error eliminando perfil:', e);
        if (window.showToast) window.showToast('Error al eliminar el perfil: ' + e.message, 'error');
    }
};

// --- Detalle de Visitantes (drill-down desde la KPI "Visitantes Únicos") ---
window.openVisitorDetailModal = () => {
  const modal = document.getElementById('visitor-detail-modal');
  if (modal) modal.style.display = 'flex';
  window.renderVisitorDetailTable();
};

window.closeVisitorDetailModal = () => {
  const modal = document.getElementById('visitor-detail-modal');
  if (modal) modal.style.display = 'none';
};

window.renderVisitorDetailTable = () => {
  const tbody = document.getElementById('visitor-detail-table-body');
  const countEl = document.getElementById('visitor-detail-count');
  if (!tbody) return;

  if (!window._lastMetricsData || window._lastMetricsData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:30px;">No hay actividad cargada. Cierra este panel y aplica un rango de fechas en Analíticas primero.</td></tr>`;
    if (countEl) countEl.innerText = '';
    return;
  }

  const byVisitor = {};
  window._lastMetricsData.forEach(d => {
    const vid = d.visitorId || 'anónimo';
    if (!byVisitor[vid]) {
      byVisitor[vid] = { platform: d.platform || '—', first: d.timestamp, last: d.timestamp, events: 0, plays: 0, titles: new Set() };
    }
    const v = byVisitor[vid];
    v.events++;
    if (d.action === 'play_start' || d.action === 'watch_attempt') v.plays++;
    if (d.timestamp < v.first) v.first = d.timestamp;
    if (d.timestamp > v.last) v.last = d.timestamp;
    if (d.details?.title) v.titles.add(d.details.title);
  });

  const rows = Object.entries(byVisitor).sort((a, b) => b[1].last - a[1].last);
  if (countEl) countEl.innerText = `${rows.length} visitante(s) único(s) en este rango`;

  tbody.innerHTML = rows.map(([vid, v]) => `
    <tr>
      <td style="font-family:monospace; font-size:0.7rem; color:var(--admin-text-muted);">${vid.slice(0, 18)}</td>
      <td>${v.platform}</td>
      <td style="text-align:center;">${v.events}</td>
      <td style="text-align:center; color:var(--admin-accent-orange); font-weight:800;">${v.plays}</td>
      <td style="font-size:0.72rem;">${new Date(v.first).toLocaleString()}</td>
      <td style="font-size:0.72rem;">${new Date(v.last).toLocaleString()}</td>
    </tr>
  `).join('') || `<tr><td colspan="6" style="text-align:center; padding:30px;">Sin datos.</td></tr>`;
};

window.loadReports = async () => {
    try {
        const q = query(collection(db, "link_reports"), orderBy("reportedAt", "desc"), limit(100));
        const snap = await getDocs(q);
        window._linkReports = [];
        window._reportedIds = new Set();
        snap.forEach(d => {
            const data = d.data();
            data.id = d.id;
            window._linkReports.push(data);
            if (data.status !== 'resolved') window._reportedIds.add(data.movieId);
        });
        // Actualizar stats si estamos en admin (assuming _updateDetailedStats exists globally)
        if (typeof _updateDetailedStats === 'function' && _allInventoryItems && _allInventoryItems.length > 0) {
            _updateDetailedStats(_allInventoryItems);
        }
    } catch (e) { console.error("Error cargando reportes:", e); }
};

window.markAsBroken = (id) => {
  if (!window._brokenIds.has(id)) {
    window._brokenIds.add(id);
  }
};

// Sistema de Reporte de Links Caidos (por usuarios)
window.reportBrokenLink = async (movieId, movieTitle) => {
  try {
    const reportsCol = collection(db, "link_reports");
    await addDoc(reportsCol, {
      movieId,
      movieTitle,
      reportedAt: Date.now(),
      userAgent: navigator.userAgent.substring(0, 100),
      status: 'pending'
    });
  } catch (e) {
    console.error('Error guardando reporte:', e);
    throw e;
  }
};

window.resolveReport = async (reportId) => {
  try {
    await updateDoc(doc(db, "link_reports", reportId), { status: 'resolved', resolvedAt: Date.now() });
    // refresca — mismo motivo que en handleRouting: loadMetrics vive en el
    // módulo perezoso de Analíticas, no se puede llamar directo.
    cargarAnaliticas().then(() => window.loadMetrics());
  } catch (e) { console.error(e); }
};

window.filterInventoryByCategory = () => {
  const type = document.getElementById('inventory-type-filter')?.value || 'all';
  const category = document.getElementById('inventory-filter')?.value || 'all';
  const langFilter = document.getElementById('inventory-lang-filter')?.value || 'all';
  const genreFilter = document.getElementById('inventory-genre-filter')?.value || 'all';
  // Hay dos cajas de búsqueda (la del header y la propia de Catálogo) que
  // disparan esta misma función; usamos la que tenga texto, priorizando la
  // de Catálogo por ser la más específica al contexto de esta pestaña.
  const catalogSearch = document.getElementById('inventory-search');
  const headerSearch = document.getElementById('admin-global-search');
  const query = (catalogSearch?.value || headerSearch?.value || '').toLowerCase();

  let filtered = _allInventoryItems.filter(m => {
    const matchSearch = String(m.title || '').toLowerCase().includes(query);
    const matchType = type === 'all' || m.type === type || (type === 'movie' && !m.type);
    const matchLang = langFilter === 'all' || (m.lang || 'es-MX') === langFilter;

    // Check genres (stored as array or string)
    let matchGenre = true;
    if (genreFilter !== 'all') {
      const g = m.genres || m.genre_ids || [];
      matchGenre = Array.isArray(g) ? g.map(String).includes(String(genreFilter)) : String(g) === String(genreFilter);
    }

    let matchHealth = true;
    // m.status === 'broken': lo que pone auditarCatalogoCompleto() (y lo que
    // lee la tarjeta del home para el badge "Sin Fuentes"). _brokenIds es un
    // Set aparte que solo llena runBotHealthCheck()/markAsBroken() — sin el
    // OR de status, la auditoría marcaba bien la home pero el filtro de acá
    // no encontraba nada.
    if (category === 'broken') matchHealth = m.status === 'broken' || window._brokenIds.has(m.id) || !m.img || (m.img && m.img.includes('placeholder'));
    if (category === 'missing') matchHealth = !m.tmdbId || m.tmdbId === "";
    if (category === 'review') matchHealth = m.status === 'review';
    if (category === 'waiting') matchHealth = m.status === 'waiting';
    if (category === 'verify') matchHealth = (m.status === 'review' || m.status === 'waiting') && m.embed && m.embed.includes('streamtape') && m.exportStatus !== 'processing';
    if (category === 'reported') matchHealth = window._reportedIds && window._reportedIds.has(m.id);
    // OJO: vimeusDisponible/vimeusFantasma vienen `undefined` hasta que se
    // corre la auditoría (auditarCatalogoCompleto) al menos una vez para ese
    // título. `=== false` explícito (no solo `!vimeusDisponible`) evita que
    // todo lo NUNCA chequeado caiga en "Sin Vimeus" como si ya se hubiera
    // confirmado que no lo tiene.
    if (category === 'no-vimeus') matchHealth = m.vimeusDisponible === false && !m.vimeusFantasma;
    if (category === 'vimeus-fantasma') matchHealth = !!m.vimeusFantasma;
    if (category === 'no-download') matchHealth = !m.downloadUrl;
    // En el admin panel 'all' = TODOS (sin exclusiones por estado)

    return matchSearch && matchType && matchLang && matchGenre && matchHealth;
  });

  _inventoryPage = 1; // Reset pagination when filtering
  _renderInventoryRows(filtered);

  const bulkBtn = document.getElementById('btn-bulk-delete');
  if (bulkBtn) {
    if (category === 'broken' && filtered.length > 0) {
      bulkBtn.style.display = 'inline-block';
      bulkBtn.innerText = `🗑️ Borrar ${filtered.length} con Error`;
      bulkBtn.onclick = () => window.bulkDeleteMovies(filtered);
    } else if (query === 'nuke' || (type === 'all' && category === 'all' && query === '')) {
      // Solo mostramos el botón de borrar todo en casos específicos para evitar accidentes
      bulkBtn.style.display = 'none'; // Por ahora lo mantenemos oculto a menos que se necesite
    } else {
      bulkBtn.style.display = 'none';
    }
  }
};

window.bulkDeleteMovies = async (toDelete) => {
  if (!toDelete || toDelete.length === 0) return;
  if (!confirm(`¿Estás seguro de borrar ${toDelete.length} títulos de tu selva? 🌴🗑️ Esta acción es irreversible.`)) return;

  const overlay = document.getElementById('delete-progress-overlay');
  const bar = document.getElementById('progress-bar-fill');
  const text = document.getElementById('progress-percent');

  if (overlay) overlay.style.display = 'flex';

  let count = 0;
  for (const item of toDelete) {
    try {
      await deleteDoc(doc(db, "movies", item.id));
      count++;
      const percent = Math.round((count / toDelete.length) * 100);
      if (bar) bar.style.width = `${percent}%`;
      if (text) text.innerText = `${percent}% (${count}/${toDelete.length})`;
    } catch (e) {
      console.error("Error eliminando masivo:", item.id, e);
    }
  }

  if (overlay) overlay.style.display = 'none';

  // 🔥 Parche de Sincronización Real (v4.5.5): Limpiamos caché para evitar "Fantasmas"
  localStorage.removeItem('selvaflix_full_database');
  localStorage.removeItem('selvaflix_cache_timestamp');

  // Recargamos los datos para que la vista refleje la realidad de Firebase inmediatamente
  await loadSelvaFlixData();

  alert(`¡Limpieza completada! Se fueron ${count} tesoros de la selva.`);
  if (bar) bar.style.width = "0%";
};

window.nukeDatabase = async () => {
  const items = _allInventoryItems;
  if (items.length === 0) { alert("¡La selva ya está vacía! 🌴"); return; }

  if (confirm(`⚠️ ¡ALERTA ROJA! ⚠️\nVas a eliminar ABSOLUTAMENTE TODO el contenido de la base de datos (${items.length} títulos).\n¿ESTÁS SEGURO?`)) {
    if (confirm("¿Confirmas que quieres quemar toda la selva? 🔥 Esta acción NO se puede deshacer.")) {
      await window.bulkDeleteMovies(items);
    }
  }
};

window.deleteSelectedCoconas = async () => {
  const selected = Array.from(document.querySelectorAll('#inventory-grid .selva-check:checked')).map(cb => cb.dataset.id);
  if (selected.length === 0) { alert("¡No has seleccionado ninguna joya para pelar! 🐒"); return; }

  const confirmed = confirm(`¿Estás seguro de que quieres eliminar ${selected.length} elementos para siempre? 🔥`);
  if (!confirmed) return;

  const overlay = document.getElementById('delete-progress-overlay');
  const bar = document.getElementById('progress-bar-fill');
  const text = document.getElementById('progress-percent');
  const statusText = document.getElementById('progress-text');

  if (statusText) statusText.innerText = "Eliminando de la selva... 🧹🌴";
  if (overlay) overlay.style.display = 'flex';

  let count = 0;
  for (const id of selected) {
    try {
      await deleteDoc(doc(db, "movies", id));
      count++;
      const percent = Math.round((count / selected.length) * 100);
      if (bar) bar.style.width = `${percent}%`;
      if (text) text.innerText = `${percent}% (${count}/${selected.length})`;
    } catch (e) {
      console.error("Error eliminando:", id, e);
    }
  }

  if (overlay) overlay.style.display = 'none';
  localStorage.removeItem('selvaflix_full_database');
  localStorage.removeItem('selvaflix_cache_timestamp');
  await loadSelvaFlixData();
  if (window.filterInventoryByCategory) window.filterInventoryByCategory();
  alert(`¡Limpieza completada! ${count} elementos eliminados. 🧹🌴`);
  if (bar) bar.style.width = "0%";
};

window.approveSelectedCoconas = async () => {
    const selected = Array.from(document.querySelectorAll('#inventory-grid .selva-check:checked')).map(cb => cb.dataset.id);
    if (selected.length === 0) return;

    if (!confirm(`¿Aprobar y publicar las ${selected.length} seleccionadas? ✅🌴`)) return;

    const overlay = document.getElementById('delete-progress-overlay');
    const bar = document.getElementById('progress-bar-fill');
    const text = document.getElementById('progress-percent');
    const statusText = document.getElementById('progress-text');

    if (statusText) statusText.innerText = "Publicando en la selva... 🚀🌴";
    if (overlay) overlay.style.display = 'flex';

    let count = 0;
    for (const id of selected) {
        try {
            await updateDoc(doc(db, "movies", id), { status: 'healthy', updatedAt: Date.now() });
            count++;
            const percent = Math.round((count / selected.length) * 100);
            if (bar) bar.style.width = `${percent}%`;
            if (text) text.innerText = `${percent}% (${count}/${selected.length})`;
        } catch (e) {
            console.error("Error aprobando:", id, e);
        }
    }

    if (overlay) overlay.style.display = 'none';
    localStorage.removeItem('selvaflix_full_database');
    localStorage.removeItem('selvaflix_cache_timestamp');
    await loadSelvaFlixData();
    if (window.filterInventoryByCategory) window.filterInventoryByCategory();
    alert(`¡Éxito! ${count} títulos aprobados. 🥥🍹`);
    if (bar) bar.style.width = "0%";
};

window.waitSelectedCoconas = async () => {
    const selected = Array.from(document.querySelectorAll('#inventory-grid .selva-check:checked')).map(cb => cb.dataset.id);
    if (selected.length === 0) return;

    if (!confirm(`¿Mover las ${selected.length} seleccionadas a la lista de espera? ⏳🌴`)) return;

    const overlay = document.getElementById('delete-progress-overlay');
    const bar = document.getElementById('progress-bar-fill');
    const text = document.getElementById('progress-percent');
    const statusText = document.getElementById('progress-text');

    if (statusText) statusText.innerText = "Moviendo a espera... 🐒⏳";
    if (overlay) overlay.style.display = 'flex';

    let count = 0;
    for (const id of selected) {
        try {
            await updateDoc(doc(db, "movies", id), { status: 'waiting', updatedAt: Date.now() });
            count++;
            const percent = Math.round((count / selected.length) * 100);
            if (bar) bar.style.width = `${percent}%`;
            if (text) text.innerText = `${percent}% (${count}/${selected.length})`;
        } catch (e) {
            console.error("Error pausando:", id, e);
        }
    }

    if (overlay) overlay.style.display = 'none';
    localStorage.removeItem('selvaflix_full_database');
    localStorage.removeItem('selvaflix_cache_timestamp');
    await loadSelvaFlixData();
    if (window.filterInventoryByCategory) window.filterInventoryByCategory();
    alert(`¡Completado! ${count} títulos en espera. 🪵🌴`);
    if (bar) bar.style.width = "0%";
};

window.toggleSelectAllVisible = () => {
  const checks = Array.from(document.querySelectorAll('#inventory-grid .selva-check'));
  const allChecked = checks.length > 0 && checks.every(c => c.checked);
  
  // Si están todos marcados, desmarcamos todos. Si no, marcamos todos.
  const newState = !allChecked;
  checks.forEach(c => c.checked = newState);
  window.updateSelectedCount();
};

window.runBotHealthCheck = async () => {
  const items = movieDatabase.trending;
  if (items.length === 0) { alert("¡La selva está vacía! No hay nada que revisar. 🌴"); return; }

  if (!confirm("🤖 ACTIVAR BOT EXPLORADOR:\nOjo: Revisaré metadatos, imágenes y probaré los enlaces directos (Live TV). ¿Continuar? 🔍🌴")) return;

  const overlay = document.getElementById('delete-progress-overlay');
  const bar = document.getElementById('progress-bar-fill');
  const text = document.getElementById('progress-percent');
  const statusText = document.getElementById('progress-text');

  if (statusText) statusText.innerText = "Robot Explorador analizando enlaces y datos... 🤖🔎";
  if (overlay) overlay.style.display = 'flex';

  let brokenCount = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let isBroken = false;

    // 1. Reglas básicas:
    if (!item.img || item.img.includes('placeholder')) isBroken = true;
    if (!item.title) isBroken = true;
    if ((item.type === 'movie' || item.type === 'series') && !item.tmdbId) isBroken = true;

    // 2. Revisión de Enlaces Caídos (Solo links directos como Live TV):
    if (!isBroken && item.embed && item.embed.startsWith('http')) {
      // No podemos revisar iframes o TMDB vidsrc por CORS, 
      // pero si es un link directo de m3u8 o mp4 (Live TV), probamos un "ping":
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 seg max
        const res = await fetch(item.embed, { method: 'HEAD', mode: 'no-cors', signal: controller.signal });
        clearTimeout(timeoutId);
      } catch (e) {
        // Si falla el fetch totalmente (ej: dominio no existe), es link caído de verdad
        if (e.name === 'AbortError' || e.message.includes('Failed to fetch')) {
          isBroken = true;
        }
      }
    }

    if (isBroken) {
      window.markAsBroken(item.id);
      brokenCount++;
    }

    const percent = Math.round(((i + 1) / items.length) * 100);
    if (bar) bar.style.width = `${percent}%`;
    if (text) text.innerText = `${percent}% (${i + 1}/${items.length})`;
  }

  setTimeout(() => {
    if (overlay) overlay.style.display = 'none';
    alert(`🤖 INFORME DE LA EXPEDICIÓN:\n- Revisadas: ${items.length} títulos.\n- Detectadas con fallas/caídas: ${brokenCount}.\n\nUsa el filtro 'Salud -> Con Errores' para limpiarlas.`);
    if (window.filterInventoryByCategory) window.filterInventoryByCategory();
  }, 800);
};

// TMDB Search Integration
// --- TMDB SEARCH (SAFE SELECTION) ---
let _tmdbLastResults = [];

// TMDb no tiene media_type "anime": es una serie (tv) más. Se infiere con el
// mismo criterio que ya usa el descubrimiento de recomendados (género
// Animación=16 + idioma original japonés) para que una serie de anime
// buscada a mano no quede mal etiquetada como "Serie" (y el admin tenga que
// acordarse de corregir el tipo a mano después de cada alta).
function _tmdbEsAnime(m) {
  return m.media_type === 'tv' && Array.isArray(m.genre_ids) && m.genre_ids.includes(16) && m.original_language === 'ja';
}
function _tmdbTipo(m) {
  if (_tmdbEsAnime(m)) return 'anime';
  return m.media_type === 'tv' ? 'series' : 'movie';
}

const _escHtml = (str) => String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

window.searchTMDB = async function (query, isSuggestion = false) {
  if (!query) return;
  const resultsDiv = isSuggestion 
    ? document.getElementById('tmdb-img-suggestions') 
    : document.getElementById('tmdb-results');
  if (!resultsDiv) return;
  if (!isSuggestion) {
    resultsDiv.innerHTML = '<p style="color: var(--primary);">Buscando en Hollywood... 📡</p>';
    const bulkToolbar = document.getElementById('tmdb-bulk-toolbar');
    const selectAllChk = document.getElementById('chk-tmdb-select-all');
    if (bulkToolbar) bulkToolbar.style.display = 'none';
    if (selectAllChk) selectAllChk.checked = false;
  }

  try {
    let data;
    const lang = document.getElementById('discover-lang')?.value || 'es-MX';
    // Si escriben solo números, lo buscamos directo por ID (Ej: 1032892)
    if (/^\d+$/.test(query.trim())) {
      const res = await fetch(`${TMDB_URL}/movie/${query.trim()}?api_key=${TMDB_API_KEY}&language=${lang}`);
      if (!res.ok) throw new Error("No encontrado");
      const movie = await res.json();
      // El detalle de /movie/{id} no trae "media_type" (a diferencia de
      // /search/multi) — sin esto, el filtro de candidatos de más abajo lo
      // descartaba siempre y la búsqueda por ID directo nunca mostraba nada.
      movie.media_type = 'movie';
      data = { results: [movie] };
    } else {
      // Búsqueda multi (Películas y Series)
      const res = await fetch(`${TMDB_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=${lang}`);
      if (!res.ok) throw new Error("Error en API");
      data = await res.json();
    }

    if (!data.results || data.results.length === 0) {
      if (!isSuggestion) resultsDiv.innerHTML = '<p style="color: var(--text-muted);">No encontramos esa joya en la selva 🧐</p>';
      return;
    }

    // Tomar hasta 20 coincidencias reales de TMDb (sin recortar artificialmente a 5)
    const candidatos = data.results
      .filter(m => m.media_type === 'movie' || m.media_type === 'tv')
      .slice(0, 20);

    if (candidatos.length === 0) {
      if (!isSuggestion) resultsDiv.innerHTML = '<p style="color: var(--text-muted);">No se encontraron películas ni series en TMDb.</p>';
      return;
    }

    const fuentesExternasOn = document.getElementById('chk-fuentes-externas')?.checked ?? true;

    let itemsClasificados;

    if (isSuggestion) {
      // Sugerencia de póster (tira de miniaturas bajo el título, dispara en
      // cada tecla escrita): solo necesita m.poster_path, no las badges de
      // Vimeus/Respaldo. Chequear disponibilidad acá significaba hasta 20
      // fetches en paralelo a Vimeus POR TECLA sin ningún debounce -- podía
      // mandar cientos de pedidos en pocos segundos con solo escribir un
      // título. Se salta el chequeo entero para este modo.
      itemsClasificados = candidatos;
    } else {
      resultsDiv.innerHTML = '<p style="color: var(--primary);">Analizando servidores disponibles (Vimeus / Respaldo)... 🔎</p>';

      // Chequeo en paralelo de disponibilidad para cada candidato
      const estados = await Promise.all(candidatos.map(async (m) => {
        if (!m.id) return { vimeus: false, respaldo: false };
        const tipoVimeus = m.media_type === 'tv' ? 'serie' : 'movie';

        const esVimeus = await vimeusTieneTitulo(m.id, null, tipoVimeus);
        let esRespaldo = false;
        if (!esVimeus) {
          // Respaldo (FlixLatam/PelisMart/etc.) soporta series y películas con metadata TMDb
          esRespaldo = (m.media_type === 'tv') || (m.vote_count > 30) || !!m.poster_path;
        }
        return { vimeus: esVimeus, respaldo: esRespaldo };
      }));

      itemsClasificados = candidatos.map((m, i) => {
        const st = estados[i] || { vimeus: false, respaldo: false };
        const yaEnCatalogo = window._tmdbYaEnCatalogo(m.id);

        let badgeType = 'externo';
        if (st.vimeus) {
          badgeType = 'vimeus';
        } else if (st.respaldo) {
          badgeType = 'respaldo';
        }

        return {
          ...m,
          _esVimeus: st.vimeus,
          _esRespaldo: st.respaldo,
          _esExterno: !st.vimeus && !st.respaldo,
          _badgeType: badgeType,
          _yaEnCatalogo: yaEnCatalogo
        };
      });

      if (!fuentesExternasOn) {
        itemsClasificados = itemsClasificados.filter(item => item._esVimeus || item._esRespaldo);
        if (itemsClasificados.length === 0) {
          resultsDiv.innerHTML = '<p style="color: var(--text-muted);">No hay servidores automáticos detectados. Marca "Mostrar todos los resultados" para ver todo TMDb.</p>';
          return;
        }
      }

      // Ordenar: 🟢 VIMEUS -> 🍿 RESPALDO -> 🔗 EXTERNO
      itemsClasificados.sort((a, b) => {
        const p = { vimeus: 1, respaldo: 2, externo: 3 };
        return (p[a._badgeType] || 4) - (p[b._badgeType] || 4);
      });
    }

    _tmdbLastResults = itemsClasificados;

    if (isSuggestion) {
      resultsDiv.innerHTML = _tmdbLastResults
        .filter(m => m.poster_path)
        .slice(0, 8)
        .map((m, index) => {
          const imgUrl = TMDB_IMG_URL + m.poster_path;
          return `
            <div onclick="window.suggestImage('${imgUrl}')" style="cursor:pointer; flex:0 0 70px; text-align:center;">
              <img src="${imgUrl}" style="width:70px; height:105px; border-radius:6px; object-fit:cover; border:1px solid rgba(255,255,255,0.1);" onerror="this.src='https://via.placeholder.com/70x105'">
            </div>
          `;
        }).join('');
    } else {
      resultsDiv.innerHTML = _tmdbLastResults.map((m, index) => {
        // Escapado: el título viene de TMDb (editable por cualquiera) y se
        // inserta como texto/atributo vía innerHTML -- sin esto, un título
        // con comillas o `<` podía romper el atributo o inyectar markup.
        const title = _escHtml(m.title || m.name || "Sin Título");
        const type = _tmdbTipo(m);
        const imgUrl = m.poster_path ? (TMDB_IMG_URL + m.poster_path) : 'https://via.placeholder.com/150x225?text=SIN+POSTER';
        
        let distintivo = '';
        if (m._esVimeus) {
          distintivo = `<span style="display:inline-block; margin-top:2px; padding:2px 6px; border-radius:4px; background:rgba(46,204,113,0.18); color:#2ECC71; border:1px solid rgba(46,204,113,0.35); font-size:0.58rem; font-weight:800;" title="Servidor especial Vimeus disponible">🟢 VIMEUS</span>`;
        } else if (m._esRespaldo) {
          distintivo = `<span style="display:inline-block; margin-top:2px; padding:2px 6px; border-radius:4px; background:rgba(255,184,0,0.18); color:#FFB800; border:1px solid rgba(255,184,0,0.35); font-size:0.58rem; font-weight:800;" title="Servidores automáticos de respaldo (FlixLatam/PelisMart)">🍿 RESPALDO</span>`;
        } else {
          distintivo = `<span style="display:inline-block; margin-top:2px; padding:2px 6px; border-radius:4px; background:rgba(0,242,255,0.14); color:#00f2ff; border:1px solid rgba(0,242,255,0.35); font-size:0.58rem; font-weight:800;" title="En TMDb. Ingresa enlace de video manual">🔗 EXTERNO</span>`;
        }

        const yaBadge = m._yaEnCatalogo
          ? `<span style="display:inline-block; margin-top:2px; padding:2px 6px; border-radius:4px; background:rgba(231,76,60,0.18); color:#E74C3C; border:1px solid rgba(231,76,60,0.35); font-size:0.58rem; font-weight:800;">📼 YA AGREGADA</span>`
          : '';

        return `
          <div class="tmdb-item" style="cursor:pointer; min-width:110px; max-width:110px; text-align:center; position:relative; ${m._yaEnCatalogo ? 'opacity:0.6;' : ''}">
            <input type="checkbox" class="tmdb-bulk-check" data-index="${index}" ${m._yaEnCatalogo ? 'disabled title="Ya está en el catálogo"' : ''} onclick="event.stopPropagation(); window.updateTMDBBulkBar();" style="position:absolute; top:2px; left:2px; width:16px; height:16px; z-index:2; cursor:pointer;">
            <div onclick="window.selectTMDBMovie(${index})">
              <img src="${imgUrl}" alt="${title}" style="width:100px; height:150px; border-radius:8px; object-fit:cover; margin-bottom:4px;" onerror="this.src='https://via.placeholder.com/150x225'">
              <p style="font-size:0.65rem; color:var(--primary); font-weight:bold; margin:0;">[${type === 'series' ? 'Serie' : type === 'anime' ? 'Anime' : 'Peli'}]</p>
              <p style="font-size:0.7rem; color:white; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:2px 0;" title="${title}">${title}</p>
              <div style="display:flex; flex-direction:column; gap:2px; align-items:center;">
                ${distintivo}
                ${yaBadge}
              </div>
            </div>
          </div>
        `;
      }).join('');
      window.updateTMDBBulkBar();
    }

  } catch (err) {
    console.error("TMDB error:", err);
    if (!isSuggestion) resultsDiv.innerHTML = '<p style="color: #E74C3C;">Error al conectar con TMDB (Revisa tu búsqueda) 🐒</p>';
  }
}

// Re-defining as global window.searchTMDB for consistency

window.selectTMDBMovie = async (index) => {
  const m = _tmdbLastResults[index];
  if (!m) return;

  const title = m.title || m.name;
  const originalTitle = m.original_title || m.original_name || "";
  const date = m.release_date || m.first_air_date || "2024";
  const type = _tmdbTipo(m);

  document.getElementById('m-title').value = title;
  document.getElementById('m-original-title').value = originalTitle;
  document.getElementById('m-img').value = m.poster_path ? (TMDB_IMG_URL + m.poster_path) : "";
  document.getElementById('m-backdrop').value = m.backdrop_path ? (TMDB_IMG_URL + m.backdrop_path) : "";
  document.getElementById('m-tmdb-id').value = m.id;
  document.getElementById('m-type').value = type;
  document.getElementById('m-year').value = date.split('-')[0];
  document.getElementById('m-rating').value = m.vote_average || '8.0';
  if (document.getElementById('m-synopsis')) document.getElementById('m-synopsis').value = m.overview || m.synopsis || "";
  document.getElementById('m-embed').value = "";
  window.toggleEpisodesCardVisibility();
  _currentEpisodesMap = {};
  _currentEpisodesSeasons = null;
  if (type === 'series' || type === 'anime') window.loadEpisodesEditorSeasons();

  // Operación Búsqueda Pro: Obtener Títulos Alternativos, Director e ID IMDB
  try {
    const detailType = (type === 'series' || type === 'anime') ? 'tv' : 'movie';
    const [extResp, altResp, credResp, fullResp] = await Promise.all([
      fetch(`${TMDB_URL}/${detailType}/${m.id}/external_ids?api_key=${TMDB_API_KEY}`),
      fetch(`${TMDB_URL}/${detailType}/${m.id}/alternative_titles?api_key=${TMDB_API_KEY}`),
      fetch(`${TMDB_URL}/${detailType}/${m.id}/credits?api_key=${TMDB_API_KEY}`),
      // Los "collections" (franquicias) de TMDB solo existen para películas.
      detailType === 'movie' ? fetch(`${TMDB_URL}/movie/${m.id}?api_key=${TMDB_API_KEY}`) : Promise.resolve(null)
    ]);

    const extData = await extResp.json();
    document.getElementById('m-imdb-id').value = extData.imdb_id || "";

    const altData = await altResp.json();
    const titles = (altData.titles || altData.results || []).map(t => t.title);
    document.getElementById('m-alternative-titles').value = JSON.stringify(titles);

    const credData = await credResp.json();
    const director = credData.crew?.find(c => c.job === 'Director')?.name || "";
    document.getElementById('m-director').value = director;

    if (fullResp) {
      const fullData = await fullResp.json();
      const nombreFranquicia = (fullData.belongs_to_collection?.name || '').replace(/\s*Collection\s*$/i, '').trim();
      document.getElementById('m-franchise').value = nombreFranquicia;
      poblarListaFranquicias();
    }

  } catch (e) {
    console.warn("Fallo en recolección profunda de metadatos:", e);
  }

  const preview = document.getElementById('m-img-preview');
  if (preview) {
    preview.src = m.poster_path ? (TMDB_IMG_URL + m.poster_path) : 'https://via.placeholder.com/150x220?text=Previsualización';
  }

  const backdropPreview = document.getElementById('m-backdrop-preview');
  if (backdropPreview) {
    backdropPreview.src = m.backdrop_path ? (TMDB_IMG_URL + m.backdrop_path) : 'https://via.placeholder.com/600x338/111/555?text=Sin+Banner';
  }

  alert(`Cosechada info de: ${title} 🥥🍹 (Metadatos Pro Activos)`);
};

// ¿Ya tenemos este tmdbId en el catálogo? Se usa para marcar "YA AGREGADA"
// en los resultados de búsqueda y así no duplicar partes de una saga.
window._tmdbYaEnCatalogo = (tmdbId) => {
  if (!tmdbId || !movieDatabase?.trending?.length) return false;
  return movieDatabase.trending.some(mv => String(mv.tmdbId) === String(tmdbId));
};

window.updateTMDBBulkBar = () => {
  const toolbar = document.getElementById('tmdb-bulk-toolbar');
  const countEl = document.getElementById('tmdb-bulk-count');
  if (!toolbar) return;
  const checks = document.querySelectorAll('.tmdb-bulk-check:checked');
  if (checks.length > 0) {
    toolbar.style.display = 'flex';
    if (countEl) countEl.textContent = `${checks.length} seleccionada${checks.length > 1 ? 's' : ''}`;
  } else {
    toolbar.style.display = 'none';
  }
};

window.toggleAllTMDBCheckboxes = (checked) => {
  document.querySelectorAll('.tmdb-bulk-check:not(:disabled)').forEach(cb => { cb.checked = checked; });
  window.updateTMDBBulkBar();
};

// Carga masiva desde la búsqueda de TMDb: pensada para sagas partidas en
// varios títulos (Crepúsculo, Amanecer Parte 1/2, etc.) donde antes había
// que repetir el flujo completo "buscar → click → completar → guardar" una
// vez por cada parte. Trae los mismos metadatos extra que selectTMDBMovie
// (IMDB id, títulos alternativos, director) y guarda cada una directo en
// Firestore con estado "review", igual que hace el alta manual.
window.addSelectedTMDBMovies = async () => {
  const checks = Array.from(document.querySelectorAll('.tmdb-bulk-check:checked'));
  if (checks.length === 0) return;
  const indices = checks.map(cb => parseInt(cb.dataset.index, 10));
  const btn = document.querySelector('#tmdb-bulk-toolbar button.btn-add-selected');
  if (btn) btn.disabled = true;

  let ok = 0, fail = 0, omitidos = 0;
  for (let i = 0; i < indices.length; i++) {
    const m = _tmdbLastResults[indices[i]];
    if (!m) continue;
    if (btn) btn.textContent = `Agregando ${i + 1}/${indices.length}...`;

    // Este alta masiva era el único (junto al formulario individual, ya
    // arreglado aparte) que no chequeaba contra el catálogo ya cargado antes
    // de guardar — a diferencia de la Carga Masiva por páginas y la siembra
    // rápida, que sí filtran lo ya existente. Sin esto, seleccionar dos veces
    // el mismo resultado de búsqueda (o buscar algo que ya se había agregado
    // antes) creaba un duplicado en Firebase que el limpiador automático se
    // comía en la siguiente carga, dejando IDs muertos en cualquier
    // "Continuar viendo" que apuntara a la copia borrada.
    const yaExisteBulk = movieDatabase.trending.some(x => String(x.tmdbId) === String(m.id));
    if (yaExisteBulk) { omitidos++; continue; }

    try {
      const title = m.title || m.name;
      const date = m.release_date || m.first_air_date || "2024";
      const type = _tmdbTipo(m);
      const detailType = (type === 'series' || type === 'anime') ? 'tv' : 'movie';
      const imgUrl = m.poster_path ? (TMDB_IMG_URL + m.poster_path) : '';
      if (!imgUrl) throw new Error('sin póster');

      let director = '', imdbId = '', altTitles = [];
      try {
        const [extResp, altResp, credResp] = await Promise.all([
          fetch(`${TMDB_URL}/${detailType}/${m.id}/external_ids?api_key=${TMDB_API_KEY}`),
          fetch(`${TMDB_URL}/${detailType}/${m.id}/alternative_titles?api_key=${TMDB_API_KEY}`),
          fetch(`${TMDB_URL}/${detailType}/${m.id}/credits?api_key=${TMDB_API_KEY}`)
        ]);
        const extData = await extResp.json();
        imdbId = extData.imdb_id || '';
        const altData = await altResp.json();
        altTitles = (altData.titles || altData.results || []).map(t => t.title);
        const credData = await credResp.json();
        director = credData.crew?.find(c => c.job === 'Director')?.name || '';
      } catch (e) {
        console.warn('Metadatos extra fallaron para', title, e);
      }

      const tipoVimeus = type === 'anime' ? 'anime' : (type === 'series' ? 'serie' : 'movie');
      let vimeusDisponible = false, vimeusFantasma = false;
      try {
        const estado = await vimeusEstadoTitulo(String(m.id), imdbId, tipoVimeus);
        vimeusDisponible = estado === 'ok';
        vimeusFantasma = estado === 'fantasma';
      } catch (e) { /* se queda sin verificar, igual que si fallara en el alta manual */ }

      const movieData = {
        title,
        original_title: m.original_title || m.original_name || '',
        director,
        synopsis: m.overview || '',
        cast: '',
        alternative_titles: altTitles,
        img: imgUrl,
        backdrop: m.backdrop_path ? (TMDB_IMG_URL + m.backdrop_path) : '',
        pinned: false,
        tmdbId: String(m.id),
        imdbId,
        embed: '',
        year: date.split('-')[0],
        rating: m.vote_average ? m.vote_average.toFixed(1) : '8.0',
        type,
        lang: document.getElementById('discover-lang')?.value || 'es-MX',
        status: 'review',
        isVIP: false,
        releaseDate: null,
        showCountdown: true,
        vimeusDisponible,
        vimeusFantasma,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await addDoc(moviesCol, movieData);
      ok++;
    } catch (e) {
      console.error('Error agregando', m?.title || m?.name, e);
      fail++;
    }
  }

  if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle;">playlist_add</span> Agregar seleccionadas'; }

  localStorage.removeItem('selvaflix_full_database');
  localStorage.removeItem('selvaflix_cache_timestamp');
  await loadSelvaFlixData();
  if (window.filterInventoryByCategory) window.filterInventoryByCategory();

  const msg = `${ok} título${ok === 1 ? '' : 's'} agregado${ok === 1 ? '' : 's'} a Revisión`
    + (omitidos ? ` (${omitidos} ya estaba${omitidos === 1 ? '' : 'n'} en el catálogo, omitido${omitidos === 1 ? '' : 's'})` : '')
    + (fail ? ` (${fail} fallaron)` : '') + ' 🌴';
  if (window.showToast) window.showToast(msg, fail ? 'warning' : 'success');
  else alert(msg);

  // Re-renderiza la búsqueda para que las tarjetas recién agregadas
  // queden marcadas como "YA AGREGADA" y no se puedan volver a tildar.
  const query = document.getElementById('tmdb-search-input')?.value?.trim();
  if (query) window.searchTMDB(query);
};

// --- SISTEMA DE VISITANTE UNICO (UUID Anonimo) ---
// Cada persona recibe un ID secreto que vive en su celular para siempre.
// Nadie sabe quién eres, pero podemos contar que eres una persona única.
function getVisitorId() {
  let id = localStorage.getItem('selva_visitor_id');
  if (!id) {
    // Genera un ID aleatorio único tipo: "sf_1a2b3c4d-..."
    id = 'sf_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('selva_visitor_id', id);
  }
  return id;
}

// --- DATA & ADS SYSTEM ---
// user_activity y analytics_geo viven en Supabase (no Firestore): son tablas
// de solo-agregar que se leían enteras (miles de filas) y se agrupaban a mano
// en el navegador — con Postgres esa cuenta la hace la base (ver
// login_stats_by_uid/visitor_flags_since/etc., funciones SQL creadas a mano
// en Supabase, no versionadas). uid/auth de cuenta se quedan en Firebase.
async function collectUserData(action, details = {}) {
  try {
    await supabase.from('user_activity').insert({
      action,
      details,
      platform: navigator.platform,
      user_agent: navigator.userAgent.substring(0, 80),
      visitor_id: getVisitorId(),  // 🔑 ID de visitante unico
      uid: auth.currentUser ? auth.currentUser.uid : null // 🔑 Cuenta real, si hay sesión
    });
  } catch (e) { console.error("Error tracking:", e); }
}

// Player Logic & Multi-Server
// 🔥 Racha: los servidores externos van en iframe cross-origin, así que no
// hay forma de leer su currentTime real. Como proxy de "vio 2 minutos",
// medimos cuánto tiempo el reproductor se queda ABIERTO: si pasan 2 minutos
// sin que se haya cerrado, cuenta. Si cierra antes, se cancela (ver closePlayer).
const STREAK_WATCH_MS = 2 * 60 * 1000;
let _streakWatchTimer = null;

function startPlayer(movie) {
  collectUserData("play_start", { title: movie.title, type: movie.type });

  // 🔥 Algoritmo de popularidad: guardar conteo de plays localmente
  const counts = JSON.parse(localStorage.getItem('selva_play_counts') || '{}');
  const key = movie.tmdbId || movie.id;
  counts[key] = (counts[key] || 0) + 1;
  localStorage.setItem('selva_play_counts', JSON.stringify(counts));

  clearTimeout(_streakWatchTimer);
  if (auth.currentUser) {
    _streakWatchTimer = setTimeout(() => {
      if (typeof window.registerStreakProgress === 'function') window.registerStreakProgress();
      // Mismos 2 minutos cuentan como "el amigo referido ya miró algo" —
      // ver window.checkReferralReward().
      if (typeof window.checkReferralReward === 'function') window.checkReferralReward();
    }, STREAK_WATCH_MS);
  }

  // 🍿 Continuar Viendo (simple, sin barra de progreso): marcamos qué se
  // empezó a ver apenas se abre el player, sin importar la fuente (a
  // diferencia de syncPlaybackProgress, esto sí funciona con los servidores
  // externos en iframe, no solo con el <video> nativo).
  if (auth.currentUser && _currentProfile) {
    const historyRef = doc(db, "users", auth.currentUser.uid, "profiles", _currentProfile.id, "history", movie.id);
    setDoc(historyRef, {
      movieId: movie.id,
      title: movie.title || movie.name,
      poster: movie.img || movie.poster_path,
      type: movie.type,
      timestamp: Date.now()
    }, { merge: true }).catch(e => console.warn("No se pudo registrar en Continuar Viendo:", e));
  }

  SelvaStream.open(movie);
}

// 👑 EL DEDO DE DIOS: Fijar fuente VIP principal
window.selvaExecuteCrownPromotion = async (movieId, hash) => {
  console.log("👑 DEDO DE DIOS (v2.18): Solicitud de promoción/toggle para:", { movieId, hash });
  
  if (!movieId || movieId === 'undefined' || !hash) {
    alert("❌ Error: No se pudo identificar la película o la fuente.");
    return;
  }

  // Obtener el título de la película de la base de datos local
  const movie = movieDatabase.trending.find(m => m.id === movieId);
  if (!movie) return;
  const movieTitle = movie.title || "esta fuente";

  const currentHashes = movie.suggestedVipHashes || (movie.suggestedVipHash ? [movie.suggestedVipHash] : []);
  const isCrowned = currentHashes.includes(hash);
  let newHashes;

  if (isCrowned) {
      if (!confirm(`¿Quieres QUITARLE la corona a este servidor para: "${movieTitle}"? 🚫👑`)) return;
      newHashes = currentHashes.filter(h => h !== hash);
  } else {
      if (!confirm(`¿Quieres CORONAR este servidor para: "${movieTitle}"? ✨👑\n(Puedes tener múltiples coronas)`)) return;
      newHashes = [...currentHashes, hash];
  }
  
  try {
    await updateDoc(doc(db, "movies", movieId), { 
      suggestedVipHashes: newHashes,
      updatedAt: Date.now() 
    });
    
    // Update local cache directly to avoid immediate reload requirement
    movie.suggestedVipHashes = newHashes;
    localStorage.removeItem('selvaflix_full_database');
    localStorage.removeItem('selvaflix_cache_timestamp');
    
    // Re-render the UI smoothly!
    import('./components/Player/Player.js').then(({ SelvaStream }) => {
        if (SelvaStream.lastScrapedStreams) {
            SelvaStream.renderVipMenuList(); 
        }
    });

    alert(isCrowned ? "❌ Corona removida con éxito. (Cierra y repite para ordenar)" : "¡Fuente coronada con éxito! 👑🌴");
  } catch (e) {
    console.error("Error al fijar corona:", e);
    alert("No se pudo modificar la corona. Revisa la consola.");
  }
};

// --- Selección de Anuncios In-Player / App Banner ---
window.getFilteredAd = (placement) => {
    try {
        // 💎 Usuario Premium/Admin: ni en el reproductor ni en el banner de app.
        const tier = window.currentUserTier || 'free';
        if (tier === 'premium' || tier === 'admin') return null;

        // 🔥 Chequeo de Actividad Global
        const globalActive = document.getElementById('ad-active-global')?.checked !== false;
        if (!globalActive) return null;

        const nowTS = Date.now();
        const campaigns = window.adCampaigns || [];
        const activeCampaigns = campaigns.filter(c => c.active && c.placement === placement);
        
        if (activeCampaigns.length === 0) return null;

        const eligible = activeCampaigns.filter(c => {
            // 🕵️ MODO DIOS: Si está forzado, salta filtros de media y frecuencia
            const forceAds = localStorage.getItem('selva_force_ads_debug') === 'true';
            if (forceAds) return true;

            // Soporte para campañas de "Solo Link" (Direct Link)
            if (!c.media && !c.link) return false; 
            
            const h = JSON.parse(localStorage.getItem(`selva_ad_${c.id}`) || '{}');
            const lastView = h.views && h.views.length > 0 ? Math.max(...h.views) : 0;
            const diffMin = (nowTS - lastView) / 60000;
            return diffMin >= (c.freqValue || 60); // Usamos freqValue configurado
        });

        if (eligible.length === 0) return null;

        const priorities = eligible.map(c => c.priority || 2);
        const maxPriority = Math.max(...priorities);
        const topCandidates = eligible.filter(c => (c.priority || 2) === maxPriority);

        const candidatesWithHistory = topCandidates.map(c => {
            const h = JSON.parse(localStorage.getItem(`selva_ad_${c.id}`) || '{}');
            const lastSeen = h.views && h.views.length > 0 ? Math.max(...h.views) : 0;
            return { campaign: c, lastSeen };
        });

        candidatesWithHistory.sort((a, b) => a.lastSeen - b.lastSeen);
        return candidatesWithHistory[0].campaign;

    } catch (e) {
        console.error(`Error en getFilteredAd (${placement}):`, e);
        return null;
    }
};

window.getInPlayerAd = () => window.getFilteredAd('in_player');

window.checkAppBannerAd = () => {
    const ad = window.getFilteredAd('app_banner');
    const container = document.getElementById('app-sticky-banner');
    if (!container) return;

    if (!ad) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'flex';
    container.innerHTML = `
        <div style="flex: 1; display: flex; align-items: center; gap: 10px;">
            ${ad.media ? `<img src="${ad.media}" style="height: 40px; width: 40px; border-radius: 6px; object-fit: cover;">` : '🚩'}
            <div style="text-align: left;">
                <p style="color: var(--primary); font-size: 0.55rem; font-weight: 900; margin: 0; text-transform: uppercase;">Patrocinado 🌴</p>
                <p style="color: white; font-size: 0.7rem; font-weight: 600; margin: 0; line-height: 1.2;">${ad.message || "Anuncio"}</p>
            </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
            ${ad.link ? `<a href="${ad.link}" target="_blank" onclick="window.recordAdView('${ad.id}')" style="background: var(--primary); color: black; font-size: 0.6rem; font-weight: 900; padding: 6px 12px; border-radius: 6px; text-decoration: none;">VER</a>` : ''}
            <button onclick="this.parentElement.parentElement.style.display='none'" style="background: none; border: none; color: #555; font-size: 1.2rem; cursor: pointer; padding: 0 5px;">&times;</button>
        </div>
    `;
};

// --- Geolocalización & Analíticas 🌎 ---
window.trackUserGeo = async () => {
    try {
        const res = await fetch('https://ipapi.co/json/');
        const data = await res.json();
        
        const geoInfo = {
            country: data.country_name || 'Desconocido',
            city: data.city || 'Desconocido',
            region: data.region || 'Desconocido',
            ip: data.ip || '0.0.0.0',
            ts: Date.now()
        };

        sessionStorage.setItem('selva_geo_cache', JSON.stringify(geoInfo));
        console.log("| Ubicación detectada:", geoInfo.city, geoInfo.country);

        // Guardar visita (Cacheada 24h para no saturar Firestore por usuario)
        const lastTrack = localStorage.getItem('selva_last_geo_track');
        if (!lastTrack || (Date.now() - parseInt(lastTrack) > 86400000)) {
            await supabase.from('analytics_geo').insert({
                type: 'visit',
                country: geoInfo.country,
                city: geoInfo.city,
                region: geoInfo.region,
                ip: geoInfo.ip,
                // visitor_id + is_pwa: para el panel de Usuarios poder distinguir
                // invitados de cuentas reales, y navegador vs app instalada
                // (PWA). Arranca a contar desde que se agregó esto — no hay
                // forma de reconstruir esta info para visitas viejas.
                visitor_id: getVisitorId(),
                uid: auth.currentUser ? auth.currentUser.uid : null,
                is_pwa: window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true,
                is_mobile: /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
            });
            localStorage.setItem('selva_last_geo_track', Date.now());
        }

        return geoInfo;
    } catch (e) {
        return null;
    }
};

let geoCharts = { countries: null, cities: null };

window.refreshAdAnalytics = async () => {
    try {
        // Últimos 7 días para el panel de anuncios
        const sinceIso = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)).toISOString();

        const [viewsRes, clicksRes, countriesRes] = await Promise.all([
            supabase.from('analytics_geo').select('*', { count: 'exact', head: true }).eq('type', 'visit').gte('ts', sinceIso),
            supabase.from('analytics_geo').select('*', { count: 'exact', head: true }).eq('type', 'ad_click').gte('ts', sinceIso),
            supabase.rpc('ad_country_breakdown_since', { since: sinceIso })
        ]);

        const stats = { views: viewsRes.count || 0, clicks: clicksRes.count || 0 };
        const topCountries = (countriesRes.data || []).map(r => [r.country, Number(r.views)]);

        // 📊 En el TAB de publicidad, solo mostramos la tabla de rendimiento de países vs clics
        const tableBody = document.getElementById('ad-analytics-table-body');
        if (tableBody) {
            tableBody.innerHTML = topCountries.map(([name, count]) => `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.03);">
                    <td style="padding: 12px; font-weight: bold;">${name}</td>
                    <td style="padding: 12px; text-align: center;">${count}</td>
                    <td style="padding: 12px; text-align: center; color: var(--primary); font-weight: 800;">
                        ${((stats.clicks / (stats.views||1)) * 100).toFixed(2)}%
                    </td>
                </tr>
            `).join('') || '<tr><td colspan="3" style="text-align:center; padding:20px;">Sin datos de clics recientes.</td></tr>';
        }

    } catch (e) {
        console.error("Error cargando analíticas de anuncios:", e);
    }
};

window.renderGeoChart = (canvasId, label, dataObj, chartKey) => {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    if (!window.geoCharts) window.geoCharts = {};
    if (window.geoCharts[chartKey]) window.geoCharts[chartKey].destroy();

    const keys = Object.keys(dataObj).sort((a,b) => dataObj[b] - dataObj[a]).slice(0, 5);
    const values = keys.map(k => dataObj[k]);

    if (keys.length === 0) return;

    window.geoCharts[chartKey] = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: keys,
            datasets: [{
                data: values,
                backgroundColor: ['#FF6600', '#3498DB', '#2ecc71', '#9B59B6', '#E74C3C'],
                borderWidth: 1,
                borderColor: 'rgba(0,0,0,0.5)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { 
                legend: { 
                    display: true, 
                    position: 'right', 
                    labels: { color: '#aaa', font: { size: 9 }, usePointStyle: true, padding: 10 } 
                } 
            },
            cutout: '75%'
        }
    });
};

function renderGeoChart(canvasId, label, dataObj, chartKey) {
    window.renderGeoChart(canvasId, label, dataObj, chartKey);
}

// Refactor para registrar vista globalmente con GEO
window.recordAdView = async (id) => {
    const key = `selva_ad_${id}`;
    const h = JSON.parse(localStorage.getItem(key) || '{}');
    if(!h.views) h.views = [];
    const now = Date.now();
    h.views.push(now);
    localStorage.setItem(key, JSON.stringify(h));

    // Registrar en Supabase con Analytics
    try {
        const cachedGeo = JSON.parse(sessionStorage.getItem('selva_geo_cache') || '{}');
        await supabase.from('analytics_geo').insert({
            type: 'ad_click',
            ad_id: id,
            country: cachedGeo.country || 'Desconocido',
            city: cachedGeo.city || 'Desconocido'
        });
    } catch (err) { }
};

async function startWarningOverlay(movie, onComplete = () => startPlayer(movie)) {
  const overlay = document.getElementById('ad-overlay');
  if (!overlay) {
    onComplete();
    return;
  }

  // 💎 Usuario Premium/Admin: sin el preroll tampoco. Este es un motor de
  // anuncios aparte de injectCampaignScripts (ese cubre banners/scripts
  // globales, este es el que se ve al darle Play), así que necesita su
  // propio chequeo.
  const tier = window.currentUserTier || 'free';
  if (tier === 'premium' || tier === 'admin') {
    console.log("💎 Usuario Premium: se omite el anuncio de preroll.");
    onComplete();
    return;
  }

  try {
    const docSnap = await getDoc(doc(db, "configs", "monetization"));
    const config = docSnap.exists() ? docSnap.data() : { globalActive: false };

    // 🔥 Unificar estado global
    const globalActive = (config.globalActive !== false);
    if (document.getElementById('ad-active-global')) {
        document.getElementById('ad-active-global').checked = globalActive;
    }

    // 🕵️ MODO DIOS: Omitir filtros si el administrador lo desea
    const forceAds = localStorage.getItem('selva_force_ads_debug') === 'true';

    console.log("🎬 [AD ENGINE] Verificando monetización:", { globalActive, forceAds, movie: movie.title });

    if (!globalActive && !forceAds) {
      console.log("🍹 Publicidad desactivada globalmente. Saltando...");
      onComplete();
      return;
    }

    let activeCampaign = null;

    const now = new Date();
    const nowTs = Date.now();
    const currentHour = now.getHours();
    const currentDay = now.getDay(); // 0=D, 1=L...
    const movieKey = movie.title || movie.name || 'unknown';

    if (config.campaigns) {
        // 1. Filtrar candidatos por horario y día (Solo Overlays)
        const timeMatchCandidates = config.campaigns.filter(c => {
            const isOverlay = (c.placement === 'card_overlay' || c.placement === 'video_preroll');
            const basicMatch = c.active && isOverlay;
            if (!basicMatch) return false;
            
            if (forceAds || c.force) return true; // ⚡ MODO DIOS GIGA: Bypassear horario y días
            
            return c.days.includes(currentDay) && 
                   currentHour >= c.startHour && 
                   currentHour < c.endHour;
        });

        console.log("🎯 [AD ENGINE] Candidatos potenciales:", timeMatchCandidates.map(c => c.name));

        if (timeMatchCandidates.length > 0) {
            // 2. Filtrar los que pasan el test de frecuencia
            const eligibleCandidates = timeMatchCandidates.filter(c => {
                if (forceAds || c.force) return true; // ⚡ MODO DIOS: Salta frecuencias

                const storageKey = `selva_ad_${c.id}`;
                const h = JSON.parse(localStorage.getItem(storageKey) || '{}');
                const mode = c.freqMode || 'interval';
                
                if (mode === 'interval') {
                    // --- 🛑 ELIMINADO: Cooldown de frecuencia ---
                    // Siempre retornamos true para permitir la monetización constante
                    return true;
                } 
                else if (mode === 'per_movie_daily') {
                    const movieHistory = h.movies || {};
                    const lastMovieView = movieHistory[movieKey] || 0;
                    const isToday = new Date(lastMovieView).toDateString() === new Date().toDateString();
                    const maxTimes = c.freqTimes || 1;
                    
                    // Si nunca se ha visto esta peli hoy, o si permitimos múltiples veces (aún no implementado el contador por peli diario pero esto lo corrige)
                    return !isToday || (h.views || []).filter(ts => new Date(ts).toDateString() === new Date().toDateString()).length < maxTimes;
                } 
                else if (mode === 'per_movie_once') {
                    const movieHistory = h.movies || {};
                    return !movieHistory[movieKey];
                }
                return true;
            });

            if (eligibleCandidates.length > 0) {
                // 3. Agrupar por prioridad y elegir el nivel más alto disponible
                const priorities = eligibleCandidates.map(c => c.priority || 2);
                const maxPriority = Math.max(...priorities);
                const topCandidates = eligibleCandidates.filter(c => (c.priority || 2) === maxPriority);

                // 4. Aplicar Rotación Inteligente (LRU) dentro de ese nivel
                const candidatesWithHistory = topCandidates.map(c => {
                    const h = JSON.parse(localStorage.getItem(`selva_ad_${c.id}`) || '{}');
                    const lastSeen = h.views && h.views.length > 0 ? Math.max(...h.views) : 0;
                    return { campaign: c, lastSeen };
                });

                candidatesWithHistory.sort((a, b) => a.lastSeen - b.lastSeen);
                const neverSeen = candidatesWithHistory.filter(x => x.lastSeen === 0);
                activeCampaign = neverSeen.length > 1 ? 
                    neverSeen[Math.floor(Math.random() * neverSeen.length)].campaign : 
                    candidatesWithHistory[0].campaign;
            }
        }
    }

    if (!activeCampaign) {
      console.log("🍹 No hay campañas elegibles (o frecuencia bloqueada). Saltando...");
      onComplete();
      return;
    }

    // --- Ejecutar según Placement ---
    if (activeCampaign.placement === 'video_preroll') {
        // Lógica de VAST / Video Directo (Próxima implementación refinada)
        // Por ahora lo manejamos como un overlay con video si no es VAST
        window.showAdVideoPreroll(activeCampaign, movie, onComplete);
        return;
    }

    // Default: card_overlay
    window.showWarningOverlayCard(activeCampaign, movie, false, onComplete);

  } catch (e) {
    console.error("Error al iniciar el puente de anuncios:", e);
    onComplete();
  }
}

// 🃏 RENDERIZADO DE TARJETA (Reutilizable para Preview)
window.showWarningOverlayCard = (activeCampaign, movie, isPreview = false, onComplete = () => startPlayer(movie)) => {
    const overlay = document.getElementById('ad-overlay');
    if (!overlay) return;

    const isHybrid = activeCampaign.layout === 'hybrid';
    const isFullscreen = activeCampaign.layout === 'fullscreen';
    const canSkipNow = activeCampaign.canSkip || false;
    const hasMessage = activeCampaign.message && activeCampaign.message.trim() !== "";
    const hasMedia = activeCampaign.media && activeCampaign.media.trim() !== "";

    overlay.style.display = 'flex';
    overlay.style.background = isFullscreen ? 'black' : 'rgba(0,0,0,0.85)';
    overlay.style.zIndex = '50000';
    
    overlay.innerHTML = `
      <div class="ad-card-content" style="position: relative; z-index: 10; 
           background: ${isFullscreen ? 'transparent' : 'rgba(10,10,10,0.95)'}; 
           backdrop-filter: ${isFullscreen ? 'none' : 'blur(25px)'}; 
           padding: ${isFullscreen ? '0' : (isHybrid ? '30px' : '40px')}; 
           border-radius: ${isFullscreen ? '0' : '30px'}; 
           border: ${isFullscreen ? 'none' : '1px solid rgba(255,255,255,0.1)'}; 
           max-width: ${isFullscreen ? '100%' : '500px'}; 
           width: ${isFullscreen ? '100%' : '95%'}; 
           height: ${isFullscreen ? '100%' : 'auto'};
           text-align: center; 
           box-shadow: ${isFullscreen ? 'none' : '0 25px 60px rgba(0,0,0,0.9)'}; 
           overflow: hidden; 
           display: flex; flex-direction: column; align-items: center; justify-content: center;
           animation: adSlideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);">
        
        <style> 
            @keyframes adSlideUp { 0% { transform: translateY(40px) scale(0.95); opacity:0; } 100% { transform: translateY(0) scale(1); opacity:1; } } 
            .ad-hybrid-media { width: 100%; border-radius: 15px; margin: 20px 0; border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 10px 30px rgba(0,0,0,0.5); object-fit: cover; max-height: 250px; }
            .ad-fullscreen-media { position: absolute; top:0; left:0; width:100%; height:100%; object-fit: contain; z-index: 1; pointer-events: none; }
        </style>
        
        <!-- Media Elements -->
        ${(hasMedia && !activeCampaign.media.trim().startsWith('<script')) ? (isFullscreen ? 
            (activeCampaign.media.toLowerCase().endsWith('.mp4') ? 
                `<video src="${activeCampaign.media}" autoplay muted loop class="ad-fullscreen-media"></video>` : 
                `<img src="${activeCampaign.media}" class="ad-fullscreen-media">`) :
            (isHybrid ? 
                (activeCampaign.media.toLowerCase().endsWith('.mp4') ? 
                    `<video src="${activeCampaign.media}" autoplay muted loop class="ad-hybrid-media"></video>` : 
                    `<img src="${activeCampaign.media}" class="ad-hybrid-media">`) :
                (activeCampaign.media.toLowerCase().endsWith('.mp4') ? 
                    `<video src="${activeCampaign.media}" autoplay muted loop style="max-height: 300px; border-radius: 10px; margin-bottom: 20px;"></video>` : 
                    `<img src="${activeCampaign.media}" style="max-height: 300px; border-radius: 10px; margin-bottom: 20px;">`
                )
            )
        ) : (activeCampaign.media.trim().startsWith('<script') ? `
            <div id="ad-overlay-script-container" style="width: 100%; min-height: 250px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.2); border-radius: 4px; border: 1px solid rgba(255,255,255,0.05); margin: 20px 0; overflow: hidden;">
                <!-- Script se inyectará aquí después de pintar el DOM -->
            </div>
        ` : (activeCampaign.link ? `
            <a href="${activeCampaign.link || '#'}" target="_blank" onclick="window.recordAdView('${activeCampaign.id}')" style="text-decoration: none; display: block; width: 100%;">
                <div style="background: rgba(255,122,0,0.1); padding: 40px; border-radius: 25px; border: 2px dashed var(--primary); margin: 20px 0;">
                    <p style="font-size: 3rem; margin: 0;">🔗</p>
                    <p style="color: white; font-weight: 900; margin-top: 15px; text-transform: uppercase;">
                        Enlace de Patrocinador
                    </p>
                </div>
            </a>
        ` : '🚩'))}

        <div style="position: relative; z-index: 2; width: 100%; padding: 40px; box-sizing: border-box; 
                    ${isFullscreen ? 'background: linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 100%); position: absolute; bottom: 0;' : ''}">
            
            ${!isFullscreen || hasMessage ? `
                <div style="display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 20px;">
                    <img src="/icon_192.png" style="width: 45px;">
                    <span style="color: var(--primary); font-weight: 900; font-size: 0.7rem; letter-spacing: 2px;">AVISO DE LA SELVA 🌴</span>
                </div>
            ` : ''}
            
            ${hasMessage ? `
                <h2 style="color: white; font-size: 1.3rem; font-weight: 800; margin-bottom: 15px;">${activeCampaign.name || "Mensaje Importante"}</h2>
                <p style="color: #bbb; font-size: 0.9rem;">${activeCampaign.message}</p>
            ` : ''}

            <div id="ad-timer-display" style="font-size: 2.2rem; font-weight: 900; color: var(--primary); margin-bottom: 20px;">${activeCampaign.timer}</div>
            
            <button id="btn-proceed-ad" ${canSkipNow ? '' : 'disabled'} style="width: 100%; padding: 18px; border-radius: 12px; background: ${canSkipNow ? 'var(--primary)' : 'rgba(255,255,255,0.05)'}; font-weight: 900;">
              ${canSkipNow ? 'CONTINUAR A LA PELÍCULA 🍿' : 'ESPERA UN MOMENTO...'}
            </button>
            ${isPreview ? `<p style="color:#666; font-size:0.6rem; margin-top:10px;">[ MODO VISTA PREVIA ]</p>` : ''}
        </div>
      </div>
    `;

    let timeLeft = activeCampaign.timer;
    const btn = document.getElementById('btn-proceed-ad');
    
    if (canSkipNow) {
        btn.onclick = () => {
            overlay.style.display = 'none';
            if (!isPreview) window.finishAdFlow(activeCampaign, movie, onComplete);
        };
    }

    const timerInterval = setInterval(() => {
      timeLeft--;
      const display = document.getElementById('ad-timer-display');
      if (display) display.innerText = timeLeft > 0 ? timeLeft : "✓";
      
      if (timeLeft <= 0) {
        clearInterval(timerInterval);
        btn.disabled = false;
        btn.style.background = 'var(--primary)';
        btn.style.color = 'black';
        btn.innerText = 'CONTINUAR A LA PELÍCULA 🍿';
        btn.onclick = () => {
          overlay.style.display = 'none';
          if (!isPreview) window.finishAdFlow(activeCampaign, movie, onComplete);
        };
      }
    }, 1000);
 
    // 💉 Inyectar script si es necesario
    if (activeCampaign.media && activeCampaign.media.trim().startsWith('<script')) {
        setTimeout(() => {
            if (window.injectGlobalAdScripts) {
                window.injectGlobalAdScripts([activeCampaign.media], 'ad-overlay-script-container');
            }
        }, 100);
    }
}

window.previewCurrentAd = () => {
    if (!editingCampaignId) {
        if (window.showToast) window.showToast("Primero selecciona una campaña de la lista 👈", "info");
        return;
    }
    const camp = (window.adCampaigns || []).find(c => c.id === editingCampaignId);
    if (!camp) return;
    
    if (camp.placement === 'global_script') {
        if (window.showToast) window.showToast("Los scripts globales no tienen tarjeta de vista previa. 👻", "warning");
        return;
    }

    const mockMovie = { title: "Vista Previa 🌴", type: "movie" };
    if (camp.placement === 'video_preroll') {
        window.showAdVideoPreroll(camp, mockMovie);
    } else {
        window.showWarningOverlayCard(camp, mockMovie, true);
    }
};

window.finishAdFlow = (activeCampaign, movie, onComplete = () => startPlayer(movie)) => {
    const overlay = document.getElementById('ad-overlay');
    if (overlay) overlay.style.display = 'none';
    
    // Actualizar Historial de Frecuencia
    const storageKey = `selva_ad_${activeCampaign.id}`;
    const movieKey = movie.title || movie.name || 'unknown';
    let history = JSON.parse(localStorage.getItem(storageKey) || '{}');
    
    if (!history.views) history.views = [];
    history.views.push(Date.now());
    
    if (!history.movies) history.movies = {};
    history.movies[movieKey] = Date.now();
    
    // Nuevo rastreo para multivista diaria per movie
    if (!history.movies_history) history.movies_history = {};
    if (!history.movies_history[movieKey]) history.movies_history[movieKey] = [];
    history.movies_history[movieKey].push(Date.now());
    
    // Limpiar historial viejo de esa peli (más de 48h)
    history.movies_history[movieKey] = history.movies_history[movieKey].filter(ts => Date.now() - ts < 172800000);
    
    localStorage.setItem(storageKey, JSON.stringify(history));

    if (activeCampaign.link) {
       window.open(activeCampaign.link, '_blank');
    }
    onComplete();
};


window.showAdVideoPreroll = (activeCampaign, movie) => {
    const overlay = document.getElementById('ad-overlay');
    if (!overlay) return startPlayer(movie);

    overlay.style.display = 'flex';
    overlay.style.background = 'black';
    overlay.style.zIndex = '9999';

    const skipDelay = activeCampaign.timer || 5;
    
    overlay.innerHTML = `
        <div style="position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: black;">
            <video id="ad-video-element" src="${activeCampaign.media}" autoplay playsinline style="width: 100%; height: 100%; object-fit: contain;"></video>
            
            <!-- Ad Info Badge -->
            <div style="position: absolute; bottom: 100px; left: 30px; background: rgba(0,0,0,0.6); padding: 10px 20px; border-radius: 8px; border-left: 4px solid var(--primary); backdrop-filter: blur(10px); z-index: 10;">
                <p style="color: white; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; margin-bottom: 5px; letter-spacing: 1px;">Publicidad 🌴</p>
                <p style="color: #ccc; font-size: 0.85rem; margin: 0;">${activeCampaign.name || "Aviso de la Selva"}</p>
            </div>

            <!-- YouTube Style Skip Button -->
            <button id="btn-skip-ad" disabled style="position: absolute; bottom: 100px; right: 0; background: rgba(0,0,0,0.8); color: white; border: 1px solid rgba(255,255,255,0.2); border-right: none; padding: 15px 30px; font-weight: 900; font-size: 0.9rem; border-radius: 50px 0 0 50px; cursor: not-allowed; transition: all 0.3s; pointer-events: none; min-width: 150px; text-align: left;">
                Puedes saltar en <span id="ad-skip-timer">${skipDelay}</span>
            </button>
        </div>
    `;

    const video = document.getElementById('ad-video-element');
    const skipBtn = document.getElementById('btn-skip-ad');
    const skipTimer = document.getElementById('ad-skip-timer');
    let timeLeft = skipDelay;

    // Manejar errores de video
    video.onerror = () => {
        console.error("Error al cargar video de anuncio");
        window.finishAdFlow(activeCampaign, movie);
    };

    // Al terminar el video, saltar automáticamente
    video.onended = () => {
        window.finishAdFlow(activeCampaign, movie);
    };

    const interval = setInterval(() => {
        timeLeft--;
        if (skipTimer) skipTimer.innerText = timeLeft;

        if (timeLeft <= 0) {
            clearInterval(interval);
            if (skipBtn) {
                skipBtn.disabled = false;
                skipBtn.style.cursor = 'pointer';
                skipBtn.style.pointerEvents = 'auto';
                skipBtn.innerHTML = 'SALTAR ANUNCIO ⏭️';
                skipBtn.style.background = 'rgba(255,255,255,0.15)';
                skipBtn.style.backdropFilter = 'blur(10px)';
                skipBtn.onclick = () => {
                    video.pause();
                    window.finishAdFlow(activeCampaign, movie);
                };
            }
        }
    }, 1000);

    // Permitir click en el video para ir al link si existe
    if (activeCampaign.link) {
        video.style.cursor = 'pointer';
        video.onclick = () => {
            window.open(activeCampaign.link, '_blank');
        };
    }
};

// --- Debugging Tools ---
window.clearAdHistory = () => {
    if (confirm("¿Quieres resetear todo el historial de vistas de anuncios? Esto simulará que eres un usuario nuevo. 🐒🧹")) {
        const keys = Object.keys(localStorage);
        keys.forEach(key => {
            if (key.startsWith('selva_ad_')) {
                localStorage.removeItem(key);
            }
        });
        if (window.showToast) window.showToast("¡Historial de anuncios borrado! 🧼", "success");
    }
};

window.clearAdHistorySingle = () => {
    if (!editingCampaignId) return;
    const storageKey = `selva_ad_${editingCampaignId}`;
    localStorage.removeItem(storageKey);
    if (window.showToast) window.showToast("🧼 Historial de esta campaña limpiado.", "success");
};

window.toggleForceAds = (enabled) => {
    localStorage.setItem('selva_force_ads_debug', enabled);
    if (window.showToast) {
        window.showToast(enabled ? "⚡ MODO DIOS ACTIVADO: Anuncios sin límites" : "🛡️ MODO NORMAL ACTIVADO", enabled ? "success" : "warning");
    }
};

// Auxiliar para Video Preroll (Básico por ahora)
window.showAdVideoPreroll = (camp, movie, onComplete = () => startPlayer(movie)) => {
    const overlay = document.getElementById('ad-overlay');
    if (!overlay) return;

    const skipTime = camp.timer || 5;
    const hasLink = !!camp.link;

    overlay.style.display = 'flex';
    overlay.style.background = 'black';
    overlay.innerHTML = `
        <div style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; position:relative; overflow:hidden;">
            <!-- Background Glow -->
            <div style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:600px; height:600px; background:radial-gradient(circle, rgba(255,122,0,0.15) 0%, transparent 70%); z-index:0; filter:blur(50px);"></div>
            
            <video id="ad-video-element" src="${camp.media}" autoplay playsinline style="width:100%; height:100%; object-fit:contain; z-index:1;"></video>
            
            <!-- Superiores: Badge de Patrocinio -->
            <div style="position:absolute; top:30px; left:30px; z-index:2; display:flex; align-items:center; gap:12px; animation: adFadeInDown 0.8s ease;">
                <div style="background: var(--primary); color:black; font-size: 0.65rem; font-weight: 900; padding: 4px 10px; border-radius: 4px; letter-spacing: 1px; box-shadow: 0 0 15px var(--primary-glow);">PUBLICIDAD</div>
                <div style="color:white; font-size: 0.9rem; font-weight: 800; text-shadow: 0 2px 10px rgba(0,0,0,0.8);">${camp.name || "Patrocinador"}</div>
            </div>

            <!-- Inferiores: Info y Skip -->
            <div style="position:absolute; bottom:0; left:0; width:100%; z-index:2; padding:30px; box-sizing:border-box; background: linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 100%); display:flex; flex-direction:column; gap:20px;">
                
                <div style="display:flex; justify-content:space-between; align-items:flex-end;">
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        ${hasLink ? `
                            <a href="${camp.link}" target="_blank" onclick="window.recordAdView('${camp.id}')" style="background: rgba(255,255,255,1); color:black; padding:12px 25px; border-radius:50px; text-decoration:none; font-weight:900; font-size:0.8rem; display:flex; align-items:center; gap:10px; transition:0.3s; box-shadow:0 10px 30px rgba(255,255,255,0.3);" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
                                🌐 VISITAR SITIO <span style="font-size:1.1rem;">↗️</span>
                            </a>
                        ` : ''}
                        <p style="color:rgba(255,255,255,0.6); font-size:0.7rem; margin:0; font-weight:500;">Anuncio de ${camp.name || "Sponsor"}</p>
                    </div>

                    <div style="display:flex; align-items:center; gap:15px;">
                        <span id="ad-video-countdown" style="color:white; font-family:'Outfit', sans-serif; font-weight:900; font-size:1.2rem; min-width:30px; text-align:right;">${skipTime}</span>
                        <button id="btn-skip-video" disabled style="padding:14px 28px; border-radius:12px; border:none; background:rgba(0,0,0,0.6); color:#666; font-weight:900; font-size:0.75rem; letter-spacing:1px; cursor:not-allowed; transition:0.4s; backdrop-filter:blur(10px); border:1px solid rgba(255,255,255,0.1);">
                            SALTAR ANUNCIO
                        </button>
                    </div>
                </div>

                <!-- Barra de Progreso Core -->
                <div style="width:100%; height:4px; background:rgba(255,255,255,0.1); border-radius:2px; overflow:hidden;">
                    <div id="ad-video-progress" style="width:0%; height:100%; background:var(--primary); box-shadow:0 0 10px var(--primary-glow); transition: 0.1s linear;"></div>
                </div>
            </div>

            <style>
                @keyframes adFadeInDown { from { opacity:0; transform:translateY(-20px); } to { opacity:1; transform:translateY(0); } }
            </style>
        </div>
    `;

    const vid = document.getElementById('ad-video-element');
    const skipBtn = document.getElementById('btn-skip-video');
    const progress = document.getElementById('ad-video-progress');
    const countdown = document.getElementById('ad-video-countdown');

    let timeLeft = skipTime;
    
    const updateTimer = setInterval(() => {
        timeLeft--;
        if (countdown) countdown.innerText = timeLeft > 0 ? timeLeft : "";
        
        if (timeLeft <= 0) {
            clearInterval(updateTimer);
            if (skipBtn) {
                skipBtn.disabled = false;
                skipBtn.innerText = "SALTAR ANUNCIO ⏩";
                skipBtn.style.background = "white";
                skipBtn.style.color = "black";
                skipBtn.style.cursor = "pointer";
                if (countdown) countdown.style.display = "none";
                
                skipBtn.onclick = () => {
                    clearInterval(progressInterval);
                    overlay.style.display = 'none';
                    window.recordAdCleanup(camp, movie);
                };
            }
        }
    }, 1000);

    const progressInterval = setInterval(() => {
        if (vid.duration) {
            const perc = (vid.currentTime / vid.duration) * 100;
            if (progress) progress.style.width = perc + "%";
        }
    }, 100);

    vid.onended = () => {
        clearInterval(updateTimer);
        clearInterval(progressInterval);
        overlay.style.display = 'none';
        window.recordAdCleanup(camp, movie);
    };

    // Helper para limpiar y arrancar
    window.recordAdCleanup = (c, m) => {
        const storageKey = `selva_ad_${c.id}`;
        let history = JSON.parse(localStorage.getItem(storageKey) || '{}');
        if (!history.views) history.views = [];
        history.views.push(Date.now());
        if (!history.movies) history.movies = {};
        history.movies[m.title || m.name || 'unknown'] = Date.now();
        localStorage.setItem(storageKey, JSON.stringify(history));
        onComplete();
    };
};

// --- Trigger Landing Popup (Al cargar la web) ---
window.triggerLandingAd = async () => {
    // 🔍 Buscar campañas de bienvenida
    const now = Date.now();
    const day = ["dominga", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"][new Date().getDay()];
    const hour = new Date().getHours();
    
    // Obtenemos campañas de Firestore (o del snapshot ya guardado)
    const campsRef = collection(db, "campaigns");
    const q = query(campsRef, where("enabled", "==", true));
    const snap = await getDocs(q);
    
    const candidates = [];
    snap.forEach(doc => {
        const c = { id: doc.id, ...doc.data() };
        
        // 1. ¿Es de landing?
        const placements = c.placements || [];
        if (!placements.includes('landing_popup')) return;
        
        // 2. ¿Force?
        const isForced = localStorage.getItem('selva_force_ads_debug') === 'true' || c.forceAds;
        if (isForced) { candidates.push(c); return; }
        
        // 3. Horarios y días
        if (c.schedule && (hour < c.schedule.start || hour > c.schedule.end)) return;
        if (c.days && c.days.length > 0 && !c.days.includes(day)) return;
        
        // 4. Frecuencia Smart
        const storageKey = `selva_ad_${c.id}`;
        const history = JSON.parse(localStorage.getItem(storageKey) || '{}');
        const freqMode = c.frequencyMode || 'interval';
        
        if (freqMode === 'interval') {
            const last = history.views ? history.views[history.views.length - 1] : 0;
            const diff = (now - last) / (1000 * 60);
            if (diff < (c.frequencyValue || 60)) return;
        }
        
        candidates.push(c);
    });
    
    if (candidates.length === 0) return;
    
    // Elegir la de mayor prioridad
    candidates.sort((a,b) => (b.priority || 0) - (a.priority || 0));
    const win = candidates[0];
    
    console.log("💎 Disparando Popup de Bienvenida:", win.name);
    window.showWarningOverlayCard(win, { title: 'Bienvenido' });
};

// Esconde los 4 slots donde puede haber caído un anuncio (banner de arriba,
// banner de abajo, el lateral del menú de usuario, y el flotante global que
// injectGlobalAdScripts crea solo si hace falta). Se llama cada vez que el
// tier pasa a premium/admin DESPUÉS de que ya se hubieran inyectado ads como
// invitado/free — si no, quedaban visibles hasta el próximo login.
window.hideAllAdSlots = () => {
    ['ad-global-container', 'ad-slot-top', 'ad-slot-footer', 'ad-slot-sidebar'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
};

window.injectGlobalAdScripts = (contentArray, slotId = 'ad-global-container') => {
    if (!contentArray || contentArray.length === 0) return;
    console.log(`💉 Inyectando ${contentArray.length} elementos en slot: ${slotId}`);
    
    let container = document.getElementById(slotId);
    if (!container) {
        container = document.createElement('div');
        container.id = slotId;
        document.body.appendChild(container);
        // Si es el contenedor global para scripts de red, dejarlo al final de todo
        if (slotId === 'ad-global-container') {
            container.style.position = 'fixed';
            container.style.bottom = '10px';
            container.style.right = '10px';
            container.style.width = 'auto';
            container.style.height = 'auto';
            container.style.overflow = 'visible';
            container.style.zIndex = '99999';
            container.style.pointerEvents = 'auto';
        }
    }
    
    container.innerHTML = '';
    // Mostrar el contenedor si es un slot visual
    if (slotId !== 'ad-global-container') {
        container.style.display = 'block';
    } else {
        container.style.display = 'block'; // El global debe estar presente para scripts invisibles
    }

    contentArray.forEach(item => {
        if (!item || !item.trim()) return;

        // 🕵️ MODO SOCIAL BAR
        if (item.startsWith('SOCIAL_BAR|') && slotId === 'ad-global-container') {
            // Partido con cuidado: si la URL de la imagen trae un '|' suelto,
            // tomamos el ULTIMO '|' como separador del link, no el primero.
            const rest = item.slice('SOCIAL_BAR|'.length);
            const lastPipe = rest.lastIndexOf('|');
            const mediaUrl = (lastPipe >= 0 ? rest.slice(0, lastPipe) : rest).trim();
            const linkUrl = (lastPipe >= 0 ? rest.slice(lastPipe + 1) : '').trim() || '#';
            if (!mediaUrl) return;

            const barWrapper = document.createElement('div');
            barWrapper.style.position = 'fixed';
            barWrapper.style.bottom = '15px';
            barWrapper.style.left = '50%';
            barWrapper.style.transform = 'translateX(-50%)';
            barWrapper.style.zIndex = '10000';
            barWrapper.style.maxWidth = '90%';
            barWrapper.style.pointerEvents = 'auto';

            const card = document.createElement('div');
            card.style.cssText = 'position: relative; background: #111; border: 1px solid var(--primary); border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.8); animation: socialSlideUp 0.5s ease;';

            const closeBtn = document.createElement('button');
            closeBtn.innerHTML = '&times;';
            closeBtn.style.cssText = 'position: absolute; top: 5px; right: 5px; background: rgba(0,0,0,0.5); border: none; color: white; border-radius: 50%; width: 20px; height: 20px; cursor: pointer; z-index: 10; display:flex; align-items:center; justify-content:center; font-size:12px;';
            closeBtn.onclick = () => { barWrapper.style.display = 'none'; };

            const link = document.createElement('a');
            link.href = linkUrl !== '#' ? linkUrl : 'javascript:void(0)';
            link.target = linkUrl !== '#' ? '_blank' : '_self';
            link.style.cssText = 'text-decoration: none; display: block;';

            // Asignado como propiedad (no interpolado en un string de HTML),
            // asi el valor no puede "romper" la etiqueta aunque traiga
            // comillas o texto de mas pegado por error.
            const img = document.createElement('img');
            img.src = mediaUrl;
            img.style.cssText = 'display: block; width: 100%; max-height: 80px; object-fit: cover;';

            link.appendChild(img);
            card.appendChild(closeBtn);
            card.appendChild(link);
            barWrapper.appendChild(card);
            container.appendChild(barWrapper);
            return;
        }

        // 🚀 INYECCIÓN ROBUSTA (Scripts, HTML y Fotos)
        const isUrl = (item.startsWith('http') || item.startsWith('/') || (item.includes('.') && !item.includes(' '))) && !item.includes('<');
        
        if (isUrl) {
            // Es una foto directa (Selva Auto Mode)
            const img = document.createElement('img');
            img.src = item;
            img.style.maxWidth = '100%';
            img.style.borderRadius = '12px';
            img.style.display = 'block';
            img.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';
            container.appendChild(img);
        } else {
            // Es HTML (Banners Nativos) o Scripts (Adsterra Pop-under/Social Bar)
            const div = document.createElement('div');
            div.innerHTML = item;
            container.appendChild(div);
            
            // Re-ejecutar scripts encontrados en el HTML para activarlos
            const scripts = div.querySelectorAll('script');
            scripts.forEach(s => {
                const newScript = document.createElement('script');
                Array.from(s.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
                newScript.textContent = s.textContent;
                if (s.src) {
                    newScript.src = s.src;
                    newScript.async = true;
                }
                s.parentNode.replaceChild(newScript, s);
            });
        }
    });
};

window.injectCampaignScripts = async () => {
    // 🔒 Nunca inyectar anuncios de red en el panel admin: los overlays/popups
    // (Adsterra, Monetag) tapan botones reales del portal y comen los clics.
    const isAdminActive = sessionStorage.getItem('selva_admin_active') === '1'
        || document.getElementById('admin-view')?.style.display === 'block';
    if (isAdminActive) {
        console.log("🔒 Panel Admin activo: se omite la inyección de anuncios.");
        return;
    }

    // 💎 Usuario Premium/Admin: el beneficio "Sin publicidad" se cumple acá.
    // Se espera a que Firebase confirme el tier real antes de decidir —
    // si no, esta función corre en DOMContentLoaded y todavía ve el
    // 'free' por defecto aunque el usuario sea Premium (ver _authReadyPromise).
    if (window._authReadyPromise) await window._authReadyPromise;
    const tier = window.currentUserTier || 'free';
    if (tier === 'premium' || tier === 'admin') {
        console.log("💎 Usuario Premium: se omite la inyección de anuncios.");
        return;
    }

    const campaigns = (window.adCampaigns || []).filter(c => c.active);
    console.log(`💉 [DEBUG] Intentando inyectar ${campaigns.length} campañas activas.`);

    const forceGlobal = localStorage.getItem('selva_force_ads_debug') === 'true';
    
    if (campaigns.length === 0) {
        console.log("⚠️ No hay campañas activas para inyectar.");
        return;
    }

    const now = new Date();
    const currentHour = now.getHours();
    const currentDay = now.getDay();
    const nowTs = Date.now();

    // Colecciones de contenido a inyectar
    const globalScripts = []; // Scripts/HTML de red (Adsterra, etc.)
    const bannerTop = [];
    const bannerFooter = [];

    campaigns.forEach(c => {
        if (!c.media || !c.media.trim()) return;

        // ✅ Detección robusta de tipo - compatible con campañas antiguas
        // Un script es externo si su media contiene <script o si contentType es 'script'
        const mediaStr = (c.media || '').trim();
        const isScriptContent = mediaStr.startsWith('<script') || mediaStr.includes('<script') || c.contentType === 'script';
        
        // ✅ Detectar placement - compatible con campo viejo (placement) y nuevo (placements)
        const placementList = c.placements && c.placements.length > 0
            ? c.placements
            : [c.placement || 'global_script'];

        // ✅ Filtros de tiempo/frecuencia (omitidos si Force o si es script global)
        let passFilters = forceGlobal || c.force;
        
        if (!passFilters) {
            // Validación fecha inicio/fin
            if (c.startDate && c.startDate.trim()) {
                const start = new Date(c.startDate + "T00:00:00");
                if (!isNaN(start.getTime()) && nowTs < start.getTime()) { 
                    console.log(`⏳ Campaña futura: ${c.name}`); return; 
                }
            }
            if (c.endDate && c.endDate.trim()) {
                const exp = new Date(c.endDate + "T23:59:59");
                if (!isNaN(exp.getTime()) && nowTs > exp.getTime()) { 
                    console.log(`🚫 Campaña expirada: ${c.name}`); return; 
                }
            }

            // Scripts de red: siempre se inyectan si están activos (como el backup v4)
            if (isScriptContent) {
                passFilters = true;
            } else {
                const daysOk = !c.days || c.days.length === 0 || c.days.includes(currentDay);
                const timeMatch = daysOk && currentHour >= (c.startHour || 0) && currentHour < (c.endHour || 24);
                
                if (timeMatch) {
                    const storageKey = `selva_ad_${c.id}`;
                    const h = JSON.parse(localStorage.getItem(storageKey) || '{}');
                    const mode = c.freqMode || 'interval';
                    if (mode === 'unlimited') {
                        passFilters = true;
                    } else if (mode === 'interval') {
                        // --- 🛑 ELIMINADO: Cooldown de frecuencia ---
                        passFilters = true;
                    } else {
                        passFilters = true;
                    }
                }
            }
        }

        if (!passFilters) {
            console.log(`⏸️ [DEBUG] Campaña bloqueada por filtros: ${c.name}`);
            return;
        }

        console.log(`✅ [DEBUG] Inyectando: ${c.name} | placements: ${placementList.join(', ')}`);
        
        // ✅ Clasificar en el slot correcto — Default para todo lo desconocido: global
        placementList.forEach(p => {
            if (p === 'top_banner') {
                bannerTop.push(isScriptContent ? mediaStr : `SOCIAL_BAR|${mediaStr}|${c.link || '#'}`);
            } else if (p === 'footer_banner') {
                bannerFooter.push(isScriptContent ? mediaStr : `SOCIAL_BAR|${mediaStr}|${c.link || '#'}`);
            } else {
                // global_script, card_overlay, app_banner, o cualquier otro = va al global container
                if (isScriptContent) {
                    globalScripts.push(mediaStr);
                } else {
                    globalScripts.push(`SOCIAL_BAR|${mediaStr}|${c.link || '#'}`);
                }
            }
        });

        window.recordAdView(c.id);
    });

    // Inyectar en slots
    if (globalScripts.length > 0) {
        console.log(`🚀 Inyectando ${globalScripts.length} scripts en ad-global-container`);
        window.injectGlobalAdScripts(globalScripts, 'ad-global-container');
    }
    if (bannerTop.length > 0) window.injectGlobalAdScripts(bannerTop, 'ad-slot-top');
    if (bannerFooter.length > 0) window.injectGlobalAdScripts(bannerFooter, 'ad-slot-footer');
};


window.openLinkLibrary = () => {
    const links = (window.adCampaigns || [])
        .map(c => c.media)
        .filter(m => m && m.length > 5);
    
    const uniqueLinks = [...new Set(links)];
    
    if (uniqueLinks.length === 0) {
        if (window.showToast) window.showToast("La biblioteca está vacía aún. 📖🍃", "info");
        return;
    }

    const choice = prompt("📚 BIBLIOTECA DE LINKS / SCRIPTS:\n\n" + 
        uniqueLinks.map((l, i) => `${i+1}. ${l.substring(0, 50)}...`).join("\n") + 
        "\n\nEscribe el NÚMERO del link que quieres usar:");
    
    const idx = parseInt(choice) - 1;
    if (uniqueLinks[idx]) {
        document.getElementById('ad-edit-media').value = uniqueLinks[idx];
        if (window.showToast) window.showToast("Link cargado desde la biblioteca. 💎", "success");
    }
};

window.closeWarningOverlay = () => {
  const overlay = document.getElementById('ad-overlay');
  if (overlay) overlay.style.display = 'none';
};

window.openPlayer = async (movieId) => {
  const allMovies = [...movieDatabase.trending];
  const movie = allMovies.find(m => String(m.id) === String(movieId));
  if (!movie) {
      console.warn("Player abortado: No se encontró película con id", movieId);
      return;
  }

  collectUserData("watch_attempt", { title: movie.title, id: movie.id });

  // 💎 VIP Engine: Verificar Acceso
  const userTier = window.currentUserTier || 'free';
  const isPremium = userTier === 'premium' || userTier === 'admin';
  const now = Date.now();
  const isVipLocked = movie.isVIP && (!movie.releaseDate || now < movie.releaseDate);

  if (isVipLocked && !isPremium) {
    // Bloqueado para Free: Mostrar Modal de Estreno o Upgrade
    window.showVipLockModal(movie);
    return;
  }

  // --- Iniciar Puente de Anuncios (Capa 1 & 2) ---
  startWarningOverlay(movie);

  // 🧼 LIMPIEZA DE MODALES (Asegurar que favoritos/ajustes se cierren antes de jugar)
  const modalsToClose = [
    'my-list-modal', 
    'auth-modal', 
    'profile-selector-modal', 
    'profile-edit-name-modal', 
    'pin-modal', 
    'avatar-selector-modal', 
    'cleanup-modal'
  ];
  modalsToClose.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  document.body.style.overflow = ''; // Restaurar scroll por si acaso

  // 🍿 RECUPERAR PROGRESO (Continuar Viendo)
  if (auth.currentUser && _currentProfile) {
    try {
        // 1. Obtener progreso de cache o Firestore (Optimizado v2.42)
        const historyRef = doc(db, "users", auth.currentUser.uid, "profiles", _currentProfile.id, "history", movie.id);
        let snap = await getDoc(historyRef);

        // El progreso puede haber quedado guardado bajo un ID viejo si el
        // catálogo fusionó un duplicado después de guardarlo (ver
        // limpiarDuplicadosDeCatalogo) -- el ID actual ya no matchea ningún
        // documento y el capítulo/tiempo se perdía en silencio, aunque
        // "Continuar Viendo" ya hubiera encontrado la película por título.
        // Se busca por título como último recurso antes de asumir que nunca
        // se vio nada.
        if (!snap.exists() && movie.title) {
            const historyCol = collection(db, "users", auth.currentUser.uid, "profiles", _currentProfile.id, "history");
            const altQuery = query(historyCol, where("title", "==", movie.title), limit(1));
            const altSnap = await getDocs(altQuery);
            if (!altSnap.empty) snap = altSnap.docs[0];
        }

        if (snap.exists()) {
            const data = snap.data();
            if (data.lastTime > 0) {
                movie.resumeTime = data.lastTime;
                console.log(`🎬 Retomando en: ${data.lastTime}s`);
            }
            if (data.season && data.episode) {
                movie.resumeSeason = data.season;
                movie.resumeEpisode = data.episode;
                console.log(`📺 Retomando Serie: Temp ${data.season} Ep ${data.episode}`);
            }
        }
    } catch (e) { console.warn("Error recuperando historial:", e); }
  }

  // El reproductor se lanza via startWarningOverlay → startPlayer → SelvaStream.open()
};

// --- REPRODUCTOR INTEGRATION ---
// Ruteo Unificado: handleRouting es ahora la única fuente de verdad
window.addEventListener('hashchange', handleRouting);

// Soporte para Tecla Escape (Laptop/Desktop)
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('player-modal');
        if (modal && modal.style.display !== 'none') {
            window.closePlayer();
        }
    }
});

// Cierra el player correctamente y vuelve al detalle de la película
window.closePlayer = () => {
    clearTimeout(_streakWatchTimer); // cerró antes de los 2min: no cuenta para la racha
    if (typeof SelvaStream !== 'undefined') SelvaStream.close();
    // Volvemos al detalle. IMPORTANTE: history.back(), no window.location.hash =
    // — abrir el player ya empujó "detail/slug/play" al historial (ver
    // SelvaStream.open), así que reescribir el hash acá EMPUJABA una entrada
    // nueva "detail/slug" encima, duplicándola. Con esa pila, el botón atrás
    // FÍSICO del teléfono retrocedía un paso y caía otra vez en
    // "detail/slug/play" — el player se reabría en vez de seguir para atrás
    // (loop reportado en PWA instalada). history.back() consume la entrada de
    // /play en vez de apilar una nueva, así que no queda duplicado.
    const currentHash = window.location.hash.substring(1);
    if (currentHash.includes('/play') || !currentHash.startsWith('detail/')) {
        history.back();
    }
};

// Exported Actions
// 🔴 100% PÚBLICA — es el clic de CADA tarjeta de película de la portada.
// Un análisis estático la marcó como "solo admin" (porque la única referencia en el
// index.html cae dentro de #admin-view); en realidad se genera 12 veces desde
// plantillas de JS que el grep no ve. Moverla deja la home sin tarjetas. NO MOVER.
window.handleCardClick = (id, fallbackTitle) => {
    // Buscar la película para hacer un slug URL limpio
    const movie = movieDatabase?.trending?.find(m => m.id === id);
    if (movie) {
        const slug = slugify(movie.title, movie.year);
        window.location.hash = `detail/${slug}`;
        return;
    }

    // El ID guardado (ej. en "Continuar viendo") ya no existe en el catálogo
    // — el caso típico es que limpiarDuplicadosDeCatalogo() se lo comió al
    // fusionar un duplicado. Antes de rendirnos con un ID muerto en el hash
    // (que nunca va a matchear ni por ID ni por slug), probamos por título:
    // así la tarjeta se autorepara sola en vez de mandar a "Contenido no encontrado".
    if (fallbackTitle) {
        const porTitulo = movieDatabase?.trending?.find(
            m => (m.title || '').toLowerCase().trim() === fallbackTitle.toLowerCase().trim()
        );
        if (porTitulo) {
            window.location.hash = `detail/${slugify(porTitulo.title, porTitulo.year)}`;
            return;
        }
    }

    window.location.hash = `detail/${id}`;
};

// Clic específico de las tarjetas de "Continuar viendo": igual que el resto,
// primero va a la ficha (el usuario quiere ver la info antes de darle Play a
// propósito, no saltear ese paso). La diferencia es que acá ya sabemos en
// qué temporada/capítulo/minuto quedó -- viene en el propio historial y ya
// se ve en la tarjeta ("T1 E3") -- así que se lo dejamos precargado a la
// película para cuando el usuario le dé Play, en vez de que openPlayer
// tenga que re-buscarlo en Firestore por el ID actual (que puede no
// matchear si el catálogo fusionó un duplicado después de que se guardó el
// progreso).
window.resumeContinueWatching = (id, fallbackTitle, season, episode, lastTime) => {
    let movie = movieDatabase?.trending?.find(m => m.id === id);
    if (!movie && fallbackTitle) {
        movie = movieDatabase?.trending?.find(
            m => (m.title || '').toLowerCase().trim() === fallbackTitle.toLowerCase().trim()
        );
    }
    if (!movie) {
        window.location.hash = `detail/${id}`;
        return;
    }

    if (season && episode) { movie.resumeSeason = season; movie.resumeEpisode = episode; }
    if (lastTime > 0) movie.resumeTime = lastTime;

    window.location.hash = `detail/${slugify(movie.title, movie.year)}`;
};

// ======================================================
// DETALLE DE PELÍCULA — Vista Premium (Tailwind Design)
// ======================================================
// ─── Imágenes vía TMDB ───────────────────────────────────────────
// Guardar URLs de imagen a mano se rompe sola: basta una letra mal para tener un
// 404 permanente. Con el tmdbId siempre podemos pedirle a TMDB la buena.
//
// La caché guarda la *promesa*, no el resultado: si veinte tarjetas del mismo
// título piden imagen a la vez, se hace una sola llamada a la API.
const _tmdbImgCache = new Map();

function getTMDBImages(tipo, tmdbId) {
    const clave = `${tipo}:${tmdbId}`;
    if (_tmdbImgCache.has(clave)) return _tmdbImgCache.get(clave);

    const pedido = (async () => {
        try {
            const res = await fetch(`${TMDB_URL}/${tipo}/${tmdbId}?api_key=${TMDB_API_KEY}&language=es-PE`);
            const d = await res.json();
            return { poster: d.poster_path || null, backdrop: d.backdrop_path || null };
        } catch (e) {
            console.warn('No se pudo consultar TMDB:', e);
            return { poster: null, backdrop: null };
        }
    })();

    _tmdbImgCache.set(clave, pedido);
    return pedido;
}

const _tipoTMDB = (m) => (['series', 'tv', 'anime'].includes(m?.type) ? 'tv' : 'movie');

// La mayoría del catálogo se guardó sin campo `backdrop`, así que el hero del
// detalle terminaba usando el póster vertical. Aquí pedimos el apaisado real.
async function fetchBackdropTMDB(movie, el) {
    const { backdrop } = await getTMDBImages(_tipoTMDB(movie), movie.tmdbId);
    // Solo aplicamos si el usuario sigue en la misma ficha
    if (backdrop && el.isConnected) {
        const size = window.innerWidth >= 1024 ? 'w1280' : 'w780';
        el.style.backgroundImage = `url('https://image.tmdb.org/t/p/${size}${backdrop}')`;
        el.style.backgroundPosition = 'center top';
    }
}

// Rescate de pósters: se engancha al onerror de las tarjetas. Si la URL guardada
// falla (o no hay), le pedimos el póster a TMDB en vez de mostrar "Sin Imagen".
const SIN_IMAGEN = 'https://via.placeholder.com/500x750/1a1a1a/E74C3C?text=Sin+Imagen';

window.rescatarPoster = async (el, tmdbId, tipo) => {
    el.onerror = null; // sin esto, un fallo del rescate reentra en bucle
    if (!tmdbId) { el.src = SIN_IMAGEN; return; }

    const { poster } = await getTMDBImages(['series', 'tv', 'anime'].includes(tipo) ? 'tv' : 'movie', tmdbId);
    el.src = poster ? `https://image.tmdb.org/t/p/w500${poster}` : SIN_IMAGEN;
};

let _reintentosFicha = 0;

window.openMovieDetail = (slugOrId, opts = {}) => {
    const movie = findMovieBySlugOrId(slugOrId);
    if (!movie) {
        // Al recargar directamente sobre #detail/... el enrutado corre antes de
        // que lleguen los datos de Firestore. Sin catálogo no hay nada que
        // pintar y la ficha se quedaba con el "Cargando..." del HTML para
        // siempre (pantalla negra). Reintentamos hasta que llegue el catálogo.
        if (!movieDatabase?.trending?.length && _reintentosFicha < 40) {
            _reintentosFicha++;
            setTimeout(() => window.openMovieDetail(slugOrId, opts), 250);
            return;
        }

        console.warn('Movie not found for slug/id:', slugOrId);
        _reintentosFicha = 0;

        // Ya hay catálogo y aun así no está: decirlo en vez de dejar "Cargando..."
        const titleEl = document.getElementById('detail-title');
        if (titleEl) titleEl.textContent = 'Contenido no encontrado';
        const synopsisEl = document.getElementById('detail-synopsis');
        if (synopsisEl) synopsisEl.textContent = 'Este título ya no está disponible en la selva.';
        if (typeof SelvaStream !== 'undefined') SelvaStream.close();
        return;
    }

    _reintentosFicha = 0;
    // Sincronizar hash a slug limpio si llegamos por id antiguo
    const cleanSlug = slugify(movie.title, movie.year);
    const currentHash = window.location.hash.substring(1);
    if (currentHash === `detail/${movie.id}`) {
        history.replaceState(null, '', `#detail/${cleanSlug}`);
    }

    // 1. Backdrop / Hero Image
    const backdropEl = document.getElementById('detail-backdrop');
    if (backdropEl) {
        // En celular el hero es angosto: el backdrop horizontal recortado se ve
        // mal. Ahí usamos el póster vertical (el mismo de la miniatura). En
        // escritorio sí conviene el apaisado real.
        const esMobil = window.innerWidth < 1024;
        let imgUrl = esMobil ? (movie.img || movie.backdrop || '') : (movie.backdrop || movie.img || '');
        const esApaisado = !esMobil && !!movie.backdrop;

        // En escritorio el hero mide ~1600px: una w500 de TMDB se ve borrosa estirada.
        // Solo tocamos URLs de TMDB, los backdrops subidos a mano se quedan igual.
        if (!esMobil && imgUrl.includes('image.tmdb.org')) {
            imgUrl = imgUrl.replace(/\/w(200|300|500|780)\//, '/w1280/');
        }

        backdropEl.style.backgroundImage = `url('${imgUrl}')`;
        backdropEl.style.backgroundSize = 'cover';
        // Si lo que tenemos es el póster vertical (la mayoría del catálogo no trae
        // backdrop), encuadrar arriba deja ver solo la franja superior. El centro
        // es donde suele estar el sujeto.
        backdropEl.style.backgroundPosition = esApaisado ? 'center top' : 'center center';

        // Y en paralelo pedimos a TMDB el backdrop apaisado de verdad, pero solo
        // en escritorio: en celular ya elegimos a propósito el póster vertical.
        if (!esMobil && !movie.backdrop && movie.tmdbId) fetchBackdropTMDB(movie, backdropEl);
    }

    // 2. Título
    const titleEl = document.getElementById('detail-title');
    if (titleEl) titleEl.textContent = movie.title || 'Sin Título';
    // Título bajo el reproductor acoplado (visible en celular, donde el hero se oculta)
    const dockTitleEl = document.getElementById('detail-dock-title');
    if (dockTitleEl) dockTitleEl.textContent = movie.title || 'Sin Título';

    // 3. Año
    const yearEl = document.getElementById('detail-year');
    if (yearEl) yearEl.textContent = movie.year || movie.release_year || '';

    // 4. Rating
    const ratingEl = document.getElementById('detail-rating');
    if (ratingEl) ratingEl.textContent = movie.rating || '—';

    // 5. Sinopsis
    const synopsisEl = document.getElementById('detail-synopsis');
    if (synopsisEl) synopsisEl.textContent = movie.description || movie.overview || 'Sin descripción disponible.';

    // 5b. Los consejos (móvil vs escritorio) se muestran por CSS media query
    // (.consejo-movil / .consejo-escritorio), así siempre aciertan sin depender
    // del ancho en el momento de abrir la ficha.

    // 6. Botón PLAY → lanza el player directamente como overlay sobre la detail-view
    const playBtn = document.getElementById('detail-btn-play');
    if (playBtn) {
        playBtn.onclick = () => {
            window.openPlayer(movie.id);
        };
    }

    // 7. Botón MI LISTA
    const listBtn = document.getElementById('detail-btn-list');
    if (listBtn) {
        const isFav = window._myListIds && window._myListIds.has(movie.id);
        listBtn.innerHTML = isFav
            ? '<span class="material-symbols-outlined" style="font-variation-settings: \'FILL\' 1">favorite</span> EN MI LISTA'
            : '<span class="material-symbols-outlined">add</span> MI LISTA';
        listBtn.style.backgroundColor = isFav ? '#474746' : '#353534';
        listBtn.onclick = () => {
            if (window.toggleMyList) window.toggleMyList(movie.id, listBtn);
        };
    }

    // 7b. Botón DESCARGAR: usa el link manual de descarga si el admin ya lo
    // cargó para este título; si no, avisa que está en camino (aún no hay
    // fuente que entregue archivos propios, solo embeds de terceros).
    const handleDownloadClick = () => {
        if (movie.downloadUrl) {
            // A diferencia de PLAY, DESCARGAR abre el link directo sin pasar
            // por el motor de anuncios (startWarningOverlay hacía un getDoc a
            // Firestore en cada click, lo que causaba la demora al presionar).
            // Igual puede venir con una pestaña de publicidad de por medio
            // (mismo Adsterra que el resto del sitio), así que avisamos antes
            // para que no sorprenda ni parezca un error.
            window.open(movie.downloadUrl, '_blank', 'noopener');
            if (window.showToast) window.showToast('⚠️ Puede abrirse una pestaña de publicidad antes de la descarga — cerrala y volvé a SelvaFlix, tu descarga sigue igual.', 'warning', 6000);
        } else if (window.showToast) {
            window.showToast('📥 Descarga disponible pronto para este título 🌴', 'info');
        }
    };

    const downloadBtn = document.getElementById('detail-btn-download');
    if (downloadBtn) {
        // Se resetea el estilo en cada render (el botón se reusa entre
        // fichas): si no, un título con link dejaba el botón en verde
        // "pegado" al abrir el siguiente título que todavía no tiene uno.
        // El cuadro siempre dice solo "DESCARGAR".
        downloadBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">download</span> DESCARGAR';
        if (movie.downloadUrl) {
            downloadBtn.style.backgroundColor = 'rgba(46,204,113,0.12)';
            downloadBtn.style.borderColor = '#2ecc71';
            downloadBtn.style.color = '#2ecc71';
            downloadBtn.style.opacity = '1';
        } else {
            // Mismo botón, pero apagado: sin link cargado todavía no hay nada
            // que descargar, y el gris tenue lo deja claro de un vistazo.
            downloadBtn.style.backgroundColor = '#232323';
            downloadBtn.style.borderColor = '#3a3a3a';
            downloadBtn.style.color = '#7a7a7a';
            downloadBtn.style.opacity = '0.65';
        }
        downloadBtn.onclick = handleDownloadClick;
    }

    // 8. VIP badge en el header si aplica
    const detailHeader = document.getElementById('detail-header');
    if (detailHeader) {
        const existingBadge = detailHeader.querySelector('.detail-vip-badge');
        if (existingBadge) existingBadge.remove();
        if (movie.isVIP) {
            const vipBadge = document.createElement('div');
            vipBadge.className = 'detail-vip-badge';
            vipBadge.style.cssText = 'background: linear-gradient(45deg,#FFD700,#FFA500); color:#000; font-size:0.6rem; font-weight:900; padding:2px 8px; border-radius:12px; position:absolute; top:16px; left:50%; transform:translateX(-50%);';
            vipBadge.textContent = '👑 VIP';
            detailHeader.appendChild(vipBadge);
        }
    }

    // 9. "More Like This" — mismas categorías/géneros
    const moreLike = document.getElementById('detail-more-like-this');
    if (moreLike) {
        const genre = movie.genres ? (Array.isArray(movie.genres) ? movie.genres[0] : movie.genres) : '';
        const similar = movieDatabase.trending
            .filter(m => m.id !== movie.id && m.status !== 'review' && (!genre || (m.genres && (Array.isArray(m.genres) ? m.genres.includes(genre) : m.genres === genre))))
            .slice(0, 6);

        moreLike.innerHTML = similar.length ? similar.map(m => `
            <div onclick="window.handleCardClick('${m.id}')" style="cursor:pointer; border-radius:8px; overflow:hidden; background:#201f1f; position:relative; aspect-ratio:2/3;">
                <img src="${m.img || ''}" alt="${m.title}" loading="lazy"
                    onerror="window.rescatarPoster(this, '${m.tmdbId || ''}', '${m.type || 'movie'}')"
                    style="width:100%;height:100%;object-fit:cover;">
                <div style="position:absolute;bottom:0;left:0;right:0;padding:8px;background:linear-gradient(transparent,rgba(0,0,0,0.85));">
                    <p style="margin:0;font-size:12px;font-weight:600;color:#e5e2e1;font-family:Inter,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.title}</p>
                </div>
            </div>
        `).join('') : '<p style="color:#e6beb2;font-size:14px;grid-column:span 2;">No hay sugerencias disponibles.</p>';
    }

    // 10. Gestión de Sección de Administración en Ficha
    const isAdmin = localStorage.getItem('selva_admin_auth') === 'true';
    const adminSection = document.getElementById('detail-admin-section');
    if (adminSection) {
        if (isAdmin) {
            adminSection.style.display = 'block';
            
            // Llenar Link Maestro
            const linkInput = document.getElementById('detail-admin-manual-link-input');
            if (linkInput) linkInput.value = movie.embed || '';

            // Mostrar/ocultar botones específicos de estado
            const appBtn = document.getElementById('detail-admin-approve-btn');
            const waitBtn = document.getElementById('detail-admin-wait-btn');
            if (appBtn) appBtn.style.display = (movie.status === 'review' || movie.status === 'waiting') ? 'block' : 'none';
            if (waitBtn) waitBtn.style.display = (movie.status !== 'waiting') ? 'block' : 'none';

            // Configurar botones de acción
            if (appBtn) {
                appBtn.onclick = async () => {
                    await window.approveMovie(movieId);
                    window.openMovieDetail(movieId); // Refrescar vista
                };
            }
            if (waitBtn) {
                waitBtn.onclick = async () => {
                    await window.moveToWaiting(movieId);
                    window.openMovieDetail(movieId); // Refrescar vista
                };
            }
            
            const delBtn = document.getElementById('detail-admin-delete-btn');
            if (delBtn) {
                delBtn.onclick = async () => {
                    if (confirm(`¿Seguro que quieres eliminar "${movie.title}" de la selva? 🥥?`)) {
                        try {
                            const { getFirestore, doc, deleteDoc } = await import("firebase/firestore");
                            const db = getFirestore();
                            await deleteDoc(doc(db, "movies", movieId));
                            localStorage.removeItem('selvaflix_full_database');
                            localStorage.removeItem('selvaflix_cache_timestamp');
                            movieDatabase.trending = movieDatabase.trending.filter(m => m.id !== movieId);
                            if (window.showToast) window.showToast("¡Película eliminada de la selva! 🗑️", "success");
                            history.back(); // Volver atrás a la home
                        } catch (e) {
                            console.error("Error eliminando pelicula: ", e);
                        }
                    }
                };
            }

            // Configurar VIP
            const vipBtn = document.getElementById('detail-admin-vip-config-btn');
            if (vipBtn) {
                vipBtn.onclick = async () => {
                    const isCurrentlyVip = movie.isVIP || false;
                    const action = confirm(`Estado Actual: ${isCurrentlyVip ? "👑 VIP" : "🐾 LIBRE"}\n\n¿Quieres cambiar el estado VIP de "${movie.title}"?`);
                    if (action) {
                        const newVipStatus = !isCurrentlyVip;
                        let releaseDate = movie.releaseDate || null;

                        if (newVipStatus) {
                            const dateStr = prompt("¿Deseas poner una fecha de estreno? (Formato: AAAA-MM-DD HH:MM)\nDejar vacío para VIP permanente.", "");
                            if (dateStr) {
                                const parsed = new Date(dateStr);
                                if (!isNaN(parsed.getTime())) {
                                    releaseDate = parsed.getTime();
                                } else {
                                    alert("Fecha no válida. No se guardará la fecha.");
                                }
                            } else {
                                releaseDate = null;
                            }
                        }

                        try {
                            const { getFirestore, doc, updateDoc } = await import("firebase/firestore");
                            const db = getFirestore();
                            await updateDoc(doc(db, "movies", movie.id), { 
                                isVIP: newVipStatus, 
                                releaseDate: releaseDate,
                                updatedAt: Date.now()
                            });
                            
                            movie.isVIP = newVipStatus;
                            movie.releaseDate = releaseDate;
                            
                            if (window.showToast) {
                                window.showToast(`✅ VIP ${newVipStatus ? 'ACTIVADO' : 'DESACTIVADO'} para "${movie.title}"`, "success");
                            }
                            localStorage.removeItem('selvaflix_full_database');
                            localStorage.removeItem('selvaflix_cache_timestamp');
                            window.openMovieDetail(movieId); // Refrescar
                        } catch (e) {
                            console.error("Error actualizando VIP:", e);
                            if (window.showToast) window.showToast("Error al guardar cambios VIP.", "error");
                        }
                    }
                };
            }

            // Fijar Prioridad (Link Maestro)
            const setPriorityBtn = document.getElementById('detail-admin-set-priority-btn');
            if (setPriorityBtn) {
                setPriorityBtn.onclick = async () => {
                    let link = linkInput.value.trim();

                    // Campo vacío = quitar el enlace propio. Antes esto no hacía
                    // nada y no había forma de desfijar un link muerto desde la
                    // interfaz; el título se quedaba atado a él para siempre.
                    if (!link) {
                        if (!confirm('¿Quitar el enlace propio de este título?\n\nPasará a reproducirse con los servidores públicos (FlixLatam, PelisPlus…).')) return;
                        try {
                            const { getFirestore, doc, updateDoc } = await import("firebase/firestore");
                            await updateDoc(doc(getFirestore(), "movies", movie.id), { embed: '' });
                            movie.embed = '';
                            if (window.showToast) window.showToast("🧹 Enlace propio quitado. Ahora usa los servidores públicos.", "success");
                        } catch (e) {
                            if (window.showToast) window.showToast("Error al quitar el enlace: " + e.message, "error");
                        }
                        return;
                    }

                    if (link.includes('<iframe')) {
                        const srcMatch = link.match(/src="([^"]+)"/);
                        if (srcMatch) link = srcMatch[1];
                    }

                    if (link.includes('streamtape.com/v/')) {
                        link = link.replace('/v/', '/e/');
                    }
                    
                    try {
                        const { getFirestore, doc, updateDoc } = await import("firebase/firestore");
                        const db = getFirestore();
                        await updateDoc(doc(db, "movies", movie.id), { embed: link });
                        movie.embed = link; // Sync local
                        if (window.showToast) window.showToast("👑 Link Maestro fijado con éxito.", "success");
                    } catch (e) {
                        console.error("Error fijando link:", e);
                        if (window.showToast) window.showToast("Error al fijar prioridad.", "error");
                    }
                };
            }

        } else {
            adminSection.style.display = 'none';
        }
    }

    console.log('🎬 Detail view opened for:', movie.title);

    // 🎬 Autoplay: si llegamos por la ruta /play (enlace compartido o recarga),
    // abrir el reproductor automáticamente una vez montada la ficha.
    if (opts.autoPlay) {
        window.openPlayer(movie.id);
    }
};

window.detailReportMovie = async () => {
    const hash = window.location.hash;
    const slugOrId = hash.split('detail/')[1];
    const movie = findMovieBySlugOrId(slugOrId);
    if (!movie) return;
    try {
        await window.reportBrokenLink(movie.id, movie.title);
        window.showToast(`🚩 Reportaste "${movie.title}". ¡Gracias, lo revisaremos pronto! 🛡️`, "success");
    } catch (e) {
        window.showToast("No se pudo enviar el reporte. Intenta de nuevo. ", "error");
    }
};

window.detailShareMovie = async () => {
    const hash = window.location.hash;
    const slugOrId = hash.split('detail/')[1];
    const movie = findMovieBySlugOrId(slugOrId);
    if (!movie) return;
    const shareUrl = `${window.location.origin}${window.location.pathname}#detail/${slugify(movie.title, movie.year)}`;
    if (navigator.share) {
        try {
            await navigator.share({ title: movie.title, text: `Mira ${movie.title} en SelvaFlix! 🌴🍿`, url: shareUrl });
        } catch (e) {
            if (e.name !== 'AbortError') console.warn('Share failed:', e);
        }
    } else {
        await navigator.clipboard.writeText(shareUrl);
        window.showToast("¡Enlace copiado al portapapeles! 📋", "success");
    }
};

// Compartir la app en sí (no una peli puntual) — usado por el botón flotante
// del hero en Home, para invitar a un amigo a SelvaFlix.
window.shareApp = async () => {
    const shareUrl = `${window.location.origin}${window.location.pathname}`;
    if (navigator.share) {
        try {
            await navigator.share({ title: 'SelvaFlix', text: 'Mira películas y series gratis en SelvaFlix 🌴🍿', url: shareUrl });
        } catch (e) {
            if (e.name !== 'AbortError') console.warn('Share failed:', e);
        }
    } else {
        await navigator.clipboard.writeText(shareUrl);
        if (window.showToast) window.showToast("¡Enlace de SelvaFlix copiado al portapapeles! 📋", "success");
    }
};

window.deleteMovie = async (id, skipConfirm = false) => {
  if (skipConfirm || confirm("¿Seguro que quieres eliminar esta joya de la selva? 🥥?")) {
    try {
      await deleteDoc(doc(db, "movies", id));
      localStorage.removeItem('selvaflix_full_database');
      localStorage.removeItem('selvaflix_cache_timestamp');
      movieDatabase.trending = movieDatabase.trending.filter(m => m.id !== id);
      if (window.showToast) window.showToast("¡Película eliminada de la selva! 🗑️", "success");
      if (document.getElementById('admin-view')?.style.display === 'block') renderInventory();
    } catch (e) {
      console.error("Error eliminando pelicula: ", e);
    }
  }
};

window.approveMovie = async (id) => {
  try {
    await updateDoc(doc(db, "movies", id), { status: 'healthy', updatedAt: Date.now() });
    localStorage.removeItem('selvaflix_full_database');
    localStorage.removeItem('selvaflix_cache_timestamp');
    const movie = movieDatabase.trending.find(m => m.id === id);
    if (movie) movie.status = 'healthy';
    if (window.showToast) window.showToast("¡Aprobada y movida a la selva principal! ✅🌴", "success");
    if (document.getElementById('admin-view')?.style.display === 'block') {
        if (window.filterInventoryByCategory) window.filterInventoryByCategory();
        else renderInventory();
    }
  } catch (e) {
    console.error("Error aprobando pelicula: ", e);
  }
};

window.moveToWaiting = async (id) => {
  try {
    await updateDoc(doc(db, "movies", id), { status: 'waiting', updatedAt: Date.now() });
    localStorage.removeItem('selvaflix_full_database');
    localStorage.removeItem('selvaflix_cache_timestamp');
    const movie = movieDatabase.trending.find(m => m.id === id);
    if (movie) movie.status = 'waiting';
    if (window.showToast) window.showToast("Movida a 'En Espera' correctamente. ⏳🌴", "success");
    if (document.getElementById('admin-view')?.style.display === 'block') {
        if (window.filterInventoryByCategory) window.filterInventoryByCategory();
        else renderInventory();
    }
  } catch (e) {
    console.error("Error moviendo a espera: ", e);
  }
};

window.playNextReview = (currentId) => {
  const currentMovie = movieDatabase.trending.find(m => m.id === currentId);
  if (!currentMovie) return false;

  const reviewQueue = movieDatabase.trending.filter(m => m.status === currentMovie.status && m.id !== currentId);
  // Simplemente tomamos la siguiente disponible en revisión si estábamos revisando, o en espera si estábamos allí
  const statusToSearch = currentMovie.status === 'review' ? 'review' : 'waiting';
  const filteredQueue = movieDatabase.trending.filter(m => m.status === statusToSearch);
  
  const currentIndex = filteredQueue.findIndex(m => m.id === currentId);
  if (currentIndex !== -1 && currentIndex + 1 < filteredQueue.length) {
      window.handleCardClick(filteredQueue[currentIndex + 1].id);
      return true;
  }
  return false;
};


window.editMovie = (id) => {
  const movie = movieDatabase.trending.find(m => m.id === id);
  if (!movie) return;

  // openUploadDrawer() resetea el formulario entero (para que "Agregar
  // Título" siempre arranque limpio) — por eso hay que abrirlo PRIMERO y
  // recién después pisar esos valores por defecto con los datos reales de
  // la película. Si se llama al final (como antes), el reset borra todo
  // lo que se acababa de llenar acá abajo.
  window.openUploadDrawer();

  // Llenar formulario
  document.getElementById('m-db-id').value = movie.id;
  document.getElementById('m-title').value = movie.title;
  document.getElementById('m-img').value = movie.img;
  document.getElementById('m-backdrop').value = movie.backdrop || "";
  document.getElementById('m-pinned').checked = movie.pinned || false;
  document.getElementById('m-tmdb-id').value = movie.tmdbId || "";
  document.getElementById('m-imdb-id').value = movie.imdbId || ""; // Operación IMDB-Latino
  document.getElementById('m-embed').value = movie.embed || "";
  document.getElementById('m-download-url').value = movie.downloadUrl || "";
  document.getElementById('m-franchise').value = movie.franchise || "";
  document.getElementById('m-preferred-provider').value = movie.preferredProvider || "";
  document.getElementById('m-year').value = (movie.year || '2024').toString().split('-')[0];
  document.getElementById('m-rating').value = movie.rating || '4.8';
  document.getElementById('m-type').value = movie.type || 'movie';
  window.toggleEpisodesCardVisibility();
  document.getElementById('m-status').value = movie.status || 'review';
  document.getElementById('m-lang').value = movie.lang || 'es-MX';
  document.getElementById('m-synopsis').value = movie.synopsis || '';
  document.getElementById('m-director').value = movie.director || '';
  document.getElementById('m-cast').value = Array.isArray(movie.cast) ? movie.cast.join(', ') : (movie.cast || '');

  // VIP Fields
  const isVip = movie.isVIP || false;
  document.getElementById('m-is-vip').checked = isVip;
  document.getElementById('m-vip-options').style.display = isVip ? 'block' : 'none';
  document.getElementById('m-release-date').value = movie.releaseDate ? new Date(movie.releaseDate).toISOString().slice(0, 16) : "";
  document.getElementById('m-show-countdown').checked = movie.showCountdown !== false;

  // Actualizar previsualizaciones
  document.getElementById('m-img-preview').src = movie.img;
  // Mismo fallback que usa el Home cuando falta el backdrop: cae al póster
  // antes que al placeholder genérico (ver item.backdrop || item.img).
  document.getElementById('m-backdrop-preview').src = movie.backdrop || movie.img || 'https://via.placeholder.com/600x338/111/555?text=Sin+Banner';

  // Cambiar botones del form
  const submitBtn = document.getElementById('submit-btn');
  const cancelBtn = document.getElementById('cancel-edit');
  if (submitBtn) submitBtn.innerText = "¡Actualizar en la Selva! 🔄";
  if (cancelBtn) cancelBtn.style.display = "block";

  // Sugerir imágenes automáticamente al editar
  if (movie.title) searchTMDB(movie.title, true);

  // Abrir el drawer deslizante con título en modo edición en español
  const drawerTitle = document.getElementById('drawer-form-title');
  const editingIdField = document.getElementById('editing-movie-id');
  const breadcrumb = document.getElementById('drawer-breadcrumb-action');
  if (drawerTitle) drawerTitle.textContent = `Editando: ${movie.title}`;
  if (breadcrumb) breadcrumb.textContent = 'Editar Película';
  if (editingIdField) editingIdField.value = movie.id;

  // Cargar previsualización del video al editar
  window.updateMiniPlayer();

  // "Probar como la ve un usuario real" ahora corre sola al editar, igual
  // que los servidores públicos de abajo, para no depender del click manual
  // en "Actualizar Vista". Solo si hay ID (si no, previewVimeusAuto tira
  // un toast de aviso que no tiene sentido ver en cada edición).
  if (movie.tmdbId || movie.imdbId) window.previewVimeusAuto();

  // Los servidores públicos ahora aparecen solos al editar, sin depender
  // de que el admin apriete el botón primero.
  if (movie.imdbId) window.checkAdminPublicServers();

  // Editor de episodios: precargar links manuales ya guardados y, si es
  // serie/anime con TMDb ID, traer las temporadas solo para poder mostrarlos.
  _currentEpisodesMap = { ...(movie.episodes || {}) };
  _currentEpisodesSeasons = null;
  const epRows = document.getElementById('ep-rows-container'); if (epRows) epRows.innerHTML = '';
  if (['series', 'anime'].includes(movie.type) && movie.tmdbId) {
    window.loadEpisodesEditorSeasons();
  } else if (['series', 'anime'].includes(movie.type)) {
    // Sin TMDb ID no hay de dónde traer temporadas/capítulos: los links ya
    // guardados en movie.episodes siguen intactos en _currentEpisodesMap (y
    // el reproductor los sigue usando), pero acá no hay forma de listarlos
    // fila por fila sin saber cuántos episodios tiene cada temporada.
    const epStatus = document.getElementById('ep-editor-status');
    if (epStatus) epStatus.textContent = Object.keys(_currentEpisodesMap).length
      ? `Este título ya tiene ${Object.keys(_currentEpisodesMap).length} link(s) guardado(s), pero falta el ID TMDB para poder editarlos acá.`
      : 'Cargá el ID TMDB arriba para poder agregar links por capítulo.';
  }
};


window.suggestImage = (url) => {
  document.getElementById('m-img').value = url;
  document.getElementById('m-img-preview').src = url;
};

window.openLogoSearch = () => {
  const title = document.getElementById('m-title').value;
  if (!title) { alert("¡Escribe el nombre del canal primero! 🐒"); return; }
  const query = encodeURIComponent(`${title} channel logo png transparent`);
  window.open(`https://www.google.com/search?q=${query}&tbm=isch`, '_blank');
};

window.handleImageUpload = async (file) => {
  if (!file) return;
  const preview = document.getElementById('m-img-preview');
  const imgInput = document.getElementById('m-img');

  if (file.size > 2 * 1024 * 1024) { alert("¡Ufff! Esa cocoña pesa mucho. Usa una imagen menos de 2MB. 🌴🐜"); return; }

  preview.src = 'https://via.placeholder.com/100x150?text=Subiendo...';

  try {
    const storageRef = ref(storage, `posters/${Date.now()}_${file.name}`);
    const snapshot = await uploadBytes(storageRef, file);
    const url = await getDownloadURL(snapshot.ref);

    imgInput.value = url;
    preview.src = url;
    alert("¡Subida con éxito a la nube de SelvaFlix! ☁️🦁");
  } catch (err) {
    console.error("Error completo de Firebase:", err);
    alert(`Error al subir: ${err.message}\n\nRECUERDA: Tienes que activar 'Storage' en tu consola de Firebase y poner las reglas en modo prueba o públicas para que funcione. 🐒☁️`);
    preview.src = 'https://via.placeholder.com/100x150?text=Error';
  }
};

// --- Discovery & Seeding Tool ---
async function discoverContent(topic) {
  const list = document.getElementById('discover-list');
  const status = document.getElementById('discover-status');
  const container = document.getElementById('discover-container');
  const year = document.getElementById('discover-year').value;
  const genre = document.getElementById('discover-genre').value;
  const lang = document.getElementById('discover-lang')?.value || 'es-MX';

  container.style.display = 'block';
  status.innerText = `🥥 Cosechando sugerencias...`;
  list.innerHTML = '';

  if (topic === 'live') {
    // ... (Keep existing live channels code) ...

    const categories = [
      { name: "Deportes ⚽", img: "https://via.placeholder.com/400x225/111/fff?text=DEPORTES+TV", embed: "" },
      { name: "Cine y Pelis 🍿", img: "https://via.placeholder.com/400x225/111/fff?text=CINE+TOTAL", embed: "" },
      { name: "Noticias 📡", img: "https://via.placeholder.com/400x225/111/fff?text=NOTICIAS+24/7", embed: "" },
      { name: "Cultural 🌿", img: "https://via.placeholder.com/400x225/111/fff?text=CULTURA+Y+NATURA", embed: "" }
    ];

    const peruvianChannels = [
      { name: "Latina TV", img: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Latina_Televisi%C3%B3n_logo.svg/1024px-Latina_Televisi%C3%B3n_logo.svg.png", embed: "https://ejemplo.com/m3u8-player?url=https://stream.latina.pe/live.m3u8" },
      { name: "América TV", img: "https://logodownload.org/wp-content/uploads/2018/11/america-tv-logo.png", embed: "https://ejemplo.com/m3u8-player?url=https://stream.america.pe/live.m3u8" },
      { name: "Panamericana", img: "https://upload.wikimedia.org/wikipedia/commons/4/45/Panamericana_Televisi%C3%B3n_-_Logo_2016.png", embed: "https://ejemplo.com/m3u8-player?url=https://stream.panamericana.pe/live.m3u8" },
      { name: "ATV", img: "https://upload.wikimedia.org/wikipedia/commons/c/c5/ATV_Red_Nacional.png", embed: "https://stream.atv.pe/live.m3u8" },
      { name: "Willax", img: "https://willax.tv/img/willax-logo.png", embed: "https://stream.willax.tv/live.m3u8" },
      { name: "TV Perú", img: "https://upload.wikimedia.org/wikipedia/commons/2/29/TV_Per%C3%BA_logo_2020.png", embed: "https://stream.tvperu.gob.pe/live.m3u8" }
    ];

    status.innerText = "📺 Categorías y Canales Sugeridos:";
    list.innerHTML = `
      <p style="grid-column: 1/-1; font-size: 0.7rem; color: var(--text-muted); margin-top: 10px;">Iconos de Categoría (Para canales manuales):</p>
      ${categories.map(c => `
        <div class="tmdb-item" onclick="window.suggestImage('${c.img}')" style="min-width: 80px; background: rgba(255,255,255,0.05); padding: 5px; border-radius: 8px;">
          <img src="${c.img}" style="width: 100%; height: 50px; object-fit: cover; border-radius: 4px;">
          <p style="font-size: 0.6rem; text-align: center; margin-top: 5px;">${c.name}</p>
        </div>
      `).join('')}
      <p style="grid-column: 1/-1; font-size: 0.7rem; color: var(--text-muted); margin-top: 10px;">Canales Peruanos:</p>
      ${peruvianChannels.map(ch => `
        <div style="background: rgba(255,255,255,0.05); padding: 8px; border-radius: 8px; display: flex; align-items: center; gap: 8px; border: 1px solid var(--glass-border);">
          <img src="${ch.img}" style="width: 35px; height: 35px; object-fit: contain; background: white; padding: 2px; border-radius: 4px;">
          <div style="flex: 1; overflow: hidden;">
            <p style="font-size: 0.7rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: bold;">${ch.name}</p>
            <button onclick="window.quickSeedManual(${JSON.stringify(ch).replace(/"/g, '&quot;')}, 'live')" style="background: #2ECC71; border: none; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.6rem; cursor: pointer;">➕ Sembrar</button>
          </div>
        </div>
      `).join('')}
    `;
    return;
  }

  try {
    const isTv = topic === 'tv' || topic === 'series';
    let url = `${TMDB_URL}/discover/${isTv ? 'tv' : 'movie'}?api_key=${TMDB_API_KEY}&language=${lang}&sort_by=popularity.desc&page=1`;

    if (year) url += `&${isTv ? 'first_air_date_year' : 'primary_release_year'}=${year}`;
    if (genre) url += `&with_genres=${genre}`;

    const res = await fetch(url);
    const data = await res.json();

    const existingIds = new Set(movieDatabase.trending.map(m => m.tmdbId));
    const newItems = data.results.filter(s => !existingIds.has(s.id.toString()));

    if (newItems.length === 0) {
      status.innerText = "🍃 No hay nada nuevo por aquí con esos filtros.";
      return;
    }

    status.innerText = `💡 Toca para sembrar (Mostrando ${newItems.length} nuevas):`;
    list.innerHTML = newItems.slice(0, 12).map(s => `
      <div style="background: rgba(255,255,255,0.05); padding: 8px; border-radius: 8px; display: flex; align-items: center; gap: 8px; border: 1px solid var(--glass-border);">
        <img src="${TMDB_IMG_URL + s.poster_path}" style="width: 35px; height: 50px; object-fit: cover; border-radius: 4px;">
        <div style="flex: 1; overflow: hidden;">
          <p style="font-size: 0.75rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: bold;">${s.title || s.name}</p>
          <button onclick="window.quickSeedContent(${JSON.stringify(s).replace(/"/g, '&quot;')}, '${topic}')" style="background: var(--primary); border: none; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.6rem; cursor: pointer;">➕ Sembrar</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    status.innerText = "❌ Error al conectar con TMDB";
  }
}

window.quickSeedContent = async (s, type) => {
  const exists = movieDatabase.trending.find(m => m.tmdbId == s.id);
  if (exists) { alert(`¡"${s.title || s.name}" ya estaba en el jardín!`); return; }

  // Operación IMDB-Latino (v4.6.0): Obtener imdbId heredado
  let imdbId = "";
  try {
    const extResp = await fetch(`${TMDB_URL}/${type === 'movie' ? 'movie' : 'tv'}/${s.id}/external_ids?api_key=${TMDB_API_KEY}`);
    const extData = await extResp.json();
    imdbId = extData.imdb_id || "";
  } catch (e) {
    console.warn("No se pudo obtener IMDB ID para siembra rápida.");
  }

  const toReview = document.getElementById('discover-send-to-review')?.checked;

  const data = {
    title: s.title || s.name,
    img: TMDB_IMG_URL + s.poster_path,
    tmdbId: s.id.toString(),
    imdbId: imdbId,
    embed: "",
    year: (s.release_date || s.first_air_date || "2024").split('-')[0],
    rating: s.vote_average?.toFixed(1) || "8.5",
    type: type,
    lang: document.getElementById('discover-lang')?.value || 'es-MX',
    status: toReview ? 'review' : 'healthy',
    createdAt: Date.now()
  };
  await addDoc(moviesCol, data);
  localStorage.removeItem('selvaflix_full_database');
  localStorage.removeItem('selvaflix_cache_timestamp');
  alert("¡Sembrado con éxito! 🌴");
};

// quickSeedManual consolidada más abajo

window.openMassSeedModal = () => {
  const modal = document.getElementById('mass-seed-modal');
  if (modal) modal.style.display = 'flex';
  window.loadRecommendedMix(); // Al abrir, mostrar algo listo para sembrar sin tener que buscar
};

window.closeMassSeedModal = () => {
  const modal = document.getElementById('mass-seed-modal');
  if (modal) modal.style.display = 'none';
};

const DUB_LABELS = { 'es-MX': 'Latino', 'es-ES': 'España', 'en-US': 'Inglés' };

// TMDB devuelve el título en japonés/chino/coreano nativo cuando no tiene
// traducción para el idioma pedido (pasa seguido con anime de nicho). Si el
// título trae escritura no latina, pedimos el título en inglés como rescate:
// casi siempre existe una versión romanizada en TMDB aunque no haya en latino.
const CJK_REGEX = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;

async function rescatarTituloLatino(rawTitle, endpoint, tmdbId) {
  if (!rawTitle || !CJK_REGEX.test(rawTitle)) return rawTitle;
  try {
    const res = await fetch(`${TMDB_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`);
    const d = await res.json();
    const enTitle = d.title || d.name;
    if (enTitle && !CJK_REGEX.test(enTitle)) return enTitle;
  } catch (e) { /* sin rescate posible, seguimos con el original */ }
  return rawTitle;
}

// Caché SOLO para el descubrimiento de Carga Masiva (candidatos nuevos de
// TMDB, no del catálogo ya sembrado): "Solo Vimeus" vuelve a preguntar por
// los mismos títulos populares en cada búsqueda porque TMDB casi siempre
// devuelve el mismo top. Con esto, la 2da búsqueda no repregunta lo que ya
// se sabe. Ojo: esto NO se usa en la auditoría de enlaces del catálogo
// existente (vimeusTieneTitulo / tieneAlgunaFuente) — esa necesita siempre
// el estado real y en vivo para detectar enlaces rotos o recién arreglados.
const VIMEUS_DISCOVERY_CACHE_KEY = 'selva_vimeus_discovery_cache';
const VIMEUS_DISCOVERY_CACHE_TTL = 48 * 60 * 60 * 1000; // 48hs

function _leerCacheVimeusDiscovery() {
  try { return JSON.parse(localStorage.getItem(VIMEUS_DISCOVERY_CACHE_KEY) || '{}'); }
  catch (e) { return {}; }
}

function _guardarCacheVimeusDiscovery(cache) {
  // Poda entradas viejas para que esto no crezca sin límite en localStorage.
  const limite = Date.now() - (VIMEUS_DISCOVERY_CACHE_TTL * 2);
  for (const key in cache) {
    if (cache[key].ts < limite) delete cache[key];
  }
  try { localStorage.setItem(VIMEUS_DISCOVERY_CACHE_KEY, JSON.stringify(cache)); }
  catch (e) { /* localStorage lleno o bloqueado: no es crítico, sigue sin cachear */ }
}

// Se usa para el distintivo de la Carga Masiva. Reutiliza vimeusEstadoTitulo
// (mismo chequeo que usa el player real) en vez de un fetch propio, para no
// repetir la lógica y para detectar también el caso "Vimeus Fantasma".
async function chequearVimeusDisponible(tmdbId, tipo) {
  const tipoVimeus = tipo === 'anime' ? 'anime' : ((tipo === 'series' || tipo === 'tv') ? 'serie' : 'movie');
  const key = `${tipoVimeus}:${tmdbId}`;

  const cache = _leerCacheVimeusDiscovery();
  const cacheado = cache[key];
  if (cacheado && (Date.now() - cacheado.ts) < VIMEUS_DISCOVERY_CACHE_TTL) {
    return cacheado.disponible;
  }

  const disponible = await vimeusTieneTitulo(tmdbId, null, tipoVimeus);
  cache[key] = { disponible, ts: Date.now() };
  _guardarCacheVimeusDiscovery(cache);
  return disponible;
}

// Completa s.disponibleVimeus para los items de pendingSeeds que todavia no
// lo tengan, en tandas (no todo junto de una: la Carga Masiva puede traer
// cientos de items, y bombardear a Vimeus de golpe no es buena idea).
async function marcarDisponibilidadVimeus(items) {
  const pendientes = items.filter(s => s.disponibleVimeus === undefined);
  const TANDA = 15;
  for (let i = 0; i < pendientes.length; i += TANDA) {
    const tanda = pendientes.slice(i, i + TANDA);
    await Promise.all(tanda.map(async (s) => {
      s.disponibleVimeus = await chequearVimeusDisponible(s.tmdbId, s.type);
    }));
  }
}

// Pinta la grilla de checkboxes de "pendingSeeds" en el contenedor dado.
// Compartida entre massSeedMovies y loadRecommendedMix para no duplicar el template.
// Re-renderizamos esta lista dos veces (antes y después de chequear Vimeus,
// ver marcarDisponibilidadVimeus): si el usuario desmarcó algo en el medio,
// el segundo render no debe pisarle esa elección y volver a tildar todo.
function guardarEstadoChecks(list) {
  list.querySelectorAll('.seed-check').forEach(chk => {
    const idx = Number(chk.dataset.idx);
    if (pendingSeeds[idx]) pendingSeeds[idx].selected = chk.checked;
  });
}

// Si el admin marcó "Solo Vimeus" (#chk-solo-vimeus), descarta de pendingSeeds
// todo lo que no venga confirmado por Vimeus (mismo criterio que "Fuentes
// externas" en el buscador de un solo título). Se llama después de
// marcarDisponibilidadVimeus, cuando s.disponibleVimeus ya está resuelto.
function aplicarFiltroSoloVimeus(status, confirmBtn) {
  if (!document.getElementById('chk-solo-vimeus')?.checked) return;

  pendingSeeds = pendingSeeds.filter(s => s.disponibleVimeus);

  if (pendingSeeds.length === 0) {
    if (status) status.innerText = '🍃 Ninguno de estos títulos está confirmado en Vimeus todavía. Desmarca "Solo Vimeus" para ver el resto, o prueba con otra página/filtro.';
    if (confirmBtn) confirmBtn.style.display = 'none';
  } else {
    if (status) status.innerText = `✅ ${pendingSeeds.length} confirmados en Vimeus. Desmarca los que no quieras:`;
    if (confirmBtn) confirmBtn.innerText = `✅ Sembrar ${pendingSeeds.length} Coconas`;
  }
}

function renderSeedList(list) {
  list.innerHTML = pendingSeeds.map((s, idx) => {
    const tieneVoe = s.embed && s.embed.includes('voe');
    const distintivo = tieneVoe
      ? `<span style="display:inline-block; margin-top:2px; padding:1px 6px; border-radius:4px; background:rgba(255,102,0,0.25); color:#FF6600; font-size:0.58rem; font-weight:700;">🔥 VOE.sx</span>`
      : (s.disponibleVimeus
          ? `<span style="display:inline-block; margin-top:2px; padding:1px 6px; border-radius:4px; background:rgba(46,204,113,0.15); color:#2ECC71; font-size:0.58rem; font-weight:700;">✅ VIMEUS</span>`
          : `<span style="display:inline-block; margin-top:2px; padding:1px 6px; border-radius:4px; background:rgba(0,242,255,0.12); color:#00f2ff; font-size:0.58rem; font-weight:700;">🔗 RESPALDO</span>`);

    const marcado = s.selected !== false ? 'checked' : '';
    return `
    <div style="background: rgba(255,255,255,0.05); padding: 8px; border-radius: 8px; display: flex; align-items: center; gap: 8px; border: 1px solid var(--glass-border);">
      <input type="checkbox" ${marcado} class="seed-check" data-idx="${idx}" onchange="window.updateSeedCount()">
      <img src="${s.img}" style="width: 35px; height: 50px; object-fit: cover; border-radius: 4px;" onerror="this.src='https://via.placeholder.com/35x50?text=IMG'">
      <div style="flex: 1; overflow: hidden;">
        <p style="font-size: 0.7rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: bold; color:white;">${s.title}</p>
        <p style="font-size: 0.6rem; color: var(--text-muted);">${s.year} · ${s.type} · ${DUB_LABELS[s.lang] || s.lang}</p>
        ${distintivo}
      </div>
    </div>
  `;
  }).join('');
}

// Mezcla inicial (películas + series + anime más populares) para que el modal
// tenga algo listo para sembrar apenas se abre, sin necesidad de buscar nada.
window.loadRecommendedMix = async () => {
  const list = document.getElementById('discover-list');
  const status = document.getElementById('discover-status');
  const container = document.getElementById('discover-container');
  const confirmBtn = document.getElementById('btn-confirm-mass-seed');
  if (!list || !status || !container || !confirmBtn) return;

  container.style.display = 'block';
  confirmBtn.style.display = 'none';
  status.innerText = '🔍 Cargando recomendados (películas, series y anime)...';
  pendingSeeds = [];

  // Si el admin entra y abre el modal apenas carga la página, esperar a que
  // termine la carga real del catálogo: si no, movieDatabase.trending puede
  // estar vacío todavía y todo lo ya sembrado se ofrece de nuevo como "nuevo".
  if (window.selvaFlixDataReady) { try { await window.selvaFlixDataReady; } catch (e) {} }

  const existingIds = new Set(
    movieDatabase.trending.filter(m => m.tmdbId != null).map(m => String(m.tmdbId))
  );
  const lang = document.getElementById('discover-lang')?.value || 'es-MX';
  // Página fija (siempre la 1) hacía que, una vez sembrados los ~20 títulos
  // más populares de cada tipo, la lista de recomendados quedara seca para
  // siempre ("no trae nada nuevo"). Rotar entre las páginas 1-5 en cada
  // apertura del modal da variedad real en vez de repetir el mismo tope.
  const randomPage = () => 1 + Math.floor(Math.random() * 5);
  // Antes siempre era "más populares" (popularity.desc), que con el tiempo
  // termina siendo siempre lo mismo taquillero. Alternamos con "aclamados
  // por la crítica" (vote_average.desc) para traer variedad real. Sin un
  // piso de votos, vote_average.desc de TMDB devuelve rarezas con 2 votos y
  // 10.0 de nota en vez de películas realmente bien calificadas.
  const randomSort = (endpoint) => {
    const porCritica = Math.random() < 0.5;
    if (!porCritica) return { sortBy: 'popularity.desc', extra: '' };
    const minVotos = endpoint === 'movie' ? 200 : 50; // series/anime acumulan menos votos en TMDB
    return { sortBy: 'vote_average.desc', extra: `&vote_count.gte=${minVotos}` };
  };
  const sources = [
    { type: 'movie', endpoint: 'movie', extra: '', page: randomPage() },
    { type: 'series', endpoint: 'tv', extra: '', page: randomPage() },
    { type: 'anime', endpoint: 'tv', extra: '&with_genres=16&with_original_language=ja', page: randomPage() },
  ].map(src => {
    const { sortBy, extra: sortExtra } = randomSort(src.endpoint);
    return { ...src, sortBy, extra: src.extra + sortExtra };
  });

  try {
    for (const src of sources) {
      const url = `${TMDB_URL}/discover/${src.endpoint}?api_key=${TMDB_API_KEY}&language=${lang}&sort_by=${src.sortBy}&page=${src.page}${src.extra}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      for (const s of (data.results || [])) {
        const tmdbIdStr = String(s.id);
        if (!existingIds.has(tmdbIdStr) && (s.poster_path || s.backdrop_path)) {
          const rawTitle = s.title || s.name || 'Sin título';
          pendingSeeds.push({
            title: await rescatarTituloLatino(rawTitle, src.endpoint, tmdbIdStr),
            original_title: s.original_title || s.original_name || '',
            img: TMDB_IMG_URL + (s.poster_path || s.backdrop_path),
            tmdbId: tmdbIdStr,
            year: (s.release_date || s.first_air_date || '2024').split('-')[0],
            rating: s.vote_average?.toFixed(1) || '7.5',
            genres: (s.genre_ids || []).map(String),
            type: src.type,
            lang: lang
          });
          existingIds.add(tmdbIdStr); // no repetir el mismo id si aparece en más de una fuente
        }
      }
    }

    if (pendingSeeds.length === 0) {
      status.innerText = '🍃 No hay recomendaciones nuevas ahora mismo. Prueba los filtros y botones de abajo.';
      return;
    }

    confirmBtn.style.display = 'block';
    confirmBtn.innerText = `✅ Sembrar ${pendingSeeds.length} Coconas`;
    const soloVimeus1 = document.getElementById('chk-solo-vimeus')?.checked;
    if (soloVimeus1) {
      // Con el filtro activo no pintamos la lista cruda (saldría todo con el
      // badge RESPALDO provisional y luego se encogería de golpe cuando
      // termine de chequear) — mejor esperar a tener el resultado real.
      status.innerText = `🔎 Verificando cuáles de los ${pendingSeeds.length} títulos están en Vimeus...`;
      list.innerHTML = '';
    } else {
      status.innerText = `✨ ${pendingSeeds.length} recomendados para empezar (pelis + series + anime). Desmarca lo que no quieras, o busca algo específico con los botones de abajo:`;
      renderSeedList(list); // primero sin distintivo, para no hacer esperar la lista
    }
    await marcarDisponibilidadVimeus(pendingSeeds);
    if (!soloVimeus1) guardarEstadoChecks(list); // por si el usuario ya desmarcó algo mientras se chequeaba
    aplicarFiltroSoloVimeus(status, confirmBtn);
    renderSeedList(list); // y de nuevo ya con "VIMEUS"/"RESPALDO" resuelto
  } catch (err) {
    console.error('Error cargando recomendados:', err);
    status.innerText = `❌ Error cargando recomendados: ${err.message}`;
  }
};

window.massSeedMovies = async (contentType) => {
  const type = contentType || document.getElementById('m-type').value || 'movie';
  const pages = parseInt(document.getElementById('mass-seed-amount').value) || 1;
  const year = document.getElementById('discover-year').value;
  const genre = document.getElementById('discover-genre').value;
  const lang = document.getElementById('discover-lang')?.value || 'es-MX';
  const list = document.getElementById('discover-list');
  const status = document.getElementById('discover-status');
  const container = document.getElementById('discover-container');
  const confirmBtn = document.getElementById('btn-confirm-mass-seed');

  if (!list || !status || !container || !confirmBtn) {
    console.error('Faltan elementos del DOM para la siembra');
    if (window.showToast) {
        window.showToast("❌ Error interno: recarga la página e inténtalo de nuevo.", "error");
    } else {
        console.error('Faltan elementos del DOM para la siembra');
    }
    return;
  }

  container.style.display = 'block';
  confirmBtn.style.display = 'none';
  pendingSeeds = [];

  // Mismo caso que en los recomendados: si el catálogo real todavía no
  // terminó de cargar, existingIds sale incompleto y lo ya sembrado se
  // vuelve a ofrecer como si fuera nuevo.
  if (window.selvaFlixDataReady) { try { await window.selvaFlixDataReady; } catch (e) {} }

  // Comparación robusta: acepta tmdbId como string o number
  const existingIds = new Set(
    movieDatabase.trending
      .filter(m => m.tmdbId != null)
      .map(m => String(m.tmdbId))
  );

  const isTv = type === 'series' || type === 'anime' || type === 'tv';
  const endpoint = isTv ? 'tv' : 'movie';
  const soloVimeusBusqueda = document.getElementById('chk-solo-vimeus')?.checked;
  // Con "Solo Vimeus" activo la mayoría de lo que trae TMDB se descarta, así
  // que 1-2 páginas casi siempre dan 0 resultados. En vez de rendirse ahí,
  // seguimos pidiendo páginas extra hasta juntar una tanda razonable de
  // confirmados (o agotar el límite de seguridad), chequeando Vimeus página
  // por página en vez de esperar al final.
  const maxExtraAttempts = soloVimeusBusqueda ? 20 : 5;
  const targetVimeusConfirmados = pages * 15;
  let pagesSearched = 0;
  let totalPagesTried = 0;
  let vimeusConfirmados = 0;

  try {
    // Buscamos las páginas pedidas, y si todas están duplicadas (o filtradas
    // por Vimeus) probamos más automáticamente
    for (
      let attempt = 0;
      (soloVimeusBusqueda ? vimeusConfirmados < targetVimeusConfirmados : pagesSearched < pages) && attempt < pages + maxExtraAttempts;
      attempt++
    ) {
      const pageNum = attempt + 1;
      status.innerText = soloVimeusBusqueda
        ? `🔍 Buscando página ${pageNum}... (${vimeusConfirmados} confirmados en Vimeus hasta ahora)`
        : `🔍 Buscando página ${pageNum}... (${pendingSeeds.length} nuevas encontradas)`;

      const sortBy = document.getElementById('discover-sort')?.value || 'popularity.desc';
      let url = `${TMDB_URL}/discover/${endpoint}?api_key=${TMDB_API_KEY}&language=${lang}&sort_by=${sortBy}&page=${pageNum}`;
      // Sin piso de votos, "Mejor calificadas" de TMDB trae rarezas con 1-2
      // votos y nota 10.0 en vez de títulos realmente aclamados por la crítica.
      if (sortBy === 'vote_average.desc') url += `&vote_count.gte=${isTv ? 50 : 200}`;
      if (year && year !== '') url += `&${isTv ? 'first_air_date_year' : 'primary_release_year'}=${year}`;

      // 🇯🇵 "Anime" no existe como tipo en TMDB: sin este filtro devuelve las mismas
      // series populares que "Buscar Series" (Colbert, C.I.D, etc.) con la etiqueta
      // cambiada. Si el admin no eligió género/idioma manualmente, forzamos
      // Animación (16) + idioma original japonés para que de verdad traiga anime.
      const finalGenre = (type === 'anime' && !genre) ? '16' : genre;
      const origLang = document.getElementById('discover-orig-lang')?.value || '';
      const finalOrigLang = (type === 'anime' && !origLang) ? 'ja' : origLang;

      if (finalGenre && finalGenre !== '') url += `&with_genres=${finalGenre}`;
      if (finalOrigLang !== '') url += `&with_original_language=${finalOrigLang}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`TMDB respondió con error ${res.status}`);
      const data = await res.json();
      totalPagesTried++;

      if (!data.results || data.results.length === 0) break; // No hay más páginas

      let foundNew = 0;
      const nuevosDeEstaPagina = [];
      for (const s of data.results) {
        const tmdbIdStr = String(s.id);
        if (!existingIds.has(tmdbIdStr) && (s.poster_path || s.backdrop_path)) {
          const rawTitle = s.title || s.name || 'Sin título';
          const seed = {
            title: await rescatarTituloLatino(rawTitle, endpoint, tmdbIdStr),
            original_title: s.original_title || s.original_name || "",
            img: TMDB_IMG_URL + (s.poster_path || s.backdrop_path),
            tmdbId: tmdbIdStr,
            year: (s.release_date || s.first_air_date || '2024').split('-')[0],
            rating: s.vote_average?.toFixed(1) || '7.5',
            genres: (s.genre_ids || []).map(String),
            type: type,
            lang: lang
          };
          pendingSeeds.push(seed);
          nuevosDeEstaPagina.push(seed);
          foundNew++;
          // TMDB "discover" puede repetir el mismo título en dos páginas
          // distintas (empates de popularidad, orden que se corre entre
          // pedidos). Sin marcarlo acá, existingIds solo sabía de lo que ya
          // estaba en Firebase y la misma peli se agregaba dos veces a
          // pendingSeeds -> dos checkboxes -> dos docs duplicados al sembrar.
          existingIds.add(tmdbIdStr);
        }
      }

      // Chequeamos Vimeus página por página (no al final) para saber si ya
      // alcanza o hace falta pedir otra página más.
      if (soloVimeusBusqueda && nuevosDeEstaPagina.length > 0) {
        status.innerText = `🔎 Verificando Vimeus en la página ${pageNum}... (${vimeusConfirmados} confirmados hasta ahora)`;
        await marcarDisponibilidadVimeus(nuevosDeEstaPagina);
        vimeusConfirmados = pendingSeeds.filter(s => s.disponibleVimeus).length;
      }

      if (foundNew > 0) pagesSearched++; // Solo contamos páginas que aportaron algo nuevo
    }

    list.innerHTML = '';

    if (pendingSeeds.length === 0) {
      status.innerHTML = `
        <span>🍃 Todas las películas populares de TMDB ya están en tu base de datos.</span><br>
        <span style="font-size:0.7rem; color: var(--text-muted);">Prueba cambiando el <b>año</b> o el <b>género</b> para encontrar contenido nuevo.</span>
      `;
      return;
    }

    confirmBtn.style.display = 'block';
    confirmBtn.innerText = `✅ Sembrar ${pendingSeeds.length} Coconas`;
    const soloVimeus2 = document.getElementById('chk-solo-vimeus')?.checked;
    if (soloVimeus2) {
      status.innerText = `🔎 Verificando cuáles de los ${pendingSeeds.length} títulos están en Vimeus...`;
      list.innerHTML = '';
    } else {
      status.innerText = `✅ ¡${pendingSeeds.length} coconas nuevas! Desmarca las que no quieras:`;
      renderSeedList(list); // primero sin distintivo, para no hacer esperar la lista
    }
    await marcarDisponibilidadVimeus(pendingSeeds);
    if (!soloVimeus2) guardarEstadoChecks(list); // por si el usuario ya desmarcó algo mientras se chequeaba
    aplicarFiltroSoloVimeus(status, confirmBtn);
    renderSeedList(list); // y de nuevo ya con "VIMEUS"/"RESPALDO" resuelto

  } catch (err) {
    console.error('Error en massSeedMovies:', err);
    status.innerHTML = `
      <span style="color:#E74C3C;">❌ Error: ${err.message}</span><br>
      <span style="font-size:0.7rem; color:var(--text-muted);">Verifica tu conexión e inténtalo de nuevo.</span>
    `;
  }
};

window.updateSeedCount = () => {
  const checked = document.querySelectorAll('.seed-check:checked').length;
  const btn = document.getElementById('btn-confirm-mass-seed');
  if (btn) {
    btn.innerText = `✅ Sembrar ${checked} Coconas seleccionadas`;
    btn.style.display = checked > 0 ? 'block' : 'none';
  }
};

window.confirmBatchSeed = async () => {
  const checks = document.querySelectorAll('.seed-check:checked');
  if (checks.length === 0) return;

  const confirmed = confirm(`¿Sembrar estas ${checks.length} coconas ahora? 🚜🌴`);
  if (!confirmed) return;

  const overlay = document.getElementById('delete-progress-overlay');
  const bar = document.getElementById('progress-bar-fill');
  const text = document.getElementById('progress-percent');
  const statusText = document.getElementById('progress-text');

  if (statusText) statusText.innerText = "Sembrando nuevas Coconas... 🌴✨";
  if (overlay) overlay.style.display = 'flex';

  let count = 0;
  for (const ch of checks) {
    const idx = ch.dataset.idx;
    const s = pendingSeeds[idx];

    // Operación IMDB-Latino (v4.6.0): Obtener imdbId heredado
    let imdbId = "";
    try {
      const extResp = await fetch(`${TMDB_URL}/${s.type === 'movie' ? 'movie' : 'tv'}/${s.tmdbId}/external_ids?api_key=${TMDB_API_KEY}`);
      const extData = await extResp.json();
      imdbId = extData.imdb_id || "";
    } catch (e) {
      console.warn(`No se pudo obtener IMDB ID para ${s.title}`);
    }

    const toReview = document.getElementById('discover-send-to-review')?.checked;

    // s.disponibleVimeus es el nombre que usa el chequeo de Carga Masiva
    // (chequearVimeusDisponible); el resto de la app (auditoría "Revisar
    // Enlaces", stats del catálogo, badge "ÓPTIMO" en las tarjetas) usa
    // vimeusDisponible. Sin este mapeo, lo sembrado acá quedaba con el campo
    // "equivocado" y nunca se veía como confirmado en Vimeus.
    const mData = {
      ...s,
      imdbId: imdbId,
      embed: "",
      status: toReview ? 'review' : 'healthy',
      vimeusDisponible: s.disponibleVimeus,
      createdAt: Date.now()
    };
    delete mData.disponibleVimeus;
    delete mData.selected;
    try {
      const ref = await addDoc(moviesCol, mData);
      // Mismo caso que en sincronizarCatalogoVimeus: el listener en vivo
      // suele ganar la carrera y ya la agregó solo — empujar de nuevo sin
      // chequear duplicaba la fila en la tabla (visible al toque, no hacía
      // falta esperar nada para notarlo).
      const idxYaEmpujadoBatch = movieDatabase.trending.findIndex(m => m.id === ref.id);
      if (idxYaEmpujadoBatch === -1) movieDatabase.trending.push({ id: ref.id, ...mData }); // Reflejar en memoria sin esperar un reload
      else movieDatabase.trending[idxYaEmpujadoBatch] = { id: ref.id, ...mData };
      collectUserData("manual_seed", { title: s.title, type: s.type });
      count++;
      const percent = Math.round((count / checks.length) * 100);
      if (bar) bar.style.width = `${percent}%`;
      if (text) text.innerText = `${percent}% (${count}/${checks.length})`;
    } catch (e) {
      console.error("Error sembrando:", e);
    }
  }

  localStorage.removeItem('selvaflix_full_database');
  localStorage.removeItem('selvaflix_cache_timestamp');

  if (overlay) overlay.style.display = 'none';
  if (window.showToast) {
    window.showToast(`✅ ¡Siembra masiva completada! ${count} elementos añadidos. 🌴🍿`, "success");
  }
  document.getElementById('discover-container').style.display = 'none';

  // Refrescar la tabla del Catálogo si está abierta, para ver lo recién sembrado sin recargar
  if (document.getElementById('admin-view')?.style.display === 'block') renderInventory();
};


async function updateHeroCarousel() {
  if (!heroPool || heroPool.length === 0) return;
  if (_isSearchActive) return; // no reaparecer el banner mientras hay una búsqueda activa
  const section = document.getElementById('hero-section');
  if (!section) return;

  const item = heroPool[currentHeroIndex % heroPool.length];
  if (!item) return;

  // Buscar backdrop: si no tiene, lo busca de TMDB al vuelo
  let heroImg = item.backdrop || item.img;
  
  if (!item.backdrop && item.tmdbId) {
    try {
      // Determinar si es serie o película (anime cuenta como serie en TMDB: endpoint /tv)
      const type = item.type === 'series' || item.type === 'tv' || item.type === 'anime' ? 'tv' : 'movie';
      const res = await fetch(`${TMDB_URL}/${type}/${item.tmdbId}?api_key=${TMDB_API_KEY}&language=es-MX`);
      const data = await res.json();
      if (data.backdrop_path) {
        heroImg = `https://image.tmdb.org/t/p/original${data.backdrop_path}`;
        // Actualizamos el item en memoria para la próxima rotación
        item.backdrop = heroImg;
      }
    } catch (e) {
      console.warn('No se pudo cargar backdrop para', item.title, e.message);
    }
  }
  
  const isFavorite = window._myListIds && window._myListIds.has(item.id);
  
  section.style.display = 'flex';
  section.classList.add('cinepulse-hero');
  
  const heroBg = document.getElementById('cinepulse-hero-img');
  const heroTitle = document.getElementById('cinepulse-hero-title');
  const heroDesc = document.getElementById('cinepulse-hero-desc');
  const heroRating = document.getElementById('cinepulse-hero-rating-value');
  const heroYear = document.getElementById('cinepulse-hero-year');
  const heroBadge = document.getElementById('cinepulse-hero-badge');
  const heroPlay = document.getElementById('cinepulse-hero-play');
  const heroList = document.getElementById('cinepulse-hero-list');
  
  if (heroBg) heroBg.src = heroImg;
  if (heroTitle) heroTitle.textContent = item.title;
  if (heroDesc) heroDesc.textContent = item.description || item.overview || 'Descubre esta increíble película disponible solo en SelvaFlix.';
  if (heroRating) heroRating.textContent = item.rating || '8.9';
  if (heroYear) heroYear.textContent = item.year || '2024';
  
  if (heroBadge) {
    if (item.pinned || (item.createdAt && Date.now() - item.createdAt < 7 * 24 * 60 * 60 * 1000)) {
      heroBadge.style.display = 'inline-flex';
    } else {
      heroBadge.style.display = 'none';
    }
  }
  
  if (heroPlay) {
    heroPlay.onclick = (e) => {
      e.stopPropagation();
      window.handleCardClick(item.id);
    };
  }
  
  if (heroList) {
    heroList.onclick = (e) => {
      e.stopPropagation();
      window.toggleMyList(item.id, heroList);
    };
    
    const isFav = window._myListIds && window._myListIds.has(item.id);
    heroList.innerHTML = isFav 
      ? '<span class="material-symbols-outlined" style="font-variation-settings: \'FILL\' 1;">check</span> En Mi Lista'
      : '<span class="material-symbols-outlined">add</span> Mi Lista';
  }
}

function startHeroAutoRotation() {
  if (heroTimer) clearInterval(heroTimer);
  heroTimer = setInterval(() => {
    if (_isSearchActive) return;
    if (heroPool.length > 3) {
      currentHeroIndex = (currentHeroIndex + 1) % heroPool.length;
      const section = document.getElementById('hero-section');
      if (section) {
        section.style.opacity = '0.5';
        updateHeroCarousel(); // Ya es async internamente
        setTimeout(() => {
          section.style.opacity = '1';
        }, 500);
      }
    }
  }, 10000); // Rota cada 10 segundos
}

function renderSkeletons() {
  const container = document.getElementById('main-content');
  if (!container) return;
  container.innerHTML = `
    <div class="skeleton-row">
      <div class="skeleton-title"></div>
      <div style="display:flex; gap:15px; overflow:hidden;">
        ${'<div class="skeleton-card"></div>'.repeat(6)}
      </div>
    </div>
    <div class="skeleton-row">
      <div class="skeleton-title"></div>
      <div style="display:flex; gap:15px; overflow:hidden;">
        ${'<div class="skeleton-card"></div>'.repeat(6)}
      </div>
    </div>
  `;
}

function initApp(filterType = '', genreId = '', year = '') {
  if (!movieDatabase.trending.length) return;

  const container = document.getElementById('main-content');
  if (container) {
    container.innerHTML = '';
    renderSkeletons(); // Flash visual instantáneo
  }
  poblarFiltroAnios();

  // --- NUCLEAR CLEANUP (v2.29) ---
  // Hacemos desaparecer lo que el cache del HTML se niega a soltar
  const elementsToHide = [
    'filter-live',             // Boton en la barra principal
    'btn-discover-live',       // Boton en admin
    'nav-live-tv'              // Posible nav link
  ];
  elementsToHide.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
          console.log(`🧹 Nuclear Cleanup: Ocultando ${id}`);
          el.style.display = 'none';
          el.remove(); // Directamente al basurero de la selva
      }
  });

  // Limpiar selects (m-type y inventory-type-filter)
  ['m-type', 'inventory-type-filter'].forEach(id => {
      const sel = document.getElementById(id);
      if (sel) {
          const opt = sel.querySelector('option[value="live"]');
          if (opt) {
              console.log(`🧹 Nuclear Cleanup: Borrando "live" de ${id}`);
              opt.remove();
          }
      }
  });
  
  // Limpiar stats de admin
  const liveStat = document.getElementById('count-live')?.parentElement;
  if (liveStat && liveStat.innerText.includes('Live')) {
      liveStat.style.display = 'none';
  }

  // Actividad: Vista de página
  collectUserData("page_view", { page: filterType || 'home' });

  // ORDEN INTELIGENTE: Salud -> Fecha de Creación
  const esRoto = (c) => c.status === 'broken' || window._brokenIds.has(c.id);
  let allContent = [...movieDatabase.trending].sort((a, b) => {
    const healthA = esRoto(a) ? 0 : 1;
    const healthB = esRoto(b) ? 0 : 1;
    if (healthA !== healthB) return healthB - healthA;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  // 🔒 Ocultar "En Revisión" del público - solo visibles en el panel Admin
  const isAdmin = localStorage.getItem('selva_admin_auth') === 'true';
  if (!isAdmin) {
    allContent = allContent.filter(c => c.status !== 'review');
  }

  // Apply genre filter if set (genre stored as array or single string in item.genres)
  if (genreId && genreId !== 'all') {
    allContent = allContent.filter(c => {
      const g = c.genres || c.genre_ids || [];
      const genreList = Array.isArray(g) ? g.map(String) : [String(g)];
      return genreList.includes(String(genreId));
    });
  }

  // Apply year filter if set
  if (year && year !== '') {
    allContent = allContent.filter(c => String(c.year) === String(year));
  }

  // --- Motor Hero Elite Algorithm v2.40 ---
  let heroPoolRaw = allContent.filter(c => !esRoto(c));
  
  if (filterType === 'series') {
    heroPoolRaw = heroPoolRaw.filter(c => c.type === 'series' || c.type === 'tv');
  } else if (filterType === 'movies') {
    heroPoolRaw = heroPoolRaw.filter(c => c.type === 'movie' || !c.type);
  } else if (filterType === 'anime') {
    heroPoolRaw = heroPoolRaw.filter(c => c.type === 'anime');
  }

  // Prioridad: 1. Pinned (Fijados) | 2. Taquilleras (Rating/Trends) | 3. Latest (createdAt)
  const playCounts = JSON.parse(localStorage.getItem('selva_play_counts') || '{}');
  
  heroPool = heroPoolRaw.sort((a, b) => {
    // 1. Pinned (Máxima prioridad manual)
    const pinA = a.pinned ? 1 : 0;
    const pinB = b.pinned ? 1 : 0;
    if (pinA !== pinB) return pinB - pinA;

    // 2. Taquilleras (Rating alto + Algo de tracción local)
    const ratingA = parseFloat(a.rating || 0);
    const ratingB = parseFloat(b.rating || 0);
    const playsA = playCounts[a.tmdbId] || playCounts[a.id] || 0;
    const playsB = playCounts[b.tmdbId] || playCounts[b.id] || 0;
    
    // Si tiene rating superior a 8 y al menos un play, es taquillera
    const isHotA = (ratingA >= 8.0 && playsA > 0) ? 1 : 0;
    const isHotB = (ratingB >= 8.0 && playsB > 0) ? 1 : 0;
    if (isHotA !== isHotB) return isHotB - isHotA;

    // 3. Estrenos / Lo más nuevo
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  // Limitamos el pool de rotación para que sea "Elite"
  heroPool = heroPool.slice(0, filterType ? 10 : 15);

  // Hero Carousel Priority (v2.40)
  const heroSection = document.getElementById('hero-section');
  if (heroPool.length > 0) {
    if (heroSection) {
        heroSection.style.display = 'flex';
        heroSection.style.minHeight = window.innerWidth <= 768 ? '300px' : '550px';
    }
    // Cargar backdrop inicial antes de mostrar
    (async () => {
      await updateHeroCarousel();
    })();
  } else {
    // Si no hay series/anime en el hero, intentamos poner peliculas destacadas para no dejar el hueco
    if (filterType === 'series' || filterType === 'anime') {
        const fallbackPool = allContent.filter(c => !esRoto(c) && (c.type === 'movie' || !c.type)).slice(0, 3);
        if (fallbackPool.length > 0 && heroSection) {
            heroPool = fallbackPool; 
            heroSection.style.display = 'flex';
            updateHeroCarousel();
        } else if (heroSection) {
            heroSection.style.display = 'none';
        }
    } else if (heroSection) {
        heroSection.style.display = 'none';
    }
  }

  // Rows / Gallery based on filter
  if (filterType === 'movies') {
    const movies = allContent.filter(c => c.type === 'movie' || !c.type);
    if (movies.length > 0) {
      renderGallery('Películas', [{ label: `Películas${genreId ? ' · filtradas' : ''}`, items: movies }]);
    } else {
      if (container) container.innerHTML = '<p style="padding:80px;text-align:center;color:var(--text-muted);">No hay películas con ese filtro</p>';
    }

  } else if (filterType === 'series') {
    const series = allContent.filter(c => c.type === 'series' || c.type === 'tv');
    if (series.length > 0) {
      renderGallery('Series', [{ label: `Series${genreId ? ' · filtradas' : ''}`, items: series }]);
    } else {
      if (container) container.innerHTML = '<p style="padding:80px;text-align:center;color:var(--text-muted);">No hay series con ese filtro</p>';
    }

  } else if (filterType === 'anime') {
    const anime = allContent.filter(c => c.type === 'anime');
    if (anime.length > 0) {
      renderGallery('Anime', [{ label: `Anime${genreId ? ' · filtrado' : ''}`, items: anime }]);
    } else {
      if (container) container.innerHTML = '<p style="padding:80px;text-align:center;color:var(--text-muted);">Todavía no hay anime en la selva. ⛩️🌴</p>';
    }

  } else if (filterType === 'franquicias') {
    const conFranquicia = allContent.filter(c => c.franchise && c.franchise.trim());
    const nombres = [...new Set(conFranquicia.map(c => c.franchise.trim()))].sort((a, b) => a.localeCompare(b));
    const groups = nombres.map(nombre => ({
      label: nombre,
      items: conFranquicia.filter(c => c.franchise.trim() === nombre)
    }));
    if (groups.length > 0) {
      renderGallery('Franquicias', groups);
    } else {
      if (container) container.innerHTML = '<p style="padding:80px;text-align:center;color:var(--text-muted);">Todavía no hay franquicias armadas en la selva. 🌴</p>';
    }

  } else if (filterType === 'live') {
    // Categoría eliminada
    window.goToHome();
    return;
  } else {
    if (container) container.innerHTML = ''; // Los skeletons cumplieron su misión

    // --- NUEVO ORDEN DE PORTADA (v2.42) ---
    // 1. Recomendadas (La Vieja Confiable: Mix Rating + Popularidad)
    const recommended = [...allContent]
      .map(c => ({ 
        ...c, 
        score: (parseFloat(c.rating || 0)) + (Math.log10((playCounts[c.tmdbId] || playCounts[c.id] || 0) + 1) * 3) 
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    if (recommended.length > 0) renderRow('Recomendadas para ti', recommended);

    // 2. Tendencias en la Selva (Local plays, with fallback to top-rated mixed catalog if no plays yet)
    let popularity = [...allContent]
      .filter(c => c.type !== 'live')
      .map(c => ({ ...c, plays: playCounts[c.tmdbId] || playCounts[c.id] || 0 }))
      .filter(c => c.plays > 0)
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 12);

    // selva_play_counts es solo de ESTE navegador — con pocas reproducciones
    // locales (o recién instalado) la fila se quedaba con 1 o 2 títulos nada
    // más. Se completa con los mejor puntuados del catálogo hasta llegar a
    // 12, sin perder el orden real de lo más reproducido acá arriba.
    if (popularity.length < 12) {
      const yaIncluidos = new Set(popularity.map(c => c.id));
      const relleno = [...allContent]
        .filter(c => c.type !== 'live' && !yaIncluidos.has(c.id))
        .sort((a, b) => parseFloat(b.rating || 0) - parseFloat(a.rating || 0));
      for (const c of relleno) {
        if (popularity.length >= 12) break;
        popularity.push(c);
      }
    }
    if (popularity.length > 0) renderRow('Tendencias en la Selva', popularity);

    // 3. Categorías Estándar
    const movies = allContent.filter(c => c.type === 'movie' || !c.type).slice(0, 12);
    const series = allContent.filter(c => c.type === 'series' || c.type === 'tv').slice(0, 12);
    const anime = allContent.filter(c => c.type === 'anime').slice(0, 12);

    if (movies.length > 0) renderRow('Películas', movies, 'movies');
    if (series.length > 0) renderRow('Series', series, 'series');
    if (anime.length > 0) renderRow('Anime', anime, 'anime');
  }

  // 🚀 Encendido del motor de rotación (al final para liberar el hilo principal)
  if (heroPool.length > 3) {
    startHeroAutoRotation();
  }
}

// function renderChannels removed

window.suggestTVChannels = () => {
  const container = document.getElementById('discover-container');
  const list = document.getElementById('discover-list');
  const status = document.getElementById('discover-status');
  if (!container || !list || !status) return;

  container.style.display = 'block';
  status.innerText = "📺 Canales de TV Sugeridos (Links M3U8 públicos):";

  const suggestions = [
    { title: "Telefe (AR)", img: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Telefe_logo.svg/1200px-Telefe_logo.svg.png", embed: "https://vcp.telefe.com/atv/telefe/telefe.m3u8" },
    { title: "Azteca 7 (MX)", img: "https://upload.wikimedia.org/wikipedia/commons/5/52/TV_Azteca_7_logo.png", embed: "https://d1f8p81k2m2b4y.cloudfront.net/out/v1/98157774fd6e4a6fa83917452d37803d/index.m3u8" },
    { title: "NASA TV", img: "https://www.nasa.gov/wp-content/themes/nasa/assets/images/nasa-logo.svg", embed: "https://ntvpublic.akamaized.net/hls/live/2023153/ntv-public/index.m3u8" }
  ];

  list.innerHTML = suggestions.map(s => `
     <div style="background: rgba(255,255,255,0.05); padding: 8px; border-radius: 8px; display: flex; align-items: center; gap: 8px; border: 1px solid var(--glass-border);">
        <img src="${s.img}" style="width: 40px; height: 40px; object-fit: contain; background:#fff; border-radius: 4px;">
        <div style="flex: 1;">
          <p style="font-size: 0.75rem; font-weight: bold; margin-bottom: 2px;">${s.title}</p>
          <button onclick="window.quickSeedManual(${JSON.stringify(s).replace(/"/g, '&quot;')}, 'live')" style="background: #2ECC71; border: none; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.6rem; cursor: pointer;">➕ Agregar Canal</button>
        </div>
      </div>
  `).join('');
};

window.discoverM3U = async () => {
  const container = document.getElementById('discover-container');
  const list = document.getElementById('discover-list');
  const status = document.getElementById('discover-status');
  if (!container || !list || !status) return;

  container.style.display = 'block';
  status.innerText = "📡 Cargando canales desde GitHub (IPTV-Org Latam)...";
  list.innerHTML = '<p style="grid-column: 1/-1; text-align:center;">🔍 Extrayendo el corazón de los satélites...</p>';

  try {
    const res = await fetch('https://iptv-org.github.io/iptv/regions/latam.m3u');
    const m3uText = await res.text();
    const channels = window.parseM3U(m3uText).slice(0, 100); // Mostramos los primeros 100

    if (channels.length === 0) { status.innerText = "❌ No se encontraron canales válidos."; return; }

    status.innerText = `✅ Encontrados ${channels.length} canales en Latinoamérica:`;
    list.innerHTML = channels.map(c => {
      const cleanData = { title: c.name, img: c.logo || 'https://via.placeholder.com/100x100?text=TV', embed: c.url };
      return `
        <div style="background: rgba(255,255,255,0.05); padding: 8px; border-radius: 8px; display: flex; align-items: center; gap: 8px; border: 1px solid var(--glass-border);">
            <img src="${cleanData.img}" style="width: 35px; height: 35px; object-fit: contain; background:#fff; border-radius: 4px;">
            <div style="flex: 1; overflow: hidden;">
              <p style="font-size: 0.7rem; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom:2px;">${c.name}</p>
              <button onclick="window.quickSeedManual(${JSON.stringify(cleanData).replace(/"/g, '&quot;')}, 'live')" style="background: #2ECC71; border: none; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.55rem; cursor: pointer;">➕ Agregar</button>
            </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    status.innerText = "❌ Error al cargar lista de GitHub.";
  }
};

window.quickSeedManual = async (data, type = 'movie') => {
  const finalTitle = data.title || data.name || 'Sin título';
  const exists = movieDatabase.trending.find(m => m.title === finalTitle);
  if (exists) { alert(`¡"${finalTitle}" ya existe en la selva!`); return; }

  if (!confirm(`¿Agregar "${finalTitle}" a la selva ahora? ➕🌴`)) return;
  
  const mData = {
    ...data,
    title: finalTitle,
    status: 'healthy',
    type: type,
    createdAt: Date.now()
  };
  delete mData.name; // Limpieza por seguridad

  try {
    await addDoc(collection(db, "movies"), mData);
    if (window.showToast) window.showToast(`✅ "${finalTitle}" agregado con éxito.`, "success");
    localStorage.removeItem('selvaflix_full_database');
  } catch (e) {
    console.error("Error en quickSeed:", e);
    if (window.showToast) window.showToast("❌ No se pudo agregar a la selva.", "error");
  }
};

window.parseM3U = (data) => {
  const lines = data.split('\n');
  const channels = [];
  let currentChannel = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF:')) {
      const name = line.split(',').pop();
      const logoMatch = line.match(/tvg-logo="([^"]+)"/);
      currentChannel = { name, logo: logoMatch ? logoMatch[1] : null };
    } else if (line.startsWith('http')) {
      currentChannel.url = line;
      if (currentChannel.name) channels.push(currentChannel);
      currentChannel = {};
    }
  }
  return channels;
};

window.autoSuggestLogo = async () => {
  const title = document.getElementById('m-title').value;
  const imgInput = document.getElementById('m-img');
  const preview = document.getElementById('m-img-preview');
  if (!title) { alert("¡Dime el nombre del canal primero! 🐒"); return; }

  const originalText = title;
  imgInput.value = "🔍 Buscando logo...";

  try {
    // Buscamos en Wikipedia / Clearbit para marcas conocidas
    const cleanName = title.toLowerCase().replace(/\s+/g, '').replace('tv', '').replace('live', '');
    const logoUrl = `https://logo.clearbit.com/${cleanName}.com`;

    // Verificamos si existe el logo de clearbit
    const check = await fetch(logoUrl, { method: 'HEAD' });
    if (check.ok) {
      imgInput.value = logoUrl;
      if (preview) preview.src = logoUrl;
      return;
    }

    // Si falla, abrimos búsqueda en duckduckgo imágenes para el usuario
    window.open(`https://duckduckgo.com/?q=${encodeURIComponent(title + " logo png")}&iax=images&ia=images`, '_blank');
    imgInput.value = "";
  } catch (e) {
    window.open(`https://www.google.com/search?q=${encodeURIComponent(title + " logo png")}&tbm=isch`, '_blank');
    imgInput.value = "";
  }
};

// Initial Setup
document.addEventListener('DOMContentLoaded', () => {
  // 👥 Programa de referidos: si llegó con ?ref=UID, lo guardamos para cuando
  // se registre (puede tardar en crear cuenta, por eso no alcanza con una
  // variable en memoria) — se consume una sola vez en trackAccountLogin().
  const refParam = new URLSearchParams(window.location.search).get('ref');
  if (refParam) localStorage.setItem('selva_pending_ref', refParam);

  // Nota: handleRouting se dispara automáticamente cuando loadSelvaFlixData termina de cargar
  // ⚡ Cargar Publicidad al Inicio (Para todos los usuarios)
  window.loadAdConfig();
  // 💎 Cargar Planes Premium (para la ventanita de invitación y el modal público)
  window.loadPlansConfig();
  window.loadTrialOffers();
  window.loadStreakConfig();

  // 🔥⏳ Ubicar las pills de racha/tiempo Premium (navbar en desktop, ancla
  // fija junto a los flotantes en celular) — y de nuevo si cambia el ancho
  // (rotar el teléfono, achicar la ventana).
  window.placePremiumBadges();
  window.addEventListener('resize', window.placePremiumBadges);

  // 🔍 Buscador Global - el listener que faltaba!
  const globalSearch = document.getElementById('global-search');
  if (globalSearch) {
    globalSearch.addEventListener('input', (e) => {
      handleGlobalSearch(e.target.value.trim());
    });
    globalSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        globalSearch.value = '';
        handleGlobalSearch('');
        globalSearch.blur();
      }
    });
  }

  // 🔍 Buscador móvil (overlay)
  const mobileSearch = document.getElementById('mobile-search-input');
  if (mobileSearch) {
    mobileSearch.addEventListener('input', (e) => {
      handleGlobalSearch(e.target.value.trim());
    });
    mobileSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.closeMobileSearch();
    });
  }

  const btnDiscoverMovies = document.getElementById('btn-discover-movies');
  const btnDiscoverSeries = document.getElementById('btn-discover-series');
  const btnDiscoverM3U = document.getElementById('btn-discover-m3u');
  const btnDivLive = document.getElementById('btn-discover-live');
  const btnConfirmSeed = document.getElementById('btn-confirm-mass-seed');

  if (btnDiscoverMovies) btnDiscoverMovies.addEventListener('click', () => window.massSeedMovies('movie'));
  if (btnDiscoverSeries) btnDiscoverSeries.addEventListener('click', () => window.massSeedMovies('series'));
  if (btnDiscoverM3U) btnDiscoverM3U.addEventListener('click', () => window.discoverM3U());
  if (btnDivLive) btnDivLive.addEventListener('click', () => window.suggestTVChannels());
  if (btnConfirmSeed) btnConfirmSeed.addEventListener('click', () => window.confirmBatchSeed());

  document.getElementById('btn-tmdb-search').addEventListener('click', () => {
    const query = document.getElementById('tmdb-search-input').value;
    searchTMDB(query);
  });

  document.getElementById('m-img').addEventListener('input', (e) => {
    const preview = document.getElementById('m-img-preview');
    if (preview) {
      preview.src = e.target.value || 'https://via.placeholder.com/150x220?text=Previsualización';
    }
  });

  document.getElementById('m-title')?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val.length > 2) {
      searchTMDB(val, true);
    }
  });

  // Pegado directo de imágenes (Clipboard)
  document.getElementById('m-img')?.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        window.handleImageUpload(file);
      }
    }
  });

// ─── Drawer Helper Functions ─────────────────────────────────────────────────

window.submitMovieForm = async () => {
  const dbId = document.getElementById('m-db-id').value;
  const title = document.getElementById('m-title').value.trim();
  const img = document.getElementById('m-img').value.trim();

  if (!title) { window.showToast('¡Falta el título! 🌴', 'error'); return; }
  if (!img) { window.showToast('¡Falta la imagen del póster!', 'error'); return; }

  const submitBtn = document.getElementById('submit-btn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<span class="material-symbols-outlined">hourglass_empty</span> Saving...'; }

  const movieData = {
    title,
    original_title: document.getElementById('m-original-title')?.value.trim() || '',
    director: document.getElementById('m-director')?.value.trim() || '',
    synopsis: document.getElementById('m-synopsis')?.value.trim() || '',
    cast: document.getElementById('m-cast')?.value.trim() || '',
    alternative_titles: document.getElementById('m-alternative-titles')?.value ? JSON.parse(document.getElementById('m-alternative-titles').value) : [],
    img,
    backdrop: document.getElementById('m-backdrop').value.trim(),
    pinned: document.getElementById('m-pinned').checked,
    tmdbId: document.getElementById('m-tmdb-id').value.trim(),
    imdbId: document.getElementById('m-imdb-id').value.trim(),
    embed: document.getElementById('m-embed').value.trim(),
    downloadUrl: document.getElementById('m-download-url')?.value.trim() || '',
    franchise: document.getElementById('m-franchise')?.value.trim() || '',
    year: document.getElementById('m-year').value || new Date().getFullYear().toString(),
    rating: document.getElementById('m-rating').value || '7.0',
    type: document.getElementById('m-type').value || 'movie',
    lang: document.getElementById('m-lang')?.value || 'es-MX',
    status: document.getElementById('m-status').value,
    isVIP: document.getElementById('m-is-vip').checked,
    releaseDate: document.getElementById('m-release-date')?.value ? new Date(document.getElementById('m-release-date').value).getTime() : null,
    showCountdown: document.getElementById('m-show-countdown')?.checked ?? true,
    // Solo para Series/Anime: si el tipo se cambió a Película después de
    // haber cargado episodios, no arrastramos ese mapa viejo al documento.
    episodes: (document.getElementById('m-type').value === 'series' || document.getElementById('m-type').value === 'anime')
      ? { ..._currentEpisodesMap }
      : {},
    updatedAt: Date.now()
  };

  try {
    if (dbId) {
      // Si este título todavía nunca se verificó (Sin Verificar), aprovechamos
      // el guardado para chequearlo también acá — así no depende de que el
      // admin se acuerde de correr la auditoría completa o el botón de
      // "Probar las Fuentes" a mano. Si ya tiene un estado confirmado de
      // antes, no se vuelve a chequear solo por editar un campo cualquiera
      // (para eso está "Probar las Fuentes" si sospechan que algo cambió).
      const movieActual = movieDatabase.trending.find(m => m.id === dbId);
      if (movieActual && movieActual.vimeusDisponible === undefined && (movieData.tmdbId || movieData.imdbId)) {
        if (submitBtn) submitBtn.innerHTML = '<span class="material-symbols-outlined">hourglass_empty</span> Verificando Vimeus...';
        const tipoVimeus = movieData.type === 'anime' ? 'anime' : ((movieData.type === 'series' || movieData.type === 'tv') ? 'serie' : 'movie');
        const estado = await vimeusEstadoTitulo(movieData.tmdbId, movieData.imdbId, tipoVimeus);
        movieData.vimeusDisponible = estado === 'ok';
        movieData.vimeusFantasma = estado === 'fantasma';
      }
      await updateDoc(doc(db, "movies", dbId), movieData);
      window.showToast('¡Título actualizado! 🌴🔄', 'success');
    } else {
      // Chequeo de duplicados: este formulario era el único de los ~6 puntos
      // de alta que no comparaba contra el catálogo ya cargado antes de
      // guardar (los demás — Carga Masiva, siembra rápida, sync de Vimeus —
      // sí lo hacen). Agregar el mismo título dos veces (por TMDB ID, o por
      // nombre si no hay ID) generaba un duplicado silencioso en Firebase que
      // limpiarDuplicadosDeCatalogo() se comía solo en la siguiente carga de
      // cualquier visitante — y si alguien ya había visto/guardado la copia
      // que terminaba borrada, su "Continuar viendo" quedaba apuntando a un
      // ID muerto ("Contenido no encontrado" aunque el título siguiera vivo
      // con otro ID). Se avisa y se deja decidir en vez de bloquear de una,
      // por si de verdad se quiere una segunda entrada a propósito.
      const normTmdbNuevo = movieData.tmdbId ? String(movieData.tmdbId).trim() : '';
      const normTituloNuevo = movieData.title.toLowerCase().trim();
      const posibleDuplicado = movieDatabase.trending.find(m => {
        if (normTmdbNuevo) return m.tmdbId && String(m.tmdbId).trim() === normTmdbNuevo;
        return (m.title || '').toLowerCase().trim() === normTituloNuevo;
      });
      if (posibleDuplicado) {
        const motivo = normTmdbNuevo ? 'mismo ID de TMDB' : 'mismo título';
        if (!confirm(`⚠️ Ya existe "${posibleDuplicado.title}" en el catálogo (${motivo}).\n\n¿Agregar de todas formas y crear un duplicado?`)) {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = 'Guardar'; }
          return;
        }
      }

      // Chequear Vimeus acá, al crear, tal como ya hace la Carga Masiva
      // (ver comentario en selvaExecuteExportToHosting/mData más abajo) —
      // sin esto, un título nuevo agregado por este formulario individual
      // se quedaba "Sin Verificar" para siempre hasta la próxima auditoría
      // completa del catálogo, a diferencia de la Carga Masiva que sí
      // verifica cada título al sembrarlo.
      if (movieData.tmdbId || movieData.imdbId) {
        if (submitBtn) submitBtn.innerHTML = '<span class="material-symbols-outlined">hourglass_empty</span> Verificando Vimeus...';
        const tipoVimeus = movieData.type === 'anime' ? 'anime' : ((movieData.type === 'series' || movieData.type === 'tv') ? 'serie' : 'movie');
        const estado = await vimeusEstadoTitulo(movieData.tmdbId, movieData.imdbId, tipoVimeus);
        movieData.vimeusDisponible = estado === 'ok';
        movieData.vimeusFantasma = estado === 'fantasma';
      }
      movieData.createdAt = Date.now();
      await addDoc(moviesCol, movieData);
      window.showToast('¡Título añadido exitosamente! 🌴🍿', 'success');
    }

    window.closeUploadDrawer();
    localStorage.removeItem('selvaflix_full_database');
    localStorage.removeItem('selvaflix_cache_timestamp');
    await loadSelvaFlixData();
    if (window.filterInventoryByCategory) window.filterInventoryByCategory();
  } catch (error) {
    console.error("Error guardando:", error);
    window.showToast(`Error al guardar: ${error.message}`, 'error');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<span class="material-symbols-outlined">save</span> Save Changes'; }
  }
};

window.cancelEditMode = () => {
  document.getElementById('m-db-id').value = '';
  document.getElementById('m-title').value = '';
  document.getElementById('m-img').value = '';
  document.getElementById('m-embed').value = '';
  document.getElementById('drawer-form-title').textContent = 'Untitled Title';
  const cancelBtn = document.getElementById('cancel-edit');
  if (cancelBtn) cancelBtn.style.display = 'none';
  window.closeUploadDrawer();
};

// Genre tag management
const _currentGenreTags = new Set();

window.addGenreTag = () => {
  const tag = prompt('Enter genre tag (e.g. Action, Sci-Fi, Drama):');
  if (!tag || !tag.trim()) return;
  const cleaned = tag.trim();
  if (_currentGenreTags.has(cleaned)) return;
  _currentGenreTags.add(cleaned);
  _renderGenreTags();
};

window.removeGenreTag = (tag) => {
  _currentGenreTags.delete(tag);
  _renderGenreTags();
};

function _renderGenreTags() {
  const container = document.getElementById('genre-tags-container');
  if (!container) return;
  container.innerHTML = '';
  _currentGenreTags.forEach(tag => {
    const pill = document.createElement('span');
    pill.className = 'genre-tag-pill';
    pill.innerHTML = `${tag} <button type="button" onclick="window.removeGenreTag('${tag}')">×</button>`;
    container.appendChild(pill);
  });
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'add-tag-btn';
  addBtn.textContent = '+ Add Tag';
  addBtn.onclick = window.addGenreTag;
  container.appendChild(addBtn);
  const hidden = document.getElementById('m-genres');
  if (hidden) hidden.value = JSON.stringify([..._currentGenreTags]);
}

// ─── Editor de Episodios (Series/Anime) ────────────────────────────────────
// Player.js usa _currentEpisodesMap (declarado arriba del archivo) como
// prioridad máxima para ese capítulo específico; sin nada acá, el capítulo
// se arma solo con los Servidores Públicos + TMDb, tal como ya funcionaba
// antes de este editor.

window.toggleEpisodesCardVisibility = () => {
  const card = document.getElementById('episodes-editor-card');
  if (!card) return;
  const type = document.getElementById('m-type')?.value || 'movie';
  card.style.display = (type === 'series' || type === 'anime') ? 'block' : 'none';
};

window.loadEpisodesEditorSeasons = async () => {
  const tmdbId = document.getElementById('m-tmdb-id')?.value.trim();
  const status = document.getElementById('ep-editor-status');
  if (!tmdbId) {
    window.showToast('Falta el ID TMDB para traer temporadas 🌴', 'error');
    return;
  }
  const requestId = ++_epSeasonsRequestId;
  if (status) status.textContent = 'Cargando desde TMDb...';
  try {
    const resp = await fetch(`${TMDB_URL}/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=es-MX`);
    const details = await resp.json();
    if (!details.seasons) throw new Error('TMDb no devolvió temporadas');
    // Llegó una carga más nueva mientras esta estaba en vuelo (auto-trigger
    // + click manual, o el drawer se cerró/reseteó) -- descartar esta.
    if (requestId !== _epSeasonsRequestId) return;

    _currentEpisodesSeasons = details.seasons
      .filter(s => s.season_number > 0)
      .map(s => ({ season_number: s.season_number, episode_count: s.episode_count }));

    const seasonSelect = document.getElementById('ep-season-select');
    if (seasonSelect) {
      seasonSelect.innerHTML = _currentEpisodesSeasons
        .map(s => `<option value="${s.season_number}">Temporada ${s.season_number}</option>`).join('');
      seasonSelect.value = _currentEpisodesSeasons[0]?.season_number || 1;
    }
    if (status) status.textContent = `${_currentEpisodesSeasons.length} temporada(s) encontradas.`;
    window.renderEpisodesEditor();
  } catch (e) {
    console.error('Error cargando temporadas:', e);
    if (status) status.textContent = '';
    window.showToast('No se pudo traer temporadas de TMDb', 'error');
  }
};

window.renderEpisodesEditor = () => {
  const container = document.getElementById('ep-rows-container');
  const seasonSelect = document.getElementById('ep-season-select');
  if (!container || !seasonSelect || !_currentEpisodesSeasons) return;

  const seasonNumber = parseInt(seasonSelect.value) || 1;
  const season = _currentEpisodesSeasons.find(s => s.season_number === seasonNumber);
  const count = season ? season.episode_count : 0;

  container.innerHTML = '';
  for (let ep = 1; ep <= count; ep++) {
    const key = `${seasonNumber}-${ep}`;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:8px;';
    row.innerHTML = `
      <label style="width:52px; flex-shrink:0; font-size:0.75rem; color:#999;">E${ep}</label>
      <input type="url" class="form-control ep-url-input" data-key="${key}"
        placeholder="https://... (opcional)" style="flex:1; font-size:0.8rem;"
        value="${(_currentEpisodesMap[key] || '').replace(/"/g, '&quot;')}">
    `;
    const input = row.querySelector('.ep-url-input');
    input.addEventListener('input', () => {
      const val = input.value.trim();
      if (val) _currentEpisodesMap[key] = val;
      else delete _currentEpisodesMap[key];
    });
    container.appendChild(row);
  }
};

// Test embed link by playing it
window.testEmbedLink = () => {
  const embedUrl = document.getElementById('m-embed').value.trim();
  if (!embedUrl) { window.showToast('Paste a video URL first', 'error'); return; }
  const preview = document.getElementById('admin-embed-preview');
  const filename = document.getElementById('admin-embed-filename');
  if (preview) preview.style.display = 'flex';
  if (filename) filename.textContent = embedUrl.substring(0, 50) + (embedUrl.length > 50 ? '…' : '');
  // Carga la vista previa en vivo (mini player), así se ve al toque si el
  // enlace pegado realmente carga algo o no, sin tener que guardar primero.
  window.updateMiniPlayer();
  window.showToast('👁️ Vista previa cargada en el panel de la derecha.', 'info');
};

window.clearEmbedLink = () => {
  document.getElementById('m-embed').value = '';
  const preview = document.getElementById('admin-embed-preview');
  if (preview) preview.style.display = 'none';
};

// Quick admin actions from drawer
window.deleteFromDrawer = () => {
  const id = document.getElementById('m-db-id').value;
  const title = document.getElementById('m-title').value;
  if (!id) return;

  document.getElementById('confirm-delete-title').textContent = title || 'esta película';
  const modal = document.getElementById('confirm-delete-modal');
  document.getElementById('btn-confirm-delete').onclick = async () => {
    modal.style.display = 'none';
    try {
      await window.deleteMovie(id, true);
      window.closeUploadDrawer();
    } catch(e) { window.showToast('Error: ' + e.message, 'error'); }
  };
  modal.style.display = 'flex';
};

// Arma la lista de servidores públicos candidatos para el título que se está
// editando, usando las mismas plantillas de URL (por IMDb ID) que Player.js
// (buildPublicStreams) — sin tocar ni llamar al reproductor en vivo, así no
// hay riesgo de pisar una reproducción activa. Igual que ahí, no se
// health-checkean: el admin las valida con "Reproducir" antes de fijar.
window.checkAdminPublicServers = () => {
  const imdbId = document.getElementById('m-imdb-id').value.trim();
  const type = document.getElementById('m-type').value;
  const isTv = ['series', 'tv', 'anime'].includes(type);
  const listEl = document.getElementById('drawer-public-servers-list');
  if (!listEl) return;

  if (!imdbId) {
    listEl.innerHTML = '<p style="color:#e74c3c; font-size:0.7rem; margin:0;">Necesitas el IMDb ID (búscalo/selecciónalo en TMDB arriba primero).</p>';
    return;
  }

  // providerName tiene que ser IDÉNTICO al que usa Player.js/buildPublicStreams
  // (RepelisHD, PelisMart, FlixLatam) — es la clave con la que el reproductor
  // matchea this.preferredProvider contra la lista de fuentes públicas.
  const title = document.getElementById('m-title').value.trim();
  const searchQuery = encodeURIComponent(title);

  const servers = [];
  if (!isTv) {
    servers.push({ name: "🎬 REPELISHD", providerName: "RepelisHD", url: `https://verhdlink.cam/movie/${imdbId}` });
  }
  // El link /vidurl/ es un endpoint interno SOLO para embeber (por eso el
  // 👁️ de acá abajo lo carga en el mini player). Abierto directo o pegado
  // en una app de descarga, PelisMart/FlixLatam lo bloquean a propósito
  // (revisan que la página esté "enmarcada", no solo el referer — probado
  // en vivo el 2026-08-10). searchUrl SÍ es su página pública real
  // (funciona directo, sin bloqueo): desde ahí el usuario llega al
  // "/pelicula/slug" de verdad, donde una extensión de descarga normal
  // (tipo Video DownloadHelper) sí detecta el archivo, como en PelisMart.
  servers.push({ name: "🍿 PELISMART · EMBED69", providerName: "PelisMart", url: isTv ? `https://pelismart.mov/vidurl/${imdbId}-1x01/` : `https://pelismart.mov/vidurl/${imdbId}/`, searchUrl: `https://pelismart.mov/search?s=${searchQuery}` });
  servers.push({ name: "🇲🇽 FLIXLATAM · EMBED69", providerName: "FlixLatam", url: isTv ? `https://flixlatam.com/vidurl/${imdbId}-1x01/` : `https://flixlatam.com/vidurl/${imdbId}/`, searchUrl: `https://flixlatam.com/search?s=${searchQuery}` });

  // El preferido actual sube al tope de la lista y queda marcado, para que
  // se vea de un vistazo cuál va a arrancar primero (sin admin.embed de por medio).
  const actual = document.getElementById('m-preferred-provider').value.trim();
  servers.sort((a, b) => (b.providerName === actual) - (a.providerName === actual));

  listEl.innerHTML = servers.map(srv => {
    const esActual = srv.providerName === actual;
    return `
    <div style="background:${esActual ? 'rgba(46,204,113,0.1)' : 'rgba(255,255,255,0.02)'}; border:1px solid ${esActual ? '#2ecc71' : 'rgba(255,255,255,0.06)'}; padding:8px 10px; border-radius:8px; display:flex; justify-content:space-between; align-items:center; gap:8px; transition:background 0.3s, border-color 0.3s;">
      <span style="font-size:0.7rem; font-weight:bold; color:#00f2ff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0;">${srv.name}</span>
      <button type="button" class="btn" style="font-size:0.65rem; padding:4px 6px; cursor:pointer; background:rgba(255,255,255,0.08); border:none; color:#ccc; font-weight:bold; border-radius:4px; flex-shrink:0;" onclick="window.previewServerLink('${srv.url}')" title="Vista previa (abre embebido)">👁️</button>
      <button type="button" class="btn" style="font-size:0.65rem; padding:4px 6px; cursor:pointer; background:rgba(255,255,255,0.08); border:none; color:#ccc; font-weight:bold; border-radius:4px; flex-shrink:0;" onclick="window.copyServerLink('${srv.url}')" title="Copiar link">📋</button>
      ${srv.searchUrl ? `<button type="button" class="btn" style="font-size:0.65rem; padding:4px 6px; cursor:pointer; background:rgba(255,255,255,0.08); border:none; color:#ccc; font-weight:bold; border-radius:4px; flex-shrink:0;" onclick="window.open('${srv.searchUrl}', '_blank', 'noopener')" title="Buscar en el sitio real">🔍</button>` : ''}
      <button type="button" class="btn" style="font-size:0.65rem; padding:4px 8px; cursor:pointer; background:#ff571a; border:none; color:#fff; font-weight:bold; border-radius:4px; flex-shrink:0; white-space:nowrap;" onclick="window.selvaExecuteDirectExport(document.getElementById('m-db-id').value, '${srv.providerName.toLowerCase()}')" title="Extraer link real y subir a tu cuenta de VOE.sx">📤 Subir a VOE</button>
      ${esActual
        ? '<span style="font-size:0.65rem; padding:4px 8px; background:#2ecc71; color:#000; font-weight:900; border-radius:4px; flex-shrink:0;">✓ Actual</span>'
        : `<button type="button" class="btn" style="font-size:0.65rem; padding:4px 8px; cursor:pointer; background:#00f2ff; border:none; color:#000; font-weight:bold; border-radius:4px; flex-shrink:0; white-space:nowrap;" onclick="window.preferirServidorPublico('${srv.providerName}')">⭐ Preferir</button>`}
    </div>

  `;
  }).join('') + (isTv ? '<p style="color:#aaa; font-size:0.65rem; margin:4px 0 0;">Nota: para series arma la URL con T1E1 por defecto, igual que el link manual.</p>' : '');
};

// Vista previa embebida (no pestaña nueva): varios servidores (PelisMart,
// FlixLatam) bloquean la navegación directa por protección anti-hotlink —
// solo responden si el pedido llega embebido con el referer del sitio, que
// es justo como los usa el reproductor real. Reutiliza el mini-player que
// ya existe para "Enlace de Video".
window.previewServerLink = (url) => {
  const placeholder = document.getElementById('mini-player-placeholder');
  const iframe = document.getElementById('mini-player-iframe');
  if (placeholder) placeholder.style.display = 'none';
  if (iframe) {
    iframe.style.display = 'block';
    iframe.src = url;
  }
  if (window.showToast) window.showToast('👁️ Vista previa cargada en el panel de la derecha.', 'info');
};

window.copyServerLink = (url) => {
  navigator.clipboard.writeText(url)
    .then(() => { if (window.showToast) window.showToast('📋 Link copiado — pégalo donde lo necesites.', 'success'); })
    .catch(() => { if (window.showToast) window.showToast('No se pudo copiar. Copialo a mano desde la pestaña abierta.', 'error'); });
};

// "Preferir" NO toca el enlace propio (embed) — solo guarda cuál servidor
// público debe arrancar primero (movie.preferredProvider). El orden
// público-primero/enlace-propio-al-final (confirmado sin anuncios, ver
// commit b559fed) queda intacto.
window.preferirServidorPublico = async (providerName) => {
  const id = document.getElementById('m-db-id').value;
  if (!id) { window.showToast('Necesitas guardar la película primero (falta el ID).', 'error'); return; }
  try {
    await updateDoc(doc(db, "movies", id), { preferredProvider: providerName, updatedAt: Date.now() });
    document.getElementById('m-preferred-provider').value = providerName;
    window.checkAdminPublicServers(); // Re-renderiza: el elegido sube y se marca "✓ Actual"
    window.showToast(`⭐ ${providerName} fijado como servidor preferido.`, 'success');
  } catch (e) {
    window.showToast('Error al preferir servidor: ' + e.message, 'error');
  }
};

window.setAdminPriorityFromDrawer = async () => {
  const id = document.getElementById('m-db-id').value;
  const url = document.getElementById('m-embed').value.trim();
  if (!id || !url) { window.showToast('Necesitas un ID de película y un enlace en "Enlace de Video"', 'error'); return; }
  try {
    await updateDoc(doc(db, "movies", id), { embed: url, status: 'healthy', updatedAt: Date.now() });
    document.getElementById('m-status').value = 'healthy';
    window.showToast('🔒 Enlace fijado con éxito.', 'success');
  } catch(e) { window.showToast('Error: ' + e.message, 'error'); }
};

// Igual que "Fijar Enlace" para el video, pero para el link de descarga:
// guarda ya mismo solo ese campo en Firestore, sin pasar por todo el
// formulario — así se puede pegar un link y probarlo al toque en la ficha
// del usuario, sin tener que completar/guardar el resto de los campos.
window.setDownloadUrlFromDrawer = async () => {
  const id = document.getElementById('m-db-id').value;
  const url = document.getElementById('m-download-url').value.trim();
  if (!id) { window.showToast('Necesitas guardar la película primero (falta el ID).', 'error'); return; }
  if (!url) { window.showToast('Pegá un link de descarga primero.', 'error'); return; }
  try {
    await updateDoc(doc(db, "movies", id), { downloadUrl: url, updatedAt: Date.now() });
    window.showToast('⬇️ Link de descarga fijado con éxito.', 'success');
  } catch(e) { window.showToast('Error: ' + e.message, 'error'); }
};

// Movie Form Submit (Add or Update) – legacy form submit listener
  document.getElementById('movie-form')?.addEventListener('submit', async (e) => {

    e.preventDefault();
    const dbId = document.getElementById('m-db-id').value;

    const title = document.getElementById('m-title').value.trim();
    const img = document.getElementById('m-img').value.trim();

    if (!title) { alert('¡Falta el título! 🌴'); return; }
    if (!img) { alert('¡Falta la imagen del póster! Busca una en TMDB o pega la URL. 🖼️'); return; }

    const movieData = {
      title,
      original_title: document.getElementById('m-original-title').value.trim(),
      director: document.getElementById('m-director').value.trim(),
      alternative_titles: document.getElementById('m-alternative-titles').value ? JSON.parse(document.getElementById('m-alternative-titles').value) : [],
      img,
      backdrop: document.getElementById('m-backdrop').value.trim(),
      pinned: document.getElementById('m-pinned').checked,
      tmdbId: document.getElementById('m-tmdb-id').value.trim(),
      imdbId: document.getElementById('m-imdb-id').value.trim(), // Operación IMDB-Latino
      embed: document.getElementById('m-embed').value.trim(),
      downloadUrl: document.getElementById('m-download-url')?.value.trim() || '',
      year: document.getElementById('m-year').value || new Date().getFullYear().toString(),
      rating: document.getElementById('m-rating').value || '7.0',
      type: document.getElementById('m-type').value || 'movie',
      status: dbId ? document.getElementById('m-status').value : (document.getElementById('discover-send-to-review')?.checked ? 'review' : 'healthy'),
      
      // 💎 VIP Engine
      isVIP: document.getElementById('m-is-vip').checked,
      releaseDate: document.getElementById('m-release-date').value ? new Date(document.getElementById('m-release-date').value).getTime() : null,
      showCountdown: document.getElementById('m-show-countdown').checked,
      
      updatedAt: Date.now()
    };

    const submitBtn = document.getElementById('submit-btn');
    submitBtn.disabled = true;
    submitBtn.innerText = 'Guardando... ⏳';

    try {
      if (dbId) {
        await updateDoc(doc(db, "movies", dbId), movieData);
        alert('¡Actualización Exitosa! 🌴🔄');
      } else {
        movieData.createdAt = Date.now();
        await addDoc(moviesCol, movieData);
        alert('¡Cosecha Exitosa! 🌴🍿');
      }

      // Reset form
      e.target.reset();
      document.getElementById('m-db-id').value = "";
      document.getElementById('m-imdb-id').value = ""; // Operación IMDB-Latino
      document.getElementById('m-original-title').value = "";
      document.getElementById('m-alternative-titles').value = "";
      document.getElementById('m-director').value = "";
      document.getElementById('m-img-preview').src = 'https://via.placeholder.com/60x90?text=Pre';
      document.getElementById('cancel-edit').style.display = "none";
      document.getElementById('tmdb-results').innerHTML = '';

      // --- Sincronización Silenciosa ---
      localStorage.removeItem('selvaflix_full_database');
      localStorage.removeItem('selvaflix_cache_timestamp');
      await loadSelvaFlixData();
      if (window.filterInventoryByCategory) window.filterInventoryByCategory();

    } catch (error) {
      console.error("Error guardando en Firebase:", error);
      alert(`Error al guardar: ${error.message} 🐒`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerText = '¡Guardar en la Selva! 🌴✨';
    }
  });

  document.getElementById('cancel-edit').addEventListener('click', () => {
    document.getElementById('movie-form').reset();
    document.getElementById('m-db-id').value = "";
    document.getElementById('m-imdb-id').value = ""; // Operación IMDB-Latino
    document.getElementById('m-original-title').value = "";
    document.getElementById('m-alternative-titles').value = "";
    document.getElementById('m-director').value = "";
    document.getElementById('m-img-preview').src = 'https://via.placeholder.com/60x90?text=Pre';
    document.getElementById('submit-btn').innerText = "¡Guardar en la Selva! 🌴✨";
    document.getElementById('cancel-edit').style.display = "none";
  });

  // Detectar dispositivo para recomendar bloqueador (opcional mantenido temporalmente si quiere recomdar brave globalmente, 
  // pero ya no hay pantalla de anuncios forzada)
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  const adblockLink = document.getElementById('adblock-link');
  const adblockText = document.getElementById('adblock-text');

  if (adblockLink && adblockText) {
    if (/android/i.test(userAgent)) {
      adblockLink.href = "https://play.google.com/store/apps/details?id=com.brave.browser";
      adblockText.innerText = "Recomendamos usar Brave Browser en Android para evitar anuncios molestos de los servidores de video.";
    } else if (/iPad|iPhone|iPod/.test(userAgent) && !window.MSStream) {
      adblockLink.href = "https://apps.apple.com/us/app/brave-private-web-browser/id1052879175";
      adblockText.innerText = "Recomendamos descargar Brave Browser en tu iPhone o iPad.";
    } else {
      adblockText.innerText = "En PC, recomendamos instalar la extension uBlock Origin para una selva sin anuncios.";
    }
  }

  // --- PWA INSTALLATION ICON FLOW ---
  // Un solo botón: el flotante pegado al borde del hero, justo debajo del de
  // compartir (el del navbar se sacó para no duplicar el mismo acceso).
  const installBtns = [document.getElementById('hero-install-fab')].filter(Boolean);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  // iOS (Safari/Chrome-en-iOS) nunca dispara "beforeinstallprompt" — Apple no
  // lo soporta, así que ahí los botones no pueden esperar ese evento: se
  // muestran directo, y al tocarlos aparece el banner con los pasos manuales
  // (Compartir → Agregar a inicio) en vez del diálogo nativo de Android.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const iosBanner = document.getElementById('ios-install-banner');
  const iosDismissBtn = document.getElementById('ios-install-dismiss');

  const showInstaller = async () => {
    if (isStandalone) return;
    if (isIOS) {
      if (iosBanner) iosBanner.style.display = 'block';
      return;
    }
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        deferredPrompt = null;
        installBtns.forEach(b => b.style.display = 'none');
        localStorage.setItem('pwa_installed', 'true');
      }
    } else if (window.showToast) {
      window.showToast('📲 Para instalar, usá el menú de tu navegador y elegí "Agregar a pantalla de inicio".', 'info');
    }
  };
  window.showInstaller = showInstaller;

  // Listeners
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtns.forEach(b => b.style.display = 'flex');
  });

  installBtns.forEach(b => b.addEventListener('click', showInstaller));

  window.addEventListener('appinstalled', () => {
    localStorage.setItem('pwa_installed', 'true');
    installBtns.forEach(b => b.style.display = 'none');
  });

  // En iOS los botones no esperan "beforeinstallprompt" (nunca llega): se
  // muestran directo. El banner además sigue saliendo solo a los 4s la
  // primera vez, salvo que el usuario ya lo haya cerrado antes.
  if (isIOS && !isStandalone) {
    installBtns.forEach(b => b.style.display = 'flex');
    if (iosBanner && localStorage.getItem('selva_ios_install_dismissed') !== 'true') {
      setTimeout(() => { iosBanner.style.display = 'block'; }, 4000);
    }
  }
  if (iosDismissBtn) {
    iosDismissBtn.addEventListener('click', () => {
      if (iosBanner) iosBanner.style.display = 'none';
      localStorage.setItem('selva_ios_install_dismissed', 'true');
    });
  }
});

// --- SISTEMA DE USUARIOS & PERFILES (Fase 6) ---
// 🔴 PÚBLICO. Aunque quede pegado al bloque de herramientas de admin (Discovery &
// Seeding, más arriba), todo esto es del sitio de cara al usuario: menú de usuario,
// cerrar sesión, perfiles y PIN. Los encabezados de sección de este archivo NO
// coinciden con la frontera admin/público — cortar "por sección" rompe el logout.
let _currentProfile = null;
const provider = new GoogleAuthProvider();

window.toggleUserMenu = () => {
    if (!auth.currentUser) {
        document.getElementById('auth-modal').style.display = 'flex';
    } else {
        const menu = document.getElementById('user-dropdown');
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    }
};

window.handleLogout = async () => {
    if (confirm("¿Quieres salir de la selva? 🚪🌴")) {
        await signOut(auth);
        localStorage.removeItem('selva_active_profile');
        window.location.reload();
    }
};

// ─── CUENTA PRINCIPAL EN CONFIGURACIÓN ───────────────────────────────────────
window.updateSettingsAccountInfo = () => {
    const container = document.getElementById('settings-account-info');
    if (!container) return;
    const user = auth.currentUser;
    if (user) {
        container.style.display = 'flex';
        const img = document.getElementById('settings-account-avatar-img');
        const initials = document.getElementById('settings-account-initials');
        const nameEl = document.getElementById('settings-account-name');
        const emailEl = document.getElementById('settings-account-email');
        if (nameEl) nameEl.innerText = user.displayName || 'Usuario de SelvaFlix';
        if (emailEl) emailEl.innerText = user.email || '';
        if (user.photoURL) {
            if (img) { img.src = user.photoURL; img.style.display = 'block'; }
            if (initials) initials.style.display = 'none';
        } else {
            if (img) img.style.display = 'none';
            if (initials) {
                initials.innerText = (user.displayName || 'U').charAt(0).toUpperCase();
                initials.style.display = 'inline';
            }
        }
    } else {
        container.style.display = 'none';
    }
};

window.showSettings = () => {
    window.updateSettingsAccountInfo();
    const input = document.getElementById('edit-profile-name-input');
    const pinInput = document.getElementById('edit-profile-pin-input');
    const modal = document.getElementById('profile-edit-name-modal');
    const saveBtn = document.getElementById('btn-save-profile-name');

    input.value = _currentProfile.name;
    // El campo de PIN se mostraba vacío y, aunque el usuario escribiera algo
    // ahí, el guardado lo ignoraba por completo (solo mandaba el nombre) —
    // parecía que se podía cambiar el PIN desde Configuración pero no hacía
    // nada de verdad.
    if (pinInput) pinInput.value = _currentProfile.pin || '';
    modal.style.display = 'flex';

    saveBtn.onclick = () => {
        const newName = input.value.trim();
        const newPin = pinInput ? pinInput.value.trim() : '';
        if (!newName) return;
        if (newPin && newPin.length !== 4) { if (window.showToast) window.showToast('El PIN debe ser de 4 dígitos. 🔒', 'warning'); return; }

        window._tempProfileToUpdate = { id: _currentProfile.id, name: newName, pin: newPin, isPrimary: _currentProfile.isPrimary || false };
        modal.style.display = 'none';
        window.openAvatarPicker();
    };

    document.getElementById('user-dropdown').style.display = 'none';
};

window.closeAuthModal = () => {
    document.getElementById('auth-modal').style.display = 'none';
    window.hideSplashScreen(); // 🚀 Entra como invitado, fuera splash!
};

document.getElementById('btn-google-login')?.addEventListener('click', async () => {
    try {
        const result = await signInWithPopup(auth, provider);
        console.log("✅ Usuario autenticado:", result.user.displayName);
        window.closeAuthModal();
    } catch (error) {
        console.error("❌ Error en Login:", error);
        if (window.showToast) {
            window.showToast("❌ No pudimos conectar con la selva. Revisa tu internet.", "error");
        } else {
            console.error("❌ Error en Login:", error);
        }
    }
});

// --- Registro de cuenta + conteo de inicios de sesión (v2.45) ---
// Se dispara una sola vez por pestaña/sesión de navegador (no en cada re-render)
// para no inflar el contador con cada acción del usuario ya logueado.
async function trackAccountLogin(user) {
    const flagKey = 'selva_login_tracked_' + user.uid;
    if (sessionStorage.getItem(flagKey)) return; // Ya contado en esta sesión de navegador

    const userRef = doc(db, "users", user.uid);
    try {
        const snap = await getDoc(userRef);
        const isNewAccount = !snap.exists() || !snap.data().createdAt;

        // 👥 Referidos: solo aplica una vez, en la cuenta nueva, y nunca a uno
        // mismo (alguien que abre su propio link y crea otra cuenta). Se limpia
        // del localStorage se haya podido aplicar o no, para no arrastrar un
        // código viejo a la próxima cuenta que se cree en este navegador.
        const pendingRef = localStorage.getItem('selva_pending_ref');
        const referredBy = (isNewAccount && pendingRef && pendingRef !== user.uid) ? pendingRef : null;
        localStorage.removeItem('selva_pending_ref');

        await setDoc(userRef, {
            email: user.email || null,
            displayName: user.displayName || null,
            photoURL: user.photoURL || null,
            createdAt: isNewAccount ? Date.now() : snap.data().createdAt,
            lastLoginAt: Date.now(),
            ...(referredBy ? { referredBy } : {}),
        }, { merge: true });

        await supabase.from('user_activity').insert({
            action: 'login',
            details: { email: user.email || 'sin-email' },
            platform: navigator.platform,
            user_agent: navigator.userAgent.substring(0, 80),
            visitor_id: getVisitorId(),
            uid: user.uid
        });

        sessionStorage.setItem(flagKey, '1');
    } catch (e) { console.error("Error registrando login:", e); }
}

// --- Tier Premium (real, en Firestore) 💎 ---
// auth.currentUser.customClaims solo se puede setear desde un backend con
// Firebase Admin SDK (Cloud Functions), y este proyecto no tiene ninguna —
// todo acá habla directo con Firestore desde el cliente. Por eso el tier
// vive en users/{uid}.tier, que el admin puede escribir con un botón como
// cualquier otro dato del panel, y queda cacheado en memoria para que las
// verificaciones (reproducir, anuncios, banner) sean síncronas.
window.currentUserTier = 'free';
window.currentUserPremiumUntil = null; // timestamp ms del vencimiento (null = sin vencimiento, ej. plan pago sin límite o admin)
window.currentUserPremiumGrantedAt = null; // timestamp ms de cuándo arrancó, para poder dibujar el % de la barra

window.currentStreakCount = 0;
window.currentStreakClaimedMilestones = []; // escalones ya cobrados en la racha actual

window.refreshUserTier = async (uid) => {
    if (!uid) {
        window.currentUserTier = 'free'; window.currentUserPremiumUntil = null; window.currentUserPremiumGrantedAt = null;
        window.currentUserFreeTrialClaims = {};
        window.currentStreakCount = 0;
        window.currentStreakClaimedMilestones = [];
        return window.currentUserTier;
    }
    try {
        const snap = await getDoc(doc(db, "users", uid));
        const data = snap.exists() ? snap.data() : null;
        const rawTier = data?.tier || 'free';
        const expired = rawTier === 'premium' && data?.premiumUntil && data.premiumUntil < Date.now();
        window.currentUserTier = expired ? 'free' : rawTier;
        window.currentUserPremiumUntil = expired ? null : (data?.premiumUntil || null);
        window.currentUserPremiumGrantedAt = expired ? null : (data?.premiumGrantedAt || null);
        window.currentUserFreeTrialClaims = data?.freeTrialClaims || {};
        // La racha se corta sola si pasó más de 1 día desde el último "visto" —
        // no hace falta borrarla en Firestore, con no mostrarla alcanza (el
        // próximo registerStreakProgress la resetea a mano al detectar el salto).
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        const streak = data?.streak;
        const streakVigente = streak && (streak.lastDate === today || streak.lastDate === yesterday);
        window.currentStreakCount = streakVigente ? (streak.count || 0) : 0;
        window.currentStreakClaimedMilestones = streakVigente ? (streak.claimedMilestones || []) : [];
    } catch (e) {
        console.warn('No se pudo leer el tier del usuario:', e);
        window.currentUserTier = 'free';
        window.currentUserPremiumUntil = null;
        window.currentUserPremiumGrantedAt = null;
        window.currentUserFreeTrialClaims = {};
        window.currentStreakCount = 0;
        window.currentStreakClaimedMilestones = [];
    }
    if (typeof window.updatePremiumTimeBadge === 'function') window.updatePremiumTimeBadge();
    if (typeof window.updateStreakBadge === 'function') window.updateStreakBadge();
    if (typeof window.renderStreakDetail === 'function') window.renderStreakDetail();
    if (typeof window.updateDropdownPlanLabel === 'function') window.updateDropdownPlanLabel();
    if (typeof window.updatePremiumPromoFab === 'function') window.updatePremiumPromoFab();
    if (typeof window.updateReferralCard === 'function') window.updateReferralCard();
    return window.currentUserTier;
};

// El botón flotante de Premium: solo tiene sentido si TODAVÍA no sos premium —
// a alguien que ya pagó (o está en una prueba activa) no hace falta ofrecerle
// nada, así que se esconde solo. En el panel admin lo maneja showView(), no acá.
window.updatePremiumPromoFab = () => {
    const fab = document.getElementById('premium-promo-fab');
    if (!fab) return;
    if (document.getElementById('admin-view')?.style.display === 'block') { fab.style.display = 'none'; return; }
    // No se esconde al ser premium: cambia de sentido en vez de desaparecer.
    // 🎁 invitado/free = "mirá lo que hay" (planes, prueba gratis, racha).
    // 👑 premium/admin = "mirá tu plan" (mismo modal, pero ahora te muestra
    // tus beneficios y cuánto tiempo te queda en vez de venderte algo).
    const isPremium = window.currentUserTier === 'premium' || window.currentUserTier === 'admin';
    fab.style.display = 'flex';
    fab.innerText = isPremium ? '👑' : '🎁';
    fab.title = isPremium ? 'Tu plan Premium' : 'Planes, pruebas gratis y racha';
};

// El botón del menú decía siempre "Mi Plan", texto fijo sin importar si sos
// gratuito, premium o admin — ahora muestra el plan real de la cuenta. No
// hay (todavía) un plan específico guardado por usuario, solo el tier
// (free/premium/admin), así que el nombre es genérico por tier, no el de
// una tarjeta puntual de la grilla de planes.
window.updateDropdownPlanLabel = () => {
    const btn = document.getElementById('dropdown-my-plan-btn');
    if (!btn) return;
    const tier = window.currentUserTier || 'free';
    const label = tier === 'admin' ? '👑 Plan Admin' : tier === 'premium' ? '💎 Plan Premium' : '🐾 Plan Gratuito';
    btn.innerText = label;
};

window.updateStreakBadge = () => {
    const badge = document.getElementById('streak-badge');
    if (!badge) return;
    if (!window.currentStreakCount || window.currentStreakCount < 1) {
        badge.style.display = 'none';
        return;
    }
    badge.style.display = 'flex';
    badge.innerText = `🔥 ${window.currentStreakCount}`;
};

// El navbar tiene backdrop-filter, así que position:fixed adentro se calcula
// mal (crea su propio "contenedor" para los fixed, en vez del viewport real)
// — en celular, en vez de pelear con eso, se mudan los nodos de verdad a
// #mobile-badges-anchor (fixed, fuera del navbar, junto a los flotantes de
// abajo). En desktop vuelven a vivir adentro de .nav-actions, como siempre.
window.placePremiumBadges = () => {
    const streak = document.getElementById('streak-badge');
    const premiumBadge = document.getElementById('premium-time-badge');
    const mobileAnchor = document.getElementById('mobile-badges-anchor');
    const navActions = document.querySelector('.nav-actions');
    const avatarContainer = document.getElementById('user-profile-container');
    if (!streak || !premiumBadge || !mobileAnchor || !navActions || !avatarContainer) return;

    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (isMobile) {
        if (streak.parentElement !== mobileAnchor) mobileAnchor.appendChild(streak);
        if (premiumBadge.parentElement !== mobileAnchor) mobileAnchor.appendChild(premiumBadge);
    } else {
        if (streak.parentElement !== navActions) navActions.insertBefore(streak, avatarContainer);
        if (premiumBadge.parentElement !== navActions) navActions.insertBefore(premiumBadge, avatarContainer);
    }
};

// Se llama cuando el reproductor estuvo abierto >=2 minutos seguidos (ver
// STREAK_WATCH_MS en startPlayer) — es el proxy de "vio algo hoy", porque con
// servidores externos en iframe no hay forma de leer el currentTime real.
window.registerStreakProgress = async () => {
    const user = auth.currentUser;
    if (!user) return;
    try {
        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);
        const userData = userSnap.exists() ? userSnap.data() : {};
        const today = new Date().toISOString().split('T')[0];
        const streak = userData.streak || { count: 0, lastDate: null, claimedMilestones: [] };

        if (streak.lastDate === today) return; // ya contó hoy, no hacer nada

        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        const rachaContinua = streak.lastDate === yesterday;
        const newCount = rachaContinua ? (streak.count || 0) + 1 : 1;
        const claimedMilestones = rachaContinua ? [...(streak.claimedMilestones || [])] : [];

        // Escalones nuevos alcanzados con este día — se suman por si hay más
        // de uno pendiente (ej. el admin agregó un escalón bajo después de que
        // el usuario ya iba más adelantado).
        const milestonesSnap = window.streakMilestones && window.streakMilestones.length
            ? window.streakMilestones
            : ((await getDoc(doc(db, "configs", "streaks"))).data()?.milestones || []);

        let grantedHours = 0;
        let grantedDays = 0;
        milestonesSnap.forEach(m => {
            if (m.active !== false && newCount >= m.days && !claimedMilestones.includes(m.days)) {
                claimedMilestones.push(m.days);
                grantedHours += m.hours || 0;
                grantedDays = m.days;
            }
        });

        const updates = { streak: { count: newCount, lastDate: today, claimedMilestones } };
        if (grantedHours > 0) {
            const now = Date.now();
            // Suma sobre lo que ya tenga (no pisa un Premium/prueba en curso).
            const base = Math.max(userData.premiumUntil || 0, now);
            updates.tier = 'premium';
            updates.premiumUntil = base + grantedHours * 60 * 60 * 1000;
            updates.premiumGrantedAt = userData.premiumGrantedAt || now;
        }

        await setDoc(userRef, updates, { merge: true });
        await window.refreshUserTier(user.uid);
        if (grantedHours > 0 && typeof window.hideAllAdSlots === 'function') window.hideAllAdSlots();

        if (grantedHours > 0 && window.showToast) {
            window.showToast(`🔥 ¡Racha de ${grantedDays} días! +${_trialFormatoDuracion(grantedHours)} de Premium regaladas 🎁`, 'success');
        }
    } catch (e) {
        console.error('Error actualizando la racha:', e);
    }
};

const REFERRAL_REWARD_HOURS = 5 * 24; // 5 días para cada uno (invitado + quien invita)

// Se llama junto con registerStreakProgress (mismos 2 min de "vio algo"):
// si este usuario llegó con un link de invitación (referredBy) y todavía no
// se le dio el premio, se lo regala a él Y a quien lo invitó. referralRewardGiven
// asegura que corra una sola vez por cuenta referida, no cada vez que mira algo.
window.checkReferralReward = async () => {
    const user = auth.currentUser;
    if (!user) return;
    try {
        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);
        const userData = userSnap.exists() ? userSnap.data() : {};
        const referrerId = userData.referredBy;
        if (!referrerId || userData.referralRewardGiven) return;

        const now = Date.now();
        const rewardMs = REFERRAL_REWARD_HOURS * 60 * 60 * 1000;

        const myBase = Math.max(userData.premiumUntil || 0, now);
        await setDoc(userRef, {
            tier: 'premium',
            premiumUntil: myBase + rewardMs,
            premiumGrantedAt: userData.premiumGrantedAt || now,
            referralRewardGiven: true,
        }, { merge: true });

        // Mismas reglas de Firestore que ya permiten esto: cualquier usuario
        // autenticado puede escribir cualquier doc (ver firestore.rules) —
        // no es un permiso nuevo, ya se usaba así para todo lo demás.
        const referrerRef = doc(db, "users", referrerId);
        const referrerSnap = await getDoc(referrerRef);
        const referrerData = referrerSnap.exists() ? referrerSnap.data() : {};
        const referrerBase = Math.max(referrerData.premiumUntil || 0, now);
        await setDoc(referrerRef, {
            tier: 'premium',
            premiumUntil: referrerBase + rewardMs,
            premiumGrantedAt: referrerData.premiumGrantedAt || now,
        }, { merge: true });

        await window.refreshUserTier(user.uid);
        if (typeof window.hideAllAdSlots === 'function') window.hideAllAdSlots();
        if (window.showToast) {
            window.showToast(`🎉 ¡Bienvenido! Vos y quien te invitó ganaron ${_trialFormatoDuracion(REFERRAL_REWARD_HOURS)} de Premium 🎁`, 'success');
        }
    } catch (e) {
        console.error('Error otorgando premio de referido:', e);
    }
};

// Tarjeta "Invitá a un amigo": solo tiene sentido con sesión iniciada, porque
// el link de invitación lleva el uid (?ref=UID, ver captura en DOMContentLoaded
// y consumo en trackAccountLogin).
window.updateReferralCard = () => {
    const card = document.getElementById('referral-card');
    if (!card) return;
    card.style.display = auth.currentUser ? 'flex' : 'none';
    if (typeof window._updateRewardsSectionVisibility === 'function') window._updateRewardsSectionVisibility();
};

window.shareReferralLink = () => {
    const user = auth.currentUser;
    if (!user) {
        if (window.showToast) window.showToast('Iniciá sesión para invitar amigos 🐒', 'primary');
        return;
    }
    const link = `${window.location.origin}/?ref=${user.uid}`;
    const texto = `🌴 ¡Che, te invito a SelvaFlix! Entrá con este link y cuando veas tu primera peli ganamos los dos 5 días de Premium gratis: ${link}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank');
};

// --- Badge de tiempo Premium restante (pill fija junto al avatar) ⏳ ---
// Solo tiene sentido cuando premiumUntil está seteado (pruebas gratis, o un
// plan pago que el admin cargó con vencimiento) — un plan/admin sin límite
// no tiene nada que contar, así que el badge se esconde.
const _formatTiempoRestante = (ms) => {
    if (ms <= 0) return 'Vence ya';
    const totalMin = Math.floor(ms / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const minutes = totalMin % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
};

let _premiumBadgeTimer = null;

window.updatePremiumTimeBadge = () => {
    const badge = document.getElementById('premium-time-badge');
    if (!badge) return;

    const isPremium = window.currentUserTier === 'premium' || window.currentUserTier === 'admin';
    if (!isPremium || !window.currentUserPremiumUntil) {
        badge.style.display = 'none';
        clearInterval(_premiumBadgeTimer);
        _premiumBadgeTimer = null;
        return;
    }

    const remaining = window.currentUserPremiumUntil - Date.now();
    if (remaining <= 0) {
        // Se venció mientras la pestaña estaba abierta: recachea el tier real.
        badge.style.display = 'none';
        clearInterval(_premiumBadgeTimer);
        _premiumBadgeTimer = null;
        const user = auth.currentUser;
        if (user) {
            window.refreshUserTier(user.uid).then(() => {
                // Simétrico a hideAllAdSlots(): el pre-roll del video ya se
                // vuelve a chequear solo en cada play, pero los banners/flotantes
                // globales solo se inyectan una vez al cargar la página — sin
                // esto, quedaban "de regalo" hasta el próximo refresh.
                if (window.currentUserTier === 'free' && typeof window.injectCampaignScripts === 'function') {
                    window.injectCampaignScripts();
                }
            });
        }
        return;
    }

    badge.style.display = 'flex';
    badge.innerText = `⏳ ${_formatTiempoRestante(remaining)}`;

    if (!_premiumBadgeTimer) _premiumBadgeTimer = setInterval(window.updatePremiumTimeBadge, 30000);
};

// injectCampaignScripts() corre en DOMContentLoaded, sin esperar a Firebase —
// en ese momento window.currentUserTier todavía es el default 'free' porque
// onAuthStateChanged (async, viaja a Firestore) no tuvo tiempo de resolver.
// Resultado: a un usuario Premium que recién refresca la página le llegaban
// a inyectar los anuncios igual, y hideAllAdSlots() ya había corrido antes de
// que esos anuncios existieran (nada que esconder). _authReadyPromise se
// resuelve una sola vez, en el primer onAuthStateChanged, y lo que necesite
// saber el tier ANTES de decidir algo (como inyectar ads) lo espera primero.
let _resolveAuthReady;
window._authReadyPromise = new Promise((resolve) => { _resolveAuthReady = resolve; });

onAuthStateChanged(auth, async (user) => {
    if (user) {
        console.log("👤 Sesión activa:", user.email);

        // Verificación de BAN (Admin Only)
        const userRef = doc(db, "users", user.uid);
        // En una implementación real verificaríamos un campo 'banned' en el documento del usuario.

        trackAccountLogin(user); // 📊 No bloqueante: registra cuenta + login para el panel de Usuarios
        await window.refreshUserTier(user.uid); // 💎 cachea el tier real (Firestore) antes de cualquier chequeo premium

        // Si los anuncios ya se habían inyectado como invitado (antes de saber
        // que este login es Premium), se esconden ahora que ya lo sabemos.
        if (window.currentUserTier === 'premium' || window.currentUserTier === 'admin') {
            window.hideAllAdSlots();
        }

        document.getElementById('user-initials').innerText = user.displayName.charAt(0);
        document.getElementById('user-initials').style.display = 'flex';
        document.getElementById('user-avatar-img').style.display = 'none';
        
        // Cargar perfiles
        await window.loadProfiles(user.uid);
        if (typeof window.watchSupportUnread === 'function') window.watchSupportUnread(user.uid); // 💬 respuestas de soporte sin leer
        
        // Restaurar perfil activo si existe (aplica el animalito)
        const saved = localStorage.getItem('selva_active_profile');
        if (saved) {
            await window.applyProfile(JSON.parse(saved));
        }
        
        // 🚀 Si ya cargamos perfiles pero no hay uno activo, esconder splash para dejar ver el selector
        if (!saved) {
            window.hideSplashScreen(true);
        }

        if (typeof window.maybeShowPremiumPromo === 'function') window.maybeShowPremiumPromo();
        _resolveAuthReady();
    } else {
        console.log("👻 Modo Invitado");
        window.currentUserTier = 'free';
        window.currentUserPremiumUntil = null;
        window.currentStreakCount = 0;
        if (typeof window.updatePremiumTimeBadge === 'function') window.updatePremiumTimeBadge();
        if (typeof window.updateStreakBadge === 'function') window.updateStreakBadge();
        if (typeof window.updateDropdownPlanLabel === 'function') window.updateDropdownPlanLabel();
        if (typeof window.updatePremiumPromoFab === 'function') window.updatePremiumPromoFab();
        if (typeof window.updateReferralCard === 'function') window.updateReferralCard();
        if (typeof window.watchSupportUnread === 'function') window.watchSupportUnread(null); // corta el listener al cerrar sesión
        const userNameEl = document.getElementById('user-name');
        if (userNameEl) userNameEl.innerText = "Login";
        document.getElementById('user-initials').innerHTML = '<span class="material-symbols-outlined" style="font-size: 1.15rem;">person</span>';
        document.getElementById('user-avatar-img').style.display = 'none';
        document.getElementById('user-initials').style.display = 'flex';
        
        // 🚀 Si es invitado, dejar ver la pantalla de Auth de inmediato
        window.hideSplashScreen(true);

        if (typeof window.maybeShowPremiumPromo === 'function') window.maybeShowPremiumPromo();
        _resolveAuthReady();
    }
});

window.applyProfile = async (p) => {
    if (!p) return;
    const userNameElProfile = document.getElementById('user-name');
    if (userNameElProfile) userNameElProfile.innerText = p.name; // Actualizar nombre en la navbar
    document.getElementById('dropdown-profile-name').innerText = p.name; // Actualizar nombre en el dropdown
    document.getElementById('dropdown-active-profile').innerText = p.avatar || '🐯'; // Actualizar avatar en el dropdown
    
    // ✅ ACTUALIZAR AVATAR EN NAVBAR (Prioridad al animalito)
    const initials = document.getElementById('user-initials');
    const avatarImg = document.getElementById('user-avatar-img');
    
    if (p.avatar) {
        initials.innerText = p.avatar;
        initials.style.display = 'flex';
        initials.style.background = 'var(--primary-container)';
        initials.style.fontSize = '1.8rem';
        initials.style.lineHeight = '1';
        avatarImg.style.display = 'none';
    } else {
        // Fallback a la foto de Google si no hay avatar de perfil
        if (auth.currentUser && auth.currentUser.photoURL) {
            avatarImg.src = auth.currentUser.photoURL;
            avatarImg.style.display = 'block';
            initials.style.display = 'none';
        } else {
            initials.innerText = p.name.charAt(0);
            initials.style.display = 'flex';
            initials.style.background = 'var(--primary)'; // O algún color por defecto
            initials.style.fontSize = '1rem';
            avatarImg.style.display = 'none';
        }
    }
    
    _currentProfile = p;
    
    // Actualizar lastLogin en Firebase (v2.40)
    const user = auth.currentUser;
    if (user && p.id) {
        const profileRef = doc(db, "users", user.uid, "profiles", p.id);
        await updateDoc(profileRef, { lastLogin: Date.now() }).catch(e => console.warn("No se pudo actualizar lastLogin:", e));
    }
    
    window.loadContinueWatching(); // 🍿 Cargar historial al cambiar perfil
    await window.loadMyList(); // Cargar favoritos
    initApp(); // Re-renderizar el contenido principal
};

window.loadProfiles = async (uid) => {
    const profilesCol = collection(db, "users", uid, "profiles");
    let snap;
    try {
        snap = await getDocs(profilesCol);
    } catch (e) {
        console.warn("Fallo al cargar perfiles, reintentando:", e);
        try {
            snap = await getDocs(profilesCol);
        } catch (e2) {
            console.error("Reintento de carga de perfiles también falló, se aborta sin tocar la UI:", e2);
            if (window.showToast) {
                window.showToast("❌ No pudimos conectar con la selva. Revisa tu internet.", "error");
            }
            // Sin red no hay forma de confirmar los perfiles reales, pero si ya había uno activo
            // en esta sesión lo restauramos desde caché para que la app siga usable offline
            // (en vez de dejar la pantalla sin perfil ni selector).
            const savedOffline = localStorage.getItem('selva_active_profile');
            if (savedOffline) window.applyProfile(JSON.parse(savedOffline));
            return; // No asumir "sin perfiles" por un fallo de red
        }
    }
    const profiles = [];
    snap.forEach(d => profiles.push({ id: d.id, ...d.data() }));

    if (profiles.length === 0) {
        // Si ya había un perfil activo en esta sesión, una lectura vacía es un fallo de red/caché, no una cuenta nueva.
        const savedEmpty = localStorage.getItem('selva_active_profile');
        if (savedEmpty) {
            console.warn("Consulta de perfiles vacía pero hay un perfil activo en sesión; se omite el onboarding (probable fallo de red).");
            window.applyProfile(JSON.parse(savedEmpty));
            return;
        }
        // No adivinamos nombre/avatar: el usuario elige su primer perfil a mano (como Netflix).
        window.startFirstProfileOnboarding(uid);
        return;
    }

    // Retrocompatibilidad: Si ningún perfil es primario, establecer el primero
    const hasPrimary = profiles.some(p => p.isPrimary);
    if (!hasPrimary && profiles.length > 0) {
        profiles[0].isPrimary = true;
        const profileRef = doc(db, "users", uid, "profiles", profiles[0].id);
        await updateDoc(profileRef, { isPrimary: true }).catch(e => console.warn("No se pudo marcar perfil principal:", e));
    }

    window._allProfiles = profiles; // Guardar caché local
    window.renderProfiles(profiles);
    
    const saved = localStorage.getItem('selva_active_profile');
    if (!saved) {
        window.showProfileSelector();
    } else {
        _currentProfile = JSON.parse(saved);
        window.applyProfile(_currentProfile);
    }
};

let _isManagingProfiles = false;
window.toggleManageProfiles = () => {
    _isManagingProfiles = !_isManagingProfiles;
    const btn = document.getElementById('btn-manage-profiles');
    const title = document.getElementById('profile-selector-title');
    
    if (_isManagingProfiles) {
        btn.innerText = "LISTO";
        btn.style.background = "#FF6600";
        btn.style.color = "black";
        btn.style.borderColor = "#FF6600";
        title.innerText = "ADMINISTRAR PERFILES";
    } else {
        btn.innerText = "ADMINISTRAR PERFILES";
        btn.style.background = "none";
        btn.style.color = "#555";
        btn.style.borderColor = "#555";
        title.innerText = "¿QUIÉN ESTÁ VIENDO?";
    }
    
    // Recargar la vista de perfiles para mostrar/ocultar el lápiz de edición
    window.loadProfiles(auth.currentUser.uid);
};

// --- Auto-Limpieza de Perfiles (v2.40) ---
let _profilesToClean = [];

window.openCleanupModal = () => {
    document.getElementById('cleanup-modal').style.display = 'flex';
    window.previewCleanup();
};

window.closeCleanupModal = () => {
    document.getElementById('cleanup-modal').style.display = 'none';
};

window.previewCleanup = async () => {
    if (!auth.currentUser) return;
    const days = parseInt(document.getElementById('cleanup-days').value);
    const limitMs = days * 24 * 60 * 60 * 1000;
    const now = Date.now();
    
    const profilesCol = collection(db, "users", auth.currentUser.uid, "profiles");
    const snap = await getDocs(profilesCol);
    
    _profilesToClean = [];
    snap.forEach(doc => {
        const p = doc.data();
        // Si no tiene lastLogin, usamos createdAt o 0 por seguridad
        const lastActivity = p.lastLogin || p.createdAt || 0;
        if (now - lastActivity > limitMs) {
            _profilesToClean.push({ id: doc.id, name: p.name });
        }
    });

    const preview = document.getElementById('cleanup-preview');
    const countSpan = document.getElementById('cleanup-count');
    const executeBtn = document.getElementById('btn-do-cleanup');

    if (_profilesToClean.length > 0) {
        preview.style.display = 'block';
        countSpan.innerText = _profilesToClean.length;
        executeBtn.style.display = 'inline-block';
        executeBtn.innerText = `Eliminar ${_profilesToClean.length} perfiles 🗑️`;
    } else {
        preview.style.display = 'block';
        preview.innerHTML = "No se encontraron perfiles inactivos. ✨";
        executeBtn.style.display = 'none';
    }
};

window.executeCleanup = async () => {
    if (!confirm(`¿Estás seguro de eliminar ${_profilesToClean.length} perfiles permanentemente? Esta acción es irreversible. ⚠️`)) return;

    for (const p of _profilesToClean) {
        const profileRef = doc(db, "users", auth.currentUser.uid, "profiles", p.id);
        await deleteDoc(profileRef);
        console.log(`🧹 Perfil eliminado por inactividad: ${p.name}`);
    }

    alert(`¡Limpieza completada! Se eliminaron ${_profilesToClean.length} perfiles.`);
    window.closeCleanupModal();
    window.loadProfiles(auth.currentUser.uid);
};

const MAX_PROFILES_POR_CUENTA = 3;

window.renderProfiles = (profiles) => {
    const grid = document.getElementById('profiles-grid');
    if (!grid) return;

    grid.innerHTML = profiles.map(p => {
        const action = _isManagingProfiles 
            ? `window.editSpecificProfile('${p.id}', '${p.name}', '${p.avatar}', '${p.pin || ''}', ${p.isPrimary || false})`
            : `window.selectProfile('${p.id}', '${p.name}', '${p.avatar}', '${p.pin || ''}')`;
            
        const primaryBadge = p.isPrimary ? `<span style="position: absolute; top: -10px; left: -10px; font-size: 1.5rem; filter: drop-shadow(0 2px 5px rgba(0,0,0,0.5)); z-index: 5;" title="Perfil Principal">👑</span>` : '';

        return `
            <div class="profile-item" style="position: relative;">
                <div class="profile-item-avatar" onclick="${action}" style="cursor:pointer; transition: transform 0.2s; background: #222; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 3.5rem; margin: 0 auto 10px; border: 3px solid transparent; box-shadow: 0 10px 20px rgba(0,0,0,0.3); position: relative;" onmouseover="this.style.borderColor='white';" onmouseout="this.style.borderColor='transparent';">
                    ${primaryBadge}
                    ${p.avatar || '🐯'}
                    ${_isManagingProfiles ? `
                        <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                            <span style="font-size: 1.5rem;">✏️</span>
                        </div>
                    ` : ''}
                </div>
                ${_isManagingProfiles && !p.isPrimary ? `
                    <div onclick="event.stopPropagation(); window.deleteProfile('${p.id}', '${p.name}', '${p.pin || ''}', ${p.isPrimary || false})" style="position: absolute; top: -5px; right: 5px; width: 30px; height: 30px; background: #E74C3C; border-radius: 50%; color: white; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 1rem; box-shadow: 0 5px 15px rgba(231,76,60,0.5); z-index: 10;">
                        ✖
                    </div>
                ` : ''}
                <p style="text-align: center; color: #eee; font-size: 1.1rem; font-weight: 500;">${p.name}</p>
            </div>
        `;
    }).join('') + (profiles.length < MAX_PROFILES_POR_CUENTA ? `
        <div class="profile-item" onclick="window.showAddProfile()" style="cursor:pointer;">
            <div class="profile-item-avatar" style="background: none; border: 2px dashed #444; display: flex; align-items: center; justify-content: center; font-size: 3rem; margin: 0 auto 10px; color: #444;" onmouseover="this.style.borderColor='#888'; this.style.color='#888';" onmouseout="this.style.borderColor='#444'; this.style.color='#444';">
                <span style="font-size: 3rem;">+</span>
            </div>
            <p style="color: #444; font-size: 1.1rem;">Añadir</p>
        </div>
    ` : `
        <p style="width:100%; text-align:center; color:#555; font-size:0.85rem; margin-top:10px;">Máximo ${MAX_PROFILES_POR_CUENTA} perfiles por cuenta 🙈</p>
    `);
};

window.showProfileSelector = () => {
    document.getElementById('profile-selector-modal').style.display = 'flex';
    document.getElementById('user-dropdown').style.display = 'none';
};

let pendingProfile = null;

window.selectProfile = (id, name, avatar, pin) => {
    const p = { id, name, avatar, pin, action: 'login' };
    
    if (pin && pin.trim() !== "") {
        pendingProfile = p;
        document.getElementById('pin-profile-name').innerText = name;
        document.getElementById('pin-modal').style.display = 'flex';
        document.querySelectorAll('.pin-dot').forEach(i => i.value = '');
        document.getElementById('pin-1').focus();
    } else {
        localStorage.setItem('selva_active_profile', JSON.stringify(p));
        window.applyProfile(p);
        document.getElementById('profile-selector-modal').style.display = 'none';
        window.hideSplashScreen(); // 🚀 Perfil listo, fuera splash!
    }
};

window.focusNextPin = (el, nextId) => {
    if (el.value.length === 1) {
        document.getElementById(nextId)?.focus();
    }
};

window.closePinModal = () => {
    document.getElementById('pin-modal').style.display = 'none';
    pendingProfile = null;
    document.getElementById('pin-error-msg').style.display = 'none';
};

window.validatePinEntry = async (el) => {
    if (el.value.length === 0) return;
    
    const pinEntered = Array.from(document.querySelectorAll('.pin-dot')).map(i => i.value).join('');
    if (pinEntered.length < 4) return;

    if (pendingProfile.action === 'verify-main-pin') {
        if (pinEntered === pendingProfile.mainPinToVerify) {
            try {
                const uid = auth.currentUser.uid;
                const profileRef = doc(db, "users", uid, "profiles", pendingProfile.id);
                await updateDoc(profileRef, { pin: "" });
                if (window.showToast) window.showToast(`¡PIN restablecido con éxito! 🔓`, "success");
                
                const p = { ...pendingProfile };
                delete p.pin;
                delete p.action;
                delete p.mainPinToVerify;
                window.closePinModal();
                localStorage.setItem('selva_active_profile', JSON.stringify(p));
                window.applyProfile(p);
                document.getElementById('profile-selector-modal').style.display = 'none';
                window.hideSplashScreen();
                
                window.loadProfiles(uid);
            } catch (e) {
                console.error("Error al restablecer PIN por verificación principal:", e);
            }
        } else {
            document.getElementById('pin-error-msg').style.display = 'block';
            document.querySelectorAll('.pin-dot').forEach(i => i.value = '');
            document.getElementById('pin-1').focus();
        }
        return;
    }

    if (pinEntered === pendingProfile.pin) {
        window.closePinModal();
        
        if (pendingProfile.action === 'edit') {
            window.openEditModal(pendingProfile.id, pendingProfile.name, pendingProfile.avatar, pendingProfile.pin, pendingProfile.isPrimary);
        } else if (pendingProfile.action === 'delete') {
            window.executeProfileDeletion(pendingProfile.id, pendingProfile.name, pendingProfile.isPrimary);
        } else {
            const p = { ...pendingProfile };
            delete p.pin; // Seguridad mínima
            delete p.action;
            localStorage.setItem('selva_active_profile', JSON.stringify(p));
            window.applyProfile(p);
            document.getElementById('profile-selector-modal').style.display = 'none';
            window.hideSplashScreen();
        }
    } else {
        document.getElementById('pin-error-msg').style.display = 'block';
        document.querySelectorAll('.pin-dot').forEach(i => i.value = '');
        document.getElementById('pin-1').focus();
    }
};

window.forgotPin = async () => {
    if (!pendingProfile) return;
    
    const mainProfile = window._allProfiles ? window._allProfiles.find(p => p.isPrimary) : null;
    if (!mainProfile) {
        if (window.showToast) window.showToast("No se encontró el perfil principal para recuperar el PIN.", "error");
        return;
    }
    
    const uid = auth.currentUser.uid;
    
    if (pendingProfile.id === mainProfile.id) {
        if (confirm(`¿Restablecer el PIN del perfil principal "${pendingProfile.name}"? Como dueño de la cuenta de Google, puedes desbloquearlo de inmediato.`)) {
            try {
                const profileRef = doc(db, "users", uid, "profiles", mainProfile.id);
                await updateDoc(profileRef, { pin: "" });
                if (window.showToast) window.showToast("PIN del perfil principal restablecido. 🔓", "success");
                
                const p = { ...pendingProfile };
                delete p.pin;
                delete p.action;
                window.closePinModal();
                localStorage.setItem('selva_active_profile', JSON.stringify(p));
                window.applyProfile(p);
                document.getElementById('profile-selector-modal').style.display = 'none';
                window.hideSplashScreen();
                
                window.loadProfiles(uid);
            } catch (e) {
                console.error("Error al restablecer PIN principal:", e);
                if (window.showToast) window.showToast("Error al restablecer el PIN.", "error");
            }
        }
        return;
    }
    
    if (mainProfile.pin && mainProfile.pin.trim() !== "") {
        pendingProfile.action = 'verify-main-pin';
        pendingProfile.mainPinToVerify = mainProfile.pin;
        
        document.getElementById('pin-profile-name').innerText = `Ingresa PIN de ${mainProfile.name} (Principal)`;
        document.getElementById('pin-error-msg').style.display = 'none';
        document.querySelectorAll('.pin-dot').forEach(i => i.value = '');
        document.getElementById('pin-1').focus();
        if (window.showToast) window.showToast(`Por favor introduce el PIN de ${mainProfile.name} para desbloquear este perfil.`, "info");
    } else {
        if (confirm(`¿Restablecer el PIN del perfil "${pendingProfile.name}" usando el perfil principal "${mainProfile.name}"?`)) {
            try {
                const profileRef = doc(db, "users", uid, "profiles", pendingProfile.id);
                await updateDoc(profileRef, { pin: "" });
                if (window.showToast) window.showToast(`¡PIN de "${pendingProfile.name}" restablecido! 🔓`, "success");
                
                const p = { ...pendingProfile };
                delete p.pin;
                delete p.action;
                window.closePinModal();
                localStorage.setItem('selva_active_profile', JSON.stringify(p));
                window.applyProfile(p);
                document.getElementById('profile-selector-modal').style.display = 'none';
                window.hideSplashScreen();
                
                window.loadProfiles(uid);
            } catch (e) {
                console.error("Error al restablecer PIN de perfil secundario:", e);
                if (window.showToast) window.showToast("Error al restablecer el PIN.", "error");
            }
        }
    }
};

window.editSpecificProfile = (id, name, avatar, pin = '', isPrimary = false) => {
    if (pin && pin.trim() !== "") {
        pendingProfile = { id, name, avatar, pin, action: 'edit', isPrimary };
        document.getElementById('pin-profile-name').innerText = name + " (Editar)";
        document.getElementById('pin-modal').style.display = 'flex';
        document.querySelectorAll('.pin-dot').forEach(i => i.value = '');
        document.getElementById('pin-1').focus();
    } else {
        window.openEditModal(id, name, avatar, pin, isPrimary);
    }
};

window.openEditModal = (id, name, avatar, pin, isPrimary = false) => {
    window.updateSettingsAccountInfo();
    const input = document.getElementById('edit-profile-name-input');
    const pinInput = document.getElementById('edit-profile-pin-input');
    const modal = document.getElementById('profile-edit-name-modal');
    const saveBtn = document.getElementById('btn-save-profile-name');
    const deleteBtn = document.getElementById('btn-delete-profile');
    
    if (input) input.value = name;
    if (pinInput) pinInput.value = pin;
    if (modal) modal.style.display = 'flex';
    
    if (deleteBtn) {
        if (isPrimary) {
            deleteBtn.style.display = 'none';
        } else {
            deleteBtn.style.display = 'block';
            deleteBtn.onclick = () => window.deleteProfile(id, name, pin, isPrimary);
        }
    }
    
    saveBtn.onclick = () => {
        const newName = input.value.trim();
        const newPin = pinInput.value.trim();
        if (!newName) return;
        if (newPin && newPin.length !== 4) return alert("El PIN debe ser de 4 dígitos. 🔒");
        
        window._tempProfileToUpdate = { id, name: newName, pin: newPin, isPrimary };
        modal.style.display = 'none';
        window.openAvatarPicker();
    };
};

window.deleteProfile = async (id, name, pin = '', isPrimary = false) => {
    if (isPrimary) {
        if (window.showToast) window.showToast("El perfil principal no se puede eliminar. 👑", "warning");
        return;
    }
    if (pin && pin.trim() !== "") {
        pendingProfile = { id, name, pin, action: 'delete', isPrimary };
        document.getElementById('pin-profile-name').innerText = name + " (Borrar)";
        document.getElementById('pin-modal').style.display = 'flex';
        document.querySelectorAll('.pin-dot').forEach(i => i.value = '');
        document.getElementById('pin-1').focus();
        return;
    }
    
    window.executeProfileDeletion(id, name, isPrimary);
};

window.executeProfileDeletion = async (id, name, isPrimary = false) => {
    if (isPrimary) {
        if (window.showToast) window.showToast("El perfil principal no se puede eliminar. 👑", "warning");
        return;
    }
    if (!confirm(`¿Estás seguro que deseas eliminar el perfil "${name}"? Esta acción no se puede deshacer. 🗑️`)) return;

    try {
        const uid = auth.currentUser.uid;
        
        const profilesCol = collection(db, "users", uid, "profiles");
        const snap = await getDocs(profilesCol);
        if (snap.size <= 1) {
            if (window.showToast) window.showToast("No puedes eliminar tu último perfil. ¡Siempre necesitas al menos un aventurero en la selva! 🦁", "warning");
            return;
        }

        const profileRef = doc(db, "users", uid, "profiles", id);
        await deleteDoc(profileRef);
        console.log(`✅ Perfil ${name} eliminado.`);
        
        document.getElementById('profile-edit-name-modal').style.display = 'none';
        window.loadProfiles(uid);

        if (_currentProfile && _currentProfile.id === id) {
            localStorage.removeItem('selva_active_profile');
            _currentProfile = null;
            window.showProfileSelector();
        }
    } catch (e) {
        console.error("❌ Error al eliminar perfil:", e);
        if (window.showToast) window.showToast("Ocurrió un error al intentar eliminar el perfil.", "error");
    }
};

window.openAvatarPicker = (isOnboarding = false) => {
    console.log("🐾 Abriendo Selector de Personajes...");
    const modal = document.getElementById('avatar-selector-modal');
    const grid = document.getElementById('avatar-options-grid');
    const backBtn = document.getElementById('btn-avatar-back');
    const avatars = ['🦁', '🐯', '🦒', '🐘', '🐊', '🦜', '🦥', '🐺', '🦊', '🐶', '🐱', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵'];

    if (grid) {
        grid.innerHTML = avatars.map(a => `
            <div onclick="window.finalizeProfileUpdate('${a}')" style="font-size: 3rem; cursor: pointer; padding: 10px; border-radius: 10px; transition: background 0.2s; display: flex; align-items: center; justify-content: center;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='none'">
                ${a}
            </div>
        `).join('');
    }

    if (backBtn) backBtn.style.display = isOnboarding ? 'none' : 'block';

    if (modal) {
        modal.style.display = 'flex';
        modal.style.zIndex = '30000'; // Asegurar que esté por encima de todo
    }
};

window.finalizeProfileUpdate = async (avatar) => {
    const { id, name } = window._tempProfileToUpdate || {};
    const uid = auth.currentUser.uid;
    
    if (id) {
        // Actualizar existente
        const profileRef = doc(db, "users", uid, "profiles", id);
        await updateDoc(profileRef, { name, avatar, pin: window._tempProfileToUpdate.pin || '' });
    } else {
        // Crear nuevo
        const profilesCol = collection(db, "users", uid, "profiles");
        await addDoc(profilesCol, {
            name: window._tempProfileToUpdate.name,
            avatar,
            pin: window._tempProfileToUpdate.pin || '',
            isChild: false,
            isPrimary: window._tempProfileToUpdate.isPrimary || false,
            createdAt: Date.now(),
            lastLogin: Date.now()
        });
    }
    
    document.getElementById('avatar-selector-modal').style.display = 'none';
    window.loadProfiles(uid);
    
    // Si era el perfil actual, actualizar caché local
    if (_currentProfile && _currentProfile.id === id) {
        _currentProfile.name = name;
        _currentProfile.avatar = avatar;
        localStorage.setItem('selva_active_profile', JSON.stringify(_currentProfile));
        window.applyProfile(_currentProfile);
    }
};

// Primer perfil de la cuenta: el usuario elige nombre + avatar en vez de que
// el código adivine (antes ponía el primer nombre de Google + 🐯 fijo, y si
// esta lógica corría dos veces por algún hipo de conexión, terminaba creando
// un segundo perfil "principal" fantasma).
window.startFirstProfileOnboarding = (uid) => {
    window.updateSettingsAccountInfo();
    const input = document.getElementById('edit-profile-name-input');
    const pinInput = document.getElementById('edit-profile-pin-input');
    const modal = document.getElementById('profile-edit-name-modal');
    const saveBtn = document.getElementById('btn-save-profile-name');
    const deleteBtn = document.getElementById('btn-delete-profile');
    const cancelBtn = document.getElementById('btn-cancel-profile-name');
    const title = document.getElementById('profile-edit-modal-title');

    const suggestedName = (auth.currentUser?.displayName || '').split(' ')[0] || '';
    if (input) input.value = suggestedName;
    if (pinInput) pinInput.value = "";
    if (title) title.textContent = '¡Bienvenido! Crea tu primer perfil 🌴';
    if (modal) modal.style.display = 'flex';
    if (deleteBtn) deleteBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = 'none'; // no hay a dónde volver: todavía no tiene perfiles

    saveBtn.onclick = () => {
        const name = input.value.trim();
        const pin = pinInput.value.trim();
        if (!name) { if (window.showToast) window.showToast("Dinos un nombre. 🐯", "warning"); return; }
        if (pin && pin.length !== 4) { if (window.showToast) window.showToast("El PIN debe ser de 4 dígitos. 🔒", "warning"); return; }

        window._tempProfileToUpdate = { name, pin, isPrimary: true };
        modal.style.display = 'none';
        window.openAvatarPicker(true);
    };
};

window.showAddProfile = async () => {
    if ((window._allProfiles?.length || 0) >= MAX_PROFILES_POR_CUENTA) {
        if (window.showToast) window.showToast(`Máximo ${MAX_PROFILES_POR_CUENTA} perfiles por cuenta. Elimina uno para crear otro. 🙈`, 'warning');
        return;
    }
    window.updateSettingsAccountInfo();
    const input = document.getElementById('edit-profile-name-input');
    const pinInput = document.getElementById('edit-profile-pin-input');
    const modal = document.getElementById('profile-edit-name-modal');
    const saveBtn = document.getElementById('btn-save-profile-name');
    const deleteBtn = document.getElementById('btn-delete-profile');
    
    if (input) input.value = "";
    if (pinInput) pinInput.value = "";
    if (modal) modal.style.display = 'flex';
    
    // Ocultar botón eliminar porque estamos creando, no editando
    if (deleteBtn) deleteBtn.style.display = 'none';
    
    saveBtn.onclick = () => {
        const name = input.value.trim();
        const pin = pinInput.value.trim();
        if (!name) { if (window.showToast) window.showToast("Dinos un nombre. 🐯", "warning"); return; }
        if (pin && pin.length !== 4) { if (window.showToast) window.showToast("El PIN debe ser de 4 dígitos. 🔒", "warning"); return; }

        window._tempProfileToUpdate = { name, pin }; // Nuevo perfil
        modal.style.display = 'none';
        window.openAvatarPicker();
    };
};

// --- FASE 2: CONTINUAR VIENDO (Retención) ---
window.syncPlaybackProgress = async (movie, lastTime, duration, episodeId = null, episodeLabel = null) => {
    if (!auth.currentUser || !_currentProfile) return;

    const historyRef = doc(db, "users", auth.currentUser.uid, "profiles", _currentProfile.id, "history", movie.id);
    
    let season = null;
    let episode = null;
    if (episodeId) {
        const match = episodeId.match(/s(\d+)e(\d+)/i);
        if (match) {
            season = parseInt(match[1]);
            episode = parseInt(match[2]);
        }
    }

    await setDoc(historyRef, {
        movieId: movie.id,
        title: movie.title || movie.name,
        poster: movie.img || movie.poster_path,
        backdrop: movie.backdrop || movie.backdrop_path || movie.img || movie.poster_path,
        type: movie.type,
        lastTime,
        duration,
        season,
        episode,
        episodeLabel,
        timestamp: Date.now()
    }, { merge: true });
    
    console.log(`🎬 Progreso guardado: ${movie.title} ${episodeLabel ? `(${episodeLabel})` : ''} (${lastTime}s)`);
};

// Versión ligera de lo anterior: sin lastTime/duration (eso solo existe con
// video nativo). Guarda en qué capítulo va el usuario para que la próxima
// vez que abra la serie, el selector de temporada/capítulo arranque ahí.
window.markWatchingEpisode = (movie, season, episode, episodeLabel) => {
    if (!auth.currentUser || !_currentProfile || !movie?.id) return;

    const historyRef = doc(db, "users", auth.currentUser.uid, "profiles", _currentProfile.id, "history", movie.id);
    setDoc(historyRef, {
        movieId: movie.id,
        title: movie.title || movie.name,
        poster: movie.img || movie.poster_path,
        backdrop: movie.backdrop || movie.backdrop_path || movie.img || movie.poster_path,
        type: movie.type,
        season,
        episode,
        episodeLabel,
        timestamp: Date.now()
    }, { merge: true }).catch(e => console.warn("No se pudo registrar el capítulo en Continuar Viendo:", e));
};

window.loadContinueWatching = async () => {
    if (!auth.currentUser || !_currentProfile) return;
    try {
        const historyCol = collection(db, "users", auth.currentUser.uid, "profiles", _currentProfile.id, "history");
        const q = query(historyCol, orderBy("timestamp", "desc"), limit(10));
        const snap = await getDocs(q);
        
        const history = [];
        snap.forEach(d => history.push(d.data()));
        console.log("📺 Historial recuperado:", history);
        
        const container = document.getElementById('continue-watching-row');
        if (!container) return;

        // Solo en el Home: dentro de Películas o Series estorba, ahí el usuario
        // viene a explorar el catálogo, no a retomar.
        if (history.length === 0 || _currentFilter) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        const grid = document.getElementById('continue-watching-grid');
        if (!grid) return;
        
        // Sin barra de progreso: solo mostramos qué se empezó a ver, sin
        // pretender saber en qué minuto quedó (eso solo es fiable con el
        // <video> nativo, que es la minoría de las reproducciones reales).
        grid.innerHTML = history.map(h => {
            // La tarjeta es horizontal (card-horizontal-*), así que le pega mejor
            // el banner (16:9) que el póster (2:3) — antes usaba el póster siempre
            // y quedaba recortado/forzado. Para entradas viejas que se guardaron
            // antes de este cambio (sin "backdrop" en el historial), se busca el
            // dato actual en el catálogo ya cargado en memoria en vez de esperar
            // a que el usuario vea algo de nuevo para que se "autorepare".
            const movieActual = movieDatabase.trending.find(m => m.id === h.movieId);
            const raw = h.backdrop || movieActual?.backdrop || h.poster || movieActual?.img;
            const img = (raw && raw.startsWith('http')) ? raw : 'https://image.tmdb.org/t/p/w300' + (raw || h.poster_path);
            const safeTitle = (h.title || '').replace(/'/g, "\\'");
            return `
                <div class="card-horizontal-container" tabindex="0" role="button" data-tvnav onclick="window.resumeContinueWatching('${h.movieId}', '${safeTitle}', ${h.season || 0}, ${h.episode || 0}, ${h.lastTime || 0})">
                    <div class="card-horizontal-media">
                        <img src="${img}" alt="${h.title}" loading="lazy" onerror="this.src='/icon_192.png'">
                    </div>
                    <div class="card-horizontal-title">${h.title}</div>
                    <div class="card-horizontal-subtitle">${h.episodeLabel || ''}</div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error("❌ ERROR CRITICO en loadContinueWatching:", e);
    }
};

window._myListIds = new Set();

window.toggleMyList = async (movieId, btn) => {
    if (!auth.currentUser || !_currentProfile) {
        if (window.showToast) window.showToast("Inicia sesion para guardar tus favoritos", "primary");
        return;
    }
    const movie = movieDatabase.trending.find(m => String(m.id) === String(movieId));
    if (!movie) return;
    const listRef = doc(db, "users", auth.currentUser.uid, "profiles", _currentProfile.id, "mylist", movieId);
    if (window._myListIds.has(movieId)) {
        await deleteDoc(listRef);
        window._myListIds.delete(movieId);
        btn.classList.remove("active");
        if (btn.classList.contains("hero-btn-add")) { btn.innerHTML = "<span>+</span> Mi Lista"; } else { btn.innerHTML = String.fromCharCode(0x1F90D); }
    } else {
        await setDoc(listRef, { movieId: movie.id, title: movie.title || movie.name, poster: movie.img || movie.poster_path, type: movie.type, timestamp: Date.now() });
        window._myListIds.add(movieId);
        btn.classList.add("active", "heart-animation");
        if (btn.classList.contains("hero-btn-add")) { btn.innerHTML = "<span>checkmark</span> Agregado"; } else { btn.innerHTML = String.fromCharCode(0x2764, 0xFE0F); }
        setTimeout(() => btn.classList.remove("heart-animation"), 400);
    }
    const badge = document.getElementById("nav-fav-count");
    if (badge) {
        if (window._myListIds.size === 0) { badge.style.display = "none"; } else { badge.innerText = window._myListIds.size; badge.style.display = "block"; }
    }
    await window.loadMyList();
    initApp(_currentFilter);
};

window.toggleMyListModal = () => {
    const modal = document.getElementById("my-list-modal");
    if (!modal) return;
    const isVisible = modal.style.display === "flex";
    modal.style.display = isVisible ? "none" : "flex";
    document.body.style.overflow = isVisible ? "" : "hidden";
    if (!isVisible) window.loadMyList();
};

window.loadMyList = async () => {
    if (!auth.currentUser || !_currentProfile) return;
    const listCol = collection(db, "users", auth.currentUser.uid, "profiles", _currentProfile.id, "mylist");
    const q = query(listCol, orderBy("timestamp", "desc"));
    const snap = await getDocs(q);
    const crudo = [];
    snap.forEach(d => crudo.push(d.data()));

    // Un título borrado del todo del catálogo (no solo fusionado con un
    // duplicado) se queda para siempre en "Mi Lista" -- la tarjeta se arma
    // con el poster/título guardados acá mismo, sin depender del catálogo
    // real, así que nunca se entera de que ya no existe. Se limpia acá: si
    // ni el ID ni el título matchean contra el catálogo actual, se borra la
    // entrada de Firestore (igual que el botón ✕) y no se muestra.
    const myList = [];
    const muertos = [];
    for (const data of crudo) {
        const existe = movieDatabase?.trending?.some(m =>
            m.id === data.movieId || (m.title || '').toLowerCase().trim() === (data.title || '').toLowerCase().trim()
        );
        if (existe) myList.push(data);
        else muertos.push(data);
    }
    if (muertos.length > 0 && auth.currentUser && _currentProfile) {
        for (const m of muertos) {
            deleteDoc(doc(db, "users", auth.currentUser.uid, "profiles", _currentProfile.id, "mylist", m.movieId))
                .catch(e => console.warn('No se pudo limpiar entrada muerta de Mi Lista:', m.title, e));
        }
    }

    window._myListIds.clear();
    myList.forEach(data => window._myListIds.add(data.movieId));
    const badge = document.getElementById("nav-fav-count");
    const buildCard = (m) => {
        const p = (m.poster || "").startsWith("http") ? m.poster : "https://image.tmdb.org/t/p/w300" + m.poster;
        // Mismo caso que "Continuar viendo": el movieId guardado acá al momento
        // de agregar a Mi Lista puede quedar muerto si el catálogo se fusiona
        // con un duplicado más tarde. Se pasa el título para que handleCardClick
        // pueda autorepararse por nombre en vez de mandar a "Contenido no encontrado".
        const safeTitle = (m.title || "").replace(/'/g, "\\'");
        return `<div class="mylist-card" onclick="window.handleCardClick('${m.movieId}', '${safeTitle}')"><div class="mylist-card-bg" style="background-image:url('${p}');"></div><div class="mylist-card-gradient"></div><div class="mylist-card-overlay"><button class="mylist-play-btn" onclick="event.stopPropagation();window.handleCardClick('${m.movieId}', '${safeTitle}')"><span class="material-symbols-outlined">play_arrow</span></button><button class="mylist-remove-btn" onclick="event.stopPropagation();window.toggleMyList('${m.movieId}',this)"><span class="material-symbols-outlined">close</span></button></div><div class="mylist-card-title">${m.title}</div></div>`;
    };
    const empty = `<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:rgba(255,255,255,0.3);"><span class="material-symbols-outlined" style="font-size:48px;display:block;margin-bottom:12px;">bookmarks</span><p style="font-family:'Sora',sans-serif;font-size:1rem;margin:0;">Tu selva esta vacia...</p></div>`;
    const setGrids = (html) => {
        const pg = document.getElementById("my-list-page-grid"); if (pg) pg.innerHTML = html;
        const mg = document.getElementById("modal-my-list-grid"); if (mg) mg.innerHTML = html;
    };
    const setCount = (n) => {
        const tc = document.getElementById("mylist-tab-count"); if (tc) tc.textContent = n + " titulos";
        const mb = document.getElementById("modal-fav-count"); if (mb) mb.textContent = n + " Titulos";
    };
    if (myList.length === 0) {
        if (badge) badge.style.display = "none";
        setCount(0); setGrids(empty); return;
    }
    if (badge) { badge.innerText = myList.length; badge.style.display = "block"; }
    setCount(myList.length);
    setGrids(myList.map(buildCard).join(""));
};
// Cerrar dropdown al hacer clic fuera
window.addEventListener('click', (e) => {
    const container = document.getElementById('user-profile-container');
    const dropdown = document.getElementById('user-dropdown');
    if (container && !container.contains(e.target)) {
        if (dropdown) dropdown.style.display = 'none';
    }
});

// ─── Previsualización del Reproductor y Generador de Fuentes ──────────────────
window.updateMiniPlayer = () => {
  let embedUrl = document.getElementById('m-embed').value.trim();
  const placeholder = document.getElementById('mini-player-placeholder');
  const iframe = document.getElementById('mini-player-iframe');

  if (!embedUrl) {
    if (placeholder) placeholder.style.display = 'flex';
    if (iframe) {
      iframe.style.display = 'none';
      iframe.src = 'about:blank';
    }
    return;
  }

  // El campo a veces trae el <iframe ...> completo pegado en vez de solo
  // la URL — mismo criterio que Player.js/limpiarEmbed, para que la vista
  // previa muestre lo mismo que va a ver el usuario real (antes intentaba
  // usar el HTML entero como URL y no cargaba nada).
  if (embedUrl.includes('<iframe')) {
    const m = embedUrl.match(/src="([^"]+)"/);
    if (m) embedUrl = m[1];
  }

  if (placeholder) placeholder.style.display = 'none';
  if (iframe) {
    iframe.style.display = 'block';
    iframe.src = embedUrl;
  }
};

window.stopMiniPlayer = () => {
  const placeholder = document.getElementById('mini-player-placeholder');
  const iframe = document.getElementById('mini-player-iframe');
  if (placeholder) placeholder.style.display = 'flex';
  if (iframe) {
    iframe.style.display = 'none';
    iframe.src = 'about:blank';
  }
};

// Chequea las mismas fuentes que sigue el reproductor real (Vimeus ->
// DiPelis -> RepelisHD -> PelisMart -> FlixLatam), revisando TODAS SIEMPRE
// (no se corta en la primera que funciona) para poder mostrar la lista
// completa de qué servidores tiene. Extraído a función propia para que lo
// use tanto la prueba de un solo título (previewVimeusAuto) como la prueba
// en lote de varios resultados de TMDb a la vez (checkSourcesForSelectedTMDB).
async function _checkFuentesDeTitulo({ tmdbId, imdbId, title, type }) {
  const isTv = (type === 'series' || type === 'tv' || type === 'anime');
  const workerCheck = (params) => fetch(`${SelvaStream.MASTER_WORKER_URL}/flix/check?${params}`, {
    headers: { 'x-selva-auth': SelvaStream.AUTH_TOKEN }
  }).then(r => r.json()).then(d => !!d.available).catch(() => false);

  const resultados = []; // { name, ok, url, nota }

  // 1) Vimeus
  const tipoVimeus = type === 'anime' ? 'anime' : (isTv ? 'serie' : 'movie');
  const estadoVimeus = await vimeusEstadoTitulo(tmdbId, imdbId, tipoVimeus);
  const idParam = tmdbId ? `tmdb=${tmdbId}` : `imdb=${imdbId}`;
  resultados.push({
    name: 'Vimeus',
    ok: estadoVimeus === 'ok',
    url: estadoVimeus === 'ok' ? `https://vimeus.com/e/${tipoVimeus}?${idParam}&view_key=${SelvaStream.VIMEUS_VIEW_KEY}` : null,
    nota: estadoVimeus === 'fantasma' ? 'fantasma (matchea pero sin video real)' : null
  });

  if (isTv) {
    // Series: el reproductor real tiene Vimeus + PelisMart + FlixLatam como respaldo.
    if (imdbId) {
      const pelismartOk = await workerCheck(`provider=pelismart&imdb=${imdbId}`);
      resultados.push({ name: 'PelisMart', ok: pelismartOk, url: pelismartOk ? `https://pelismart.mov/vidurl/${imdbId}/` : null });

      const flixOk = await workerCheck(`provider=flixlatam&imdb=${imdbId}`);
      resultados.push({ name: 'FlixLatam', ok: flixOk, url: flixOk ? `https://flixlatam.com/vidurl/${imdbId}/` : null });
    } else {
      resultados.push({ name: 'PelisMart', ok: false, url: null, nota: 'sin IMDB ID' });
      resultados.push({ name: 'FlixLatam', ok: false, url: null, nota: 'sin IMDB ID' });
    }
  } else {
    // Peliculas: DiPelis -> RepelisHD -> FlixLatam (mismo orden que el player real)
    const slug = title ? title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') : '';

    let dipelisUrl = null;
    if (slug) {
      try {
        const d = await fetch(`${SelvaStream.MASTER_WORKER_URL}/flix/dipelis?slug=${encodeURIComponent(slug)}`, {
          headers: { 'x-selva-auth': SelvaStream.AUTH_TOKEN }
        }).then(r => r.json());
        if (d && d.url) dipelisUrl = d.url;
      } catch (e) { /* se cuenta como no disponible */ }
    }
    resultados.push({ name: 'DiPelis', ok: !!dipelisUrl, url: dipelisUrl });

    if (imdbId) {
      const repelisOk = await workerCheck(`provider=repelishd&imdb=${imdbId}`);
      resultados.push({ name: 'RepelisHD', ok: repelisOk, url: repelisOk ? `https://verhdlink.cam/movie/${imdbId}` : null });

      const pelismartOk = await workerCheck(`provider=pelismart&imdb=${imdbId}`);
      resultados.push({ name: 'PelisMart', ok: pelismartOk, url: pelismartOk ? `https://pelismart.mov/vidurl/${imdbId}/` : null });

      const flixOk = await workerCheck(`provider=flixlatam&imdb=${imdbId}`);
      resultados.push({ name: 'FlixLatam', ok: flixOk, url: flixOk ? `https://flixlatam.com/vidurl/${imdbId}/` : null });
    } else {
      resultados.push({ name: 'RepelisHD', ok: false, url: null, nota: 'sin IMDB ID' });
      resultados.push({ name: 'PelisMart', ok: false, url: null, nota: 'sin IMDB ID' });
      resultados.push({ name: 'FlixLatam', ok: false, url: null, nota: 'sin IMDB ID' });
    }
  }

  return resultados;
}

function _renderFuentesList(resultados, primeraDisponible) {
  const dbIdActual = document.getElementById('m-db-id')?.value || '';
  return resultados.map((r, i) => {
    const esFantasma = r.nota && r.nota.indexOf('fantasma') !== -1;
    const icono = r.ok ? '✅' : (esFantasma ? '👻' : '❌');
    const color = r.ok ? '#2ecc71' : (esFantasma ? '#9b59b6' : '#666');
    const esLaCargada = primeraDisponible && r === primeraDisponible;
    
    // Botón para subir a VOE directamente desde el modal de Admin
    const providerKey = (r.name || '').toLowerCase().replace(/\s+/g, '');
    const esExportable = r.ok && dbIdActual && ['vimeus', 'flixlatam', 'pelismart', 'repelishd'].includes(providerKey);
    const exportBtnHtml = esExportable ? `
      <button type="button" class="btn" style="font-size:0.65rem; padding:3px 8px; cursor:pointer; background:#ff571a; border:none; color:#fff; font-weight:bold; border-radius:4px; margin-left:6px;"
              onclick="window.selvaExecuteDirectExport('${dbIdActual}', '${providerKey}')"
              title="Extraer link real y subir a tu cuenta de VOE.sx">
        📤 Subir a VOE
      </button>
    ` : '';

    return `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 10px; border-radius:6px; background:${esLaCargada ? 'rgba(46,204,113,0.08)' : 'rgba(255,255,255,0.03)'}; border:1px solid ${esLaCargada ? 'rgba(46,204,113,0.25)' : 'rgba(255,255,255,0.06)'};">
        <span style="font-size:0.75rem; color:#ccc;">#${i + 1} ${r.name}${esLaCargada ? ' (mostrando esta)' : ''}</span>
        <div style="display:flex; align-items:center;">
          <span style="font-size:0.75rem; color:${color}; font-weight:700;">${icono} ${r.nota || (r.ok ? 'Disponible' : 'No disponible')}</span>
          ${exportBtnHtml}
        </div>
      </div>
    `;
  }).join('');
}

// Direct export helper desde el modal de Admin — va directo al pipeline sin
// pasar por selvaExecuteExportToHosting (que requiere lastScrapedStreams con title y url válidos).
window.selvaExecuteDirectExport = async (movieId, providerKey) => {
  if (localStorage.getItem('selva_admin_auth') !== 'true') return;
  const nameMap = { vimeus: 'Vimeus', flixlatam: 'FlixLatam', pelismart: 'PelisMart', repelishd: 'RepelisHD' };
  const providerName = nameMap[providerKey] || providerKey;

  if (!movieId) {
    if (window.showToast) window.showToast('❌ Guarda la película primero antes de subir a VOE.', 'error');
    return;
  }

  if (window.showToast) window.showToast(`🔍 Extrayendo links de ${providerName}...`, 'info');

  try {
    const { SelvaStream } = await import('./components/Player/Player.js');
    const { ExportManager } = await import('./utils/exportManager.js');

    // 1. Buscar datos del título en el inventario local
    const movie = _allInventoryItems.find(m => m.id === movieId);
    const imdbId = movie?.imdbId || movie?.imdb_id || '';
    const tmdbId = String(movie?.tmdbId || movie?.tmdb_id || '');
    const type = movie?.type || 'movie';

    if (!imdbId && !tmdbId) {
      if (window.showToast) window.showToast('❌ La película no tiene IMDB ID ni TMDB ID guardado.', 'error');
      return;
    }

    // 2. Extraer links via el worker
    const links = await ExportManager.extractLinks({
      provider: providerKey,
      imdbId,
      tmdbId,
      type,
      workerUrl: SelvaStream.MASTER_WORKER_URL,
      authToken: SelvaStream.AUTH_TOKEN
    });

    const best = ExportManager.pickBestLink(links);
    if (!best) {
      if (window.showToast) window.showToast(`⚠️ ${providerName} no devolvió links válidos para esta película.`, 'warning');
      return;
    }

    if (window.showToast) window.showToast(`✅ Link extraído (${best.servername}). Enviando a VOE.sx...`, 'success');
    console.log('[DirectExport] Mejor link:', best);

    // 3. Subir a VOE
    const voeKey = SelvaStream.VOE_API_KEY;
    if (!voeKey) {
      if (window.showToast) window.showToast('❌ Falta VITE_VOE_API_KEY en la configuración.', 'error');
      return;
    }

    await ExportManager.startVoeUpload({
      movieId,
      sourceUrl: best.link,
      voeKey,
      onUpdate: async (update) => {
        if (update.message && window.showToast) {
          window.showToast(update.message, update.phase === 'done' ? 'success' : 'info');
        }
        // Guardar en Firestore cuando termina
        if (update.phase === 'done' || update.url) {
          try {
            const { getFirestore, doc, updateDoc } = await import('firebase/firestore');
            const db = getFirestore();
            const updObj = { exportStatus: update.phase, updatedAt: Date.now() };
            if (update.url) updObj.embed = update.url;
            if (update.fileCode) updObj.exportFileId = update.fileCode;
            await updateDoc(doc(db, 'movies', movieId), updObj);
            const memItem = _allInventoryItems.find(m => m.id === movieId);
            if (memItem) { memItem.exportStatus = update.phase; if (update.url) memItem.embed = update.url; }
            if (window.filterInventoryByCategory) window.filterInventoryByCategory();
          } catch(e) { console.warn('[DirectExport] Error guardando en Firestore:', e); }
        }
      }
    });

    // Marcar como 'processing' en Firestore inmediatamente
    try {
      const { getFirestore, doc, updateDoc } = await import('firebase/firestore');
      const db = getFirestore();
      await updateDoc(doc(db, 'movies', movieId), { exportStatus: 'processing', updatedAt: Date.now() });
      const memItem = _allInventoryItems.find(m => m.id === movieId);
      if (memItem) memItem.exportStatus = 'processing';
    } catch(e) { console.warn('[DirectExport] No se pudo marcar processing:', e); }

  } catch (err) {
    console.error('[DirectExport] Error:', err);
    if (window.showToast) window.showToast(`❌ Error al exportar: ${err.message}`, 'error');
  }
};


// Prueba la fuente automatica tal como la resuelve el home para un usuario
// real, para el título único que está cargado en el formulario.
window.previewVimeusAuto = async () => {
  const tmdbId = document.getElementById('m-tmdb-id').value.trim();
  const imdbId = document.getElementById('m-imdb-id').value.trim();
  const title = document.getElementById('m-title').value.trim();
  const type = document.getElementById('m-type').value;
  const statusEl = document.getElementById('vimeus-auto-status');
  const listEl = document.getElementById('vimeus-auto-sources-list');

  if (!tmdbId && !imdbId) {
    if (window.showToast) window.showToast('Necesitas un ID de TMDb o IMDB primero (importa desde TMDb arriba).', 'warning');
    return;
  }

  if (listEl) listEl.innerHTML = '';
  if (statusEl) statusEl.textContent = '🔍 Revisando las 4 fuentes (mismo orden que el reproductor real)...';

  const resultados = await _checkFuentesDeTitulo({ tmdbId, imdbId, title, type });

  // A pedido: si esto es sobre una película ya guardada, de paso se guarda
  // el resultado en la base — PERO solo para mejorar (confirmar que SÍ
  // tiene Vimeus), nunca para empeorar. Un solo chequeo en vivo, aunque
  // tenga reintentos, puede fallar por un hipo pasajero de red — si eso
  // pasara y sobreescribiéramos un "sí" ya confirmado con un "no", se
  // desmarcarían títulos que en realidad funcionan bien (esto realmente
  // pasó: se reportaron películas con Vimeus real que perdieron el badge
  // ÓPTIMO después de probarlas acá). Bajar a "no disponible"/"fantasma"
  // queda reservado para la auditoría completa (auditarCatalogoCompleto),
  // que es una acción deliberada y ya tiene su propio manejo de reintentos.
  const dbIdActual = document.getElementById('m-db-id').value.trim();
  const vimeusResult = resultados.find(r => r.name === 'Vimeus');
  if (dbIdActual && vimeusResult?.ok) {
    updateDoc(doc(db, "movies", dbIdActual), { vimeusDisponible: true, vimeusFantasma: false }).then(() => {
      const movieActual = movieDatabase.trending.find(m => m.id === dbIdActual);
      if (movieActual) { movieActual.vimeusDisponible = true; movieActual.vimeusFantasma = false; }
      localStorage.removeItem('selvaflix_full_database');
      localStorage.removeItem('selvaflix_cache_timestamp');
    }).catch(e => console.warn('No se pudo guardar el estado de Vimeus:', e));
  }

  // Cargar en la vista previa la de mayor prioridad que si tenga fuente
  const placeholder = document.getElementById('mini-player-placeholder');
  const iframe = document.getElementById('mini-player-iframe');
  const primeraDisponible = resultados.find(r => r.ok && r.url);
  if (primeraDisponible) {
    if (placeholder) placeholder.style.display = 'none';
    if (iframe) { iframe.style.display = 'block'; iframe.src = primeraDisponible.url; }
  }

  if (statusEl) {
    statusEl.textContent = primeraDisponible
      ? `Cargando la vista previa desde ${primeraDisponible.name} (la de mayor prioridad disponible).`
      : 'Ninguna de las fuentes tiene esta pelicula todavia.';
  }

  if (listEl) listEl.innerHTML = _renderFuentesList(resultados, primeraDisponible);
};

// A pedido: probar las fuentes de VARIOS resultados de TMDb a la vez (los
// tildados con el checkbox de "Agregar seleccionadas"), en vez de tener que
// cargar cada uno al formulario y probarlo uno por uno — útil para decidir
// de una sola pasada cuáles partes de una saga conviene agregar.
window.checkSourcesForSelectedTMDB = async () => {
  const checks = Array.from(document.querySelectorAll('.tmdb-bulk-check:checked'));
  if (checks.length === 0) return;
  const indices = checks.map(cb => parseInt(cb.dataset.index, 10));
  const resultDiv = document.getElementById('tmdb-bulk-fuentes-result');
  const btn = document.querySelector('#tmdb-bulk-toolbar button.btn-check-sources');
  if (btn) btn.disabled = true;
  if (resultDiv) {
    resultDiv.style.display = 'flex';
    resultDiv.innerHTML = '<p style="color:var(--primary); font-size:0.75rem; margin:0;">🔍 Probando fuentes de las seleccionadas...</p>';
  }

  const bloques = [];
  for (let i = 0; i < indices.length; i++) {
    const m = _tmdbLastResults[indices[i]];
    if (!m) continue;
    if (btn) btn.textContent = `Probando ${i + 1}/${indices.length}...`;

    const title = m.title || m.name || 'Sin título';
    const type = _tmdbTipo(m);
    let imdbId = '';
    try {
      const detailType = (type === 'series' || type === 'anime') ? 'tv' : 'movie';
      const extData = await fetch(`${TMDB_URL}/${detailType}/${m.id}/external_ids?api_key=${TMDB_API_KEY}`).then(r => r.json());
      imdbId = extData.imdb_id || '';
    } catch (e) { /* sigue el chequeo sin IMDB id */ }

    const resultados = await _checkFuentesDeTitulo({ tmdbId: String(m.id), imdbId, title, type });
    const disponibles = resultados.filter(r => r.ok).length;
    bloques.push({ title, resultados, disponibles });

    if (resultDiv) {
      resultDiv.innerHTML = bloques.map(b => `
        <div style="border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:8px 10px;">
          <p style="font-size:0.8rem; color:white; font-weight:700; margin:0 0 6px;">${b.title} <span style="color:var(--text-muted); font-weight:400; font-size:0.7rem;">(${b.disponibles}/${b.resultados.length} fuentes disponibles)</span></p>
          <div style="display:flex; flex-direction:column; gap:4px;">${_renderFuentesList(b.resultados, null)}</div>
        </div>
      `).join('');
    }
  }

  if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle;">fact_check</span> Probar fuentes'; }
};

window.runAdminScraper = async () => {
  const tmdbId = document.getElementById('m-tmdb-id').value.trim();
  const imdbId = document.getElementById('m-imdb-id').value.trim();
  const type = document.getElementById('m-type').value;
  const listContainer = document.getElementById('drawer-scraped-links-list');
  const section = document.getElementById('drawer-scraped-links-section');

  if (!tmdbId && !imdbId) {
    alert("¡Necesitas primero buscar y seleccionar la película en TMDb para obtener el ID! 🐒");
    return;
  }

  if (listContainer) {
    listContainer.innerHTML = '<p style="color:#ff571a; font-size:0.75rem; font-weight:bold; animation:pulse 1s infinite;">🔍 Buscando torrents y enlaces en la red... 📡</p>';
  }
  if (section) section.style.display = 'block';

  try {
    const queryId = imdbId || tmdbId;
    const queryType = (['series', 'tv', 'anime'].includes(type) ? 'series' : 'movie');

    // URLs de scrapeo (Mismo motor de Player.js)
    const providers = "cinecalidad,mejortorrent,wolfmax4k,yts,1337x,torrent9,limetorrents,eztv,rarbg";
    const tConfig = `providers=${providers}|sort=seeders|qualityfilter=scr,cam`;

    const urls = [
      { url: `https://torrentio.strem.fun/${tConfig}/stream/${queryType}/${queryId}.json`, name: "T-IO" },
      { url: `https://comet.strem.fun/stream/${queryType}/${queryId}.json`, name: "COMET" },
      { url: `https://knightcrawler.elfhosted.com/stream/${queryType}/${queryId}.json`, name: "KNIGHT" }
    ];

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const responses = await Promise.allSettled(urls.map(u =>
      fetch(u.url, { signal: controller.signal }).then(r => r.json())
    ));
    clearTimeout(timeoutId);

    let allStreams = [];
    responses.forEach((res, i) => {
      if (res.status === 'fulfilled' && res.value && res.value.streams) {
        res.value.streams.forEach(s => s.providerName = urls[i].name);
        allStreams = allStreams.concat(res.value.streams);
      }
    });

    // Guardar en SelvaStream para compatibilidad con la subida
    const { SelvaStream } = await import('./components/Player/Player.js');
    SelvaStream.lastScrapedStreams = allStreams;

    if (allStreams.length === 0) {
      listContainer.innerHTML = '<p style="color:var(--admin-text-muted); font-size:0.75rem;">No se encontraron torrents activos para este ID. Intenta usar un generador rápido de arriba.</p>';
      return;
    }

    listContainer.innerHTML = allStreams.map((s, idx) => {
      const titleClean = (s.title || s.name || 'Enlace').split('\n')[0].substring(0, 50);
      const quality = s.title?.includes('4k') || s.title?.includes('2160p') ? '4K' : (s.title?.includes('1080p') ? '1080p' : (s.title?.includes('720p') ? '720p' : 'HD'));

      return `
        <div style="background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); padding:8px 10px; border-radius:8px; display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom: 5px;">
          <div style="flex:1; overflow:hidden;">
            <span style="font-size:0.7rem; font-weight:bold; color:#ff571a; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">[${s.providerName}] ${titleClean}</span>
            <span style="font-size:0.6rem; color:#aaa;">Calidad: ${quality} | ${s.name || ''}</span>
          </div>
          <div style="display:flex; gap:4px; flex-shrink:0;">
            <button type="button" class="btn" style="font-size:0.65rem; padding:4px 8px; cursor:pointer; background:#2ecc71; border:none; color:#000; font-weight:bold; border-radius:4px;" onclick="window.useScrapedStream(${idx})">🔌 Usar</button>
            <button type="button" class="btn" style="font-size:0.65rem; padding:4px 8px; cursor:pointer; background:#ff571a; border:none; color:#fff; font-weight:bold; border-radius:4px;" onclick="window.selvaExecuteExportToHosting(document.getElementById('m-db-id').value, ${idx}, true)">📤 Subir</button>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    console.error(err);
    listContainer.innerHTML = '<p style="color:#e74c3c; font-size:0.75rem;">Fallo al escanear la red. Intenta de nuevo.</p>';
  }
};

window.useScrapedStream = (idx) => {
  import('./components/Player/Player.js').then(({ SelvaStream }) => {
    const s = SelvaStream.lastScrapedStreams[idx];
    if (s) {
      document.getElementById('m-embed').value = s.url || "";
      window.updateMiniPlayer();
      window.showToast("Enlace de origen cargado con éxito", "success");
    }
  });
};

// ─── Soporte: Chat de mensajes usuario ⇄ admin ─────────────────────────────
// Un solo hilo por uid. Sin listeners en tiempo real (consistente con el resto
// del proyecto, que usa getDocs puntuales): mientras el chat está abierto se
// refresca con un poll cada 20s; al cerrarlo, se detiene.
const SUPPORT_COL = 'support_messages';
let _supportPollTimer = null;
let _userUnreadUnsub = null; // cancela el listener de "mensajes nuevos" del FAB (uno por sesión)
let _supportChatUid = null; // uid del hilo que el admin tiene abierto
let _allSupportThreads = [];

function _escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function _renderSupportBubble(text, mine, statusLabel) {
    const bubble = `<div data-msg="1" style="align-self:${mine ? 'flex-end' : 'flex-start'}; max-width:78%; background:${mine ? 'var(--primary,#FF6600)' : 'rgba(255,255,255,0.08)'}; color:${mine ? '#000' : '#fff'}; padding:8px 12px; border-radius:14px; font-size:0.82rem; word-break:break-word; white-space:pre-wrap;">${_escapeHtml(text)}</div>`;
    if (!statusLabel) return bubble;
    // Solo se pasa statusLabel para el último mensaje propio: es el "Enviado ✓ / Visto ✓✓" estilo WhatsApp.
    return bubble + `<div data-status="1" style="align-self:flex-end; font-size:0.65rem; color:#888; margin-top:-4px;">${statusLabel}</div>`;
}

// --- Lado usuario ---
window.openSupportChat = async () => {
    const user = auth.currentUser;
    if (!user) {
        if (window.showToast) window.showToast('Inicia sesión para escribirnos 🐒', 'primary');
        return;
    }
    const modal = document.getElementById('support-chat-modal');
    if (modal) modal.style.display = 'flex';
    const badge = document.getElementById('support-chat-badge');
    if (badge) badge.style.display = 'none';

    await window._loadSupportMessages();
    clearInterval(_supportPollTimer);
    _supportPollTimer = setInterval(window._loadSupportMessages, 20000);
};

window.closeSupportChat = () => {
    const modal = document.getElementById('support-chat-modal');
    if (modal) modal.style.display = 'none';
    clearInterval(_supportPollTimer);
    _supportPollTimer = null;
};

window._loadSupportMessages = async () => {
    const user = auth.currentUser;
    if (!user) return;
    const box = document.getElementById('support-chat-messages');
    if (!box) return;
    try {
        // Sin orderBy en la consulta (evita exigir un índice compuesto): se ordena en cliente.
        const snap = await getDocs(query(collection(db, SUPPORT_COL), where('uid', '==', user.uid)));
        const msgs = [];
        snap.forEach(d => msgs.push({ id: d.id, ...d.data() }));
        msgs.sort((a, b) => a.createdAt - b.createdAt);

        if (msgs.length === 0) {
            box.innerHTML = '<p style="text-align:center; color:#666; font-size:0.75rem;">Cuéntanos qué pasó, te leemos pronto 🌴</p>';
        } else {
            const lastMineIdx = msgs.map(m => m.sender).lastIndexOf('user');
            box.innerHTML = msgs.map((m, i) => {
                const status = (i === lastMineIdx) ? (m.readByAdmin ? 'Visto ✓✓' : 'Enviado ✓') : null;
                return _renderSupportBubble(m.text, m.sender === 'user', status);
            }).join('');
            box.scrollTop = box.scrollHeight;
        }

        const unread = msgs.filter(m => m.sender === 'admin' && !m.readByUser);
        for (const m of unread) {
            await updateDoc(doc(db, SUPPORT_COL, m.id), { readByUser: true }).catch(() => {});
        }
    } catch (e) {
        console.warn('No se pudo cargar el chat de soporte:', e);
    }
};

window.sendSupportMessage = async () => {
    const user = auth.currentUser;
    if (!user) return;
    const input = document.getElementById('support-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    // Optimista: se pinta al toque, sin esperar la ida y vuelta a Firestore para verse.
    const box = document.getElementById('support-chat-messages');
    if (box) {
        if (!box.querySelector('[data-msg]')) box.innerHTML = '';
        box.querySelectorAll('[data-status]').forEach(el => el.remove()); // el "Enviado" viejo ya no es el último
        box.insertAdjacentHTML('beforeend', _renderSupportBubble(text, true, 'Enviado ✓'));
        box.scrollTop = box.scrollHeight;
    }

    try {
        await addDoc(collection(db, SUPPORT_COL), {
            uid: user.uid,
            // La cuenta es la dueña del hilo (uid), no el perfil activo: varios perfiles de
            // una misma cuenta (familia) deben caer en la misma conversación con el admin.
            userName: user.displayName || user.email || 'Usuario',
            userEmail: user.email || '',
            profileName: (_currentProfile && _currentProfile.name) || '',
            sender: 'user',
            text,
            createdAt: Date.now(),
            readByAdmin: false,
            readByUser: true
        });
        await window._loadSupportMessages(); // reconcilia con la copia real del servidor
    } catch (e) {
        console.error('Error enviando mensaje de soporte:', e);
        if (window.showToast) window.showToast('No se pudo enviar el mensaje. Revisa tu internet.', 'error');
        await window._loadSupportMessages(); // por si el mensaje optimista quedó desincronizado
    }
};

// Revisa si hay respuestas del admin sin leer, para el puntito del botón flotante
// Puntito del FAB con listener en vivo en vez de poll: a diferencia de preguntar
// cada 60s pase lo que pase, onSnapshot solo cobra una lectura la primera vez
// y despues nada más hasta que de verdad llegue una respuesta nueva del admin
// — más instantáneo Y más barato que el poll que tenía antes.
window.watchSupportUnread = (uid) => {
    if (_userUnreadUnsub) { _userUnreadUnsub(); _userUnreadUnsub = null; }
    if (!uid) return;
    const q = query(
        collection(db, SUPPORT_COL),
        where('uid', '==', uid),
        where('sender', '==', 'admin'),
        where('readByUser', '==', false)
    );
    _userUnreadUnsub = onSnapshot(q, (snap) => {
        const badge = document.getElementById('support-chat-badge');
        if (badge) badge.style.display = snap.empty ? 'none' : 'block';
    }, (e) => console.warn('No se pudo escuchar mensajes de soporte:', e));
};

// --- Lado admin ---
window.loadAdminMessages = async () => {
    const listEl = document.getElementById('admin-messages-threads');
    if (!listEl) return;
    listEl.innerHTML = '<p style="text-align:center; color:var(--admin-text-muted); padding:20px; font-size:0.8rem;">Cargando...</p>';
    try {
        const snap = await getDocs(collection(db, SUPPORT_COL));
        const all = [];
        snap.forEach(d => all.push({ id: d.id, ...d.data() }));

        const byUid = {};
        all.forEach(m => {
            if (!byUid[m.uid]) byUid[m.uid] = { uid: m.uid, userName: m.userName, userEmail: m.userEmail, messages: [] };
            byUid[m.uid].messages.push(m);
        });
        Object.values(byUid).forEach(t => t.messages.sort((a, b) => a.createdAt - b.createdAt));

        _allSupportThreads = Object.values(byUid).sort((a, b) => {
            const lastA = a.messages[a.messages.length - 1]?.createdAt || 0;
            const lastB = b.messages[b.messages.length - 1]?.createdAt || 0;
            return lastB - lastA;
        });

        if (_allSupportThreads.length === 0) {
            listEl.innerHTML = '<p style="text-align:center; color:var(--admin-text-muted); padding:20px; font-size:0.8rem;">Sin mensajes todavía. 🌴</p>';
        } else {
            listEl.innerHTML = _allSupportThreads.map(t => {
                const last = t.messages[t.messages.length - 1];
                const unread = t.messages.some(m => m.sender === 'user' && !m.readByAdmin);
                return `<div onclick="window.openAdminThread('${t.uid}')" style="cursor:pointer; padding:10px; border-radius:10px; background:${_supportChatUid === t.uid ? 'rgba(255,102,0,0.14)' : 'rgba(255,255,255,0.03)'}; border:1px solid var(--glass-border); margin-bottom:6px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                        <strong style="color:#fff; font-size:0.82rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${_escapeHtml(t.userName || 'Usuario')}</strong>
                        ${unread ? '<span style="width:8px; height:8px; border-radius:50%; background:#e63946; flex-shrink:0;"></span>' : ''}
                    </div>
                    <div style="color:var(--admin-text-muted); font-size:0.72rem; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${_escapeHtml((last?.text || '').slice(0, 60))}</div>
                </div>`;
            }).join('');
        }

        const totalUnread = _allSupportThreads.filter(t => t.messages.some(m => m.sender === 'user' && !m.readByAdmin)).length;
        const badge = document.getElementById('admin-messages-badge');
        if (badge) {
            badge.style.display = totalUnread > 0 ? 'inline-block' : 'none';
            badge.innerText = totalUnread;
        }

        if (_supportChatUid) {
            const openThread = byUid[_supportChatUid];
            if (openThread) window._renderAdminThread(openThread);
        }
    } catch (e) {
        listEl.innerHTML = '<p style="text-align:center; color:#e63946; padding:20px; font-size:0.8rem;">No se pudieron cargar los mensajes.</p>';
        console.error('Error cargando mensajes de soporte:', e);
    }
};

window.openAdminThread = async (uid) => {
    _supportChatUid = uid;
    const thread = _allSupportThreads.find(t => t.uid === uid);
    if (!thread) return;
    window._renderAdminThread(thread);

    const unread = thread.messages.filter(m => m.sender === 'user' && !m.readByAdmin);
    for (const m of unread) {
        await updateDoc(doc(db, SUPPORT_COL, m.id), { readByAdmin: true }).catch(() => {});
    }
    if (unread.length > 0) window.loadAdminMessages(); // refresca la lista para quitar el punto de no-leído
};

window._renderAdminThread = (thread) => {
    const header = document.getElementById('admin-messages-chat-header');
    if (header) {
        const lastProfile = [...thread.messages].reverse().find(m => m.sender === 'user' && m.profileName)?.profileName;
        header.innerText = `${thread.userName || 'Usuario'} · ${thread.userEmail || 'sin email'}${lastProfile ? ' · perfil: ' + lastProfile : ''}`;
    }
    const body = document.getElementById('admin-messages-chat-body');
    if (body) {
        const lastMineIdx = thread.messages.map(m => m.sender).lastIndexOf('admin');
        body.innerHTML = thread.messages.map((m, i) => {
            const status = (i === lastMineIdx) ? (m.readByUser ? 'Visto ✓✓' : 'Enviado ✓') : null;
            return _renderSupportBubble(m.text, m.sender === 'admin', status);
        }).join('');
        body.scrollTop = body.scrollHeight;
    }
    const replyRow = document.getElementById('admin-messages-reply-row');
    if (replyRow) replyRow.style.display = 'flex';
};

window.sendAdminReply = async () => {
    if (!_supportChatUid) return;
    const input = document.getElementById('admin-messages-reply-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const thread = _allSupportThreads.find(t => t.uid === _supportChatUid);

    // Optimista: se pinta al toque, sin esperar la ida y vuelta a Firestore para verse.
    const body = document.getElementById('admin-messages-chat-body');
    if (body) {
        body.querySelectorAll('[data-status]').forEach(el => el.remove()); // el "Enviado" viejo ya no es el último
        body.insertAdjacentHTML('beforeend', _renderSupportBubble(text, true, 'Enviado ✓'));
        body.scrollTop = body.scrollHeight;
    }

    try {
        await addDoc(collection(db, SUPPORT_COL), {
            uid: _supportChatUid,
            userName: thread?.userName || '',
            userEmail: thread?.userEmail || '',
            sender: 'admin',
            text,
            createdAt: Date.now(),
            readByAdmin: true,
            readByUser: false
        });
        await window.loadAdminMessages();
        window.openAdminThread(_supportChatUid);
    } catch (e) {
        console.error('Error enviando respuesta de soporte:', e);
        if (window.showToast) window.showToast('No se pudo enviar la respuesta.', 'error');
        await window.loadAdminMessages();
        window.openAdminThread(_supportChatUid);
    }
};

