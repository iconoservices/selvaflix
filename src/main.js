import './style.css'
import { SelvaStream } from './components/Player/Player.js'
import { ExportManager } from './utils/exportManager.js'
import './components/Player/Player.css'
import './ui/toasts.js' // 🍿 Notificaciones (define window.showToast)
/* 
   🌴 Perla de Sabiduría: Firebase es nuestro "Puesto de Vigilancia". 
   Mantiene un ojo en los datos y nos avisa al instante cuando algo cambia en la selva.
*/
import { initializeApp } from "firebase/app";
import { getFirestore, collection, onSnapshot, addDoc, deleteDoc, doc, updateDoc, setDoc, query, orderBy, limit, getDocs, getDoc, where } from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getMessaging, getToken, onMessage } from "firebase/messaging"; // 🔔 FCM SDK
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "firebase/auth"; // 🔑 Auth SDK

// --- Firebase Configuration ---
const firebaseConfig = {
  apiKey: "AIzaSyCABaNkvUlMjBatNh0Giih01IDH4sNbt1Q",
  authDomain: "selvaflix-5d991.firebaseapp.com",
  databaseURL: "https://selvaflix-5d991-default-rtdb.firebaseio.com",
  projectId: "selvaflix-5d991",
  storageBucket: "selvaflix-5d991.firebasestorage.app",
  messagingSenderId: "935630160406",
  appId: "1:935630160406:web:171ecfcb9e4258628bab37",
  measurementId: "G-N4DRH9QPE3"
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
let heroTimer = null;
let currentPlayerMovie = null;
window._brokenIds = new Set();
let pendingSeeds = [];
let deferredPrompt;

// --- Splash Screen Engine v2.40 ---
// --- Splash Screen Engine v2.40 🎬 ---
window.hideSplashScreen = (force = false) => {
  const splash = document.getElementById('splash-screen');
  if (splash) {
    // 🚀 DESBLOQUEO INTELIGENTE:
    const isProfileActive = sessionStorage.getItem('selva_active_profile');
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
  const FIFTEEN_MINUTES = 15 * 60 * 1000;

  // 1. Revisar si hay un caché válido
  const cachedStored = sessionStorage.getItem(CACHE_KEY);
  const cacheTimestamp = sessionStorage.getItem(CACHE_TIME_KEY);
  const now = Date.now();

  let hydratedObject = null;

  if (cachedStored && cacheTimestamp && (now - parseInt(cacheTimestamp) < FIFTEEN_MINUTES)) {
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
      sessionStorage.removeItem(CACHE_KEY);
      sessionStorage.removeItem(CACHE_TIME_KEY);
      hydratedObject = null;
    }
  }

  if (!hydratedObject) {
    // 2. Si no hay caché o caducó, pedir a Firebase
    console.log("🔥 Haciendo expedición a Firebase (Solicitando datos frescos)");
    try {
      const snapshot = await getDocs(moviesCol);
      const moviesArray = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

      // Actualizamos el organismo
      movieDatabase.trending = moviesArray;

      // Guardar el Espejo Completo
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(movieDatabase));
      sessionStorage.setItem(CACHE_TIME_KEY, now.toString());

      if(window.resumePendingExports) window.resumePendingExports();
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

  seedPopularSeries();

  // Nota: handleRouting ya sabe si es la primera vez al revisar el DOM
  // ✅ Disparar anuncios automáticos si corresponde
  if(window.triggerLandingAd) window.triggerLandingAd();
  
  handleRouting();
  
  // 🚀 Siempre intentar ocultar al finalizar carga de datos si ya estamos en un estado listo
  window.hideSplashScreen();
}

// Iniciar recolección al cargar
// Backdoor removed by Architect Antigravity 🌴
// Access only via #admin password check.
window.updateAdminUI = () => {
  const isAdmin = localStorage.getItem('selva_admin_auth') === 'true';
  const dot = document.getElementById('admin-status-dot');
  if (dot) dot.style.display = isAdmin ? 'block' : 'none';
};
async function seedPopularSeries() {
  const FAMOUS_CONTENT = [
    {
      title: "Rick y Morty",
      tmdbId: 60625,
      imdbId: "tt2861424",
      type: "series",
      img: "https://image.tmdb.org/t/p/w500/cvhNj9eoRBe5SjprKVPKF8EdUob.jpg",
      description: "Comedia animada que narra las aventuras del científico loco Rick Sánchez y su nieto Morty.",
      genres: ["Animación", "Comedia", "Ciencia Ficción"],
      rating: "8.7",
      year: 2013,
      status: "healthy"
    },
    {
      title: "Los Simpson",
      tmdbId: 456,
      imdbId: "tt0096697",
      type: "series",
      img: "https://image.tmdb.org/t/p/w500/vHvuE107n248dC3d6vR4k37d36K.jpg",
      description: "Las divertidas y caóticas aventuras de la familia Simpson en la ciudad de Springfield.",
      genres: ["Animación", "Comedia"],
      rating: "8.0",
      year: 1989,
      status: "healthy"
    },
    {
      title: "Juego de Tronos",
      tmdbId: 1399,
      imdbId: "tt0944947",
      type: "series",
      img: "https://image.tmdb.org/t/p/w500/u3bZgnGQ9T01sWNhyveQz0wH0Hl.jpg",
      description: "Varias familias nobles luchan por el control de la mítica tierra de Poniente.",
      genres: ["Drama", "Fantasía"],
      rating: "8.4",
      year: 2011,
      status: "healthy"
    },
    {
      title: "The Walking Dead",
      tmdbId: 1402,
      imdbId: "tt1520211",
      type: "series",
      img: "https://image.tmdb.org/t/p/w500/xf9wuDcqlUPWABZ1wGvOWZLXEsG.jpg",
      description: "Un grupo de supervivientes lucha por mantenerse con vida en un mundo apocalíptico infectado por zombis.",
      genres: ["Drama", "Terror"],
      rating: "8.1",
      year: 2010,
      status: "healthy"
    },
    {
      title: "Breaking Bad",
      tmdbId: 1396,
      imdbId: "tt0903747",
      type: "series",
      img: "https://image.tmdb.org/t/p/w500/ztkUQFLlC19CCMY55i2zGyuUTKB.jpg",
      description: "Un profesor de química de secundaria diagnosticado con cáncer terminal recurre al crimen.",
      genres: ["Drama", "Crimen"],
      rating: "8.9",
      year: 2008,
      status: "healthy"
    },
    {
      title: "Stranger Things",
      tmdbId: 66732,
      imdbId: "tt4574334",
      type: "series",
      img: "https://image.tmdb.org/t/p/w500/49WJfeN0moxb9IPfGn88qbuYh9m.jpg",
      description: "Cuando un niño desaparece, un pequeño pueblo desvela un misterio que involucra experimentos secretos.",
      genres: ["Ciencia Ficción", "Drama"],
      rating: "8.6",
      year: 2016,
      status: "healthy"
    },
    {
      title: "La Casa de Papel",
      tmdbId: 71446,
      imdbId: "tt6468322",
      type: "series",
      img: "https://image.tmdb.org/t/p/w500/reEMJA1uzscCbkSRl8fJPXIOfdM.jpg",
      description: "Un misterioso hombre conocido como 'El Profesor' planea el mayor atraco de la historia.",
      genres: ["Crimen", "Drama"],
      rating: "8.2",
      year: 2017,
      status: "healthy"
    },
    {
      title: "Avatar: El sentido del agua",
      tmdbId: 76600,
      imdbId: "tt1630029",
      type: "movie",
      img: "https://image.tmdb.org/t/p/w500/8c9wsDToZ3z56m6Vj4nB25p64ui.jpg",
      description: "Jake Sully vive con su nueva familia en el planeta de Pandora. Cuando una amenaza regresa, Jake debe trabajar con Neytiri.",
      genres: ["Ciencia Ficción", "Aventura", "Acción"],
      rating: "7.6",
      year: 2022,
      status: "healthy"
    },
    {
      title: "Gladiator",
      tmdbId: 98,
      imdbId: "tt0172495",
      type: "movie",
      img: "https://image.tmdb.org/t/p/w500/u3W1W96yS81C1pivWnZ0wA1Qy8r.jpg",
      description: "Un ex general romano jura venganza contra el corrupto emperador que asesinó a su familia y lo condenó a la esclavitud.",
      genres: ["Acción", "Drama", "Aventura"],
      rating: "8.2",
      year: 2000,
      status: "healthy"
    },
    {
      title: "Del revés 2 (Inside Out 2)",
      tmdbId: 1022789,
      imdbId: "tt22022452",
      type: "movie",
      img: "https://image.tmdb.org/t/p/w500/wz97y7y0w4mB416g3FjH447N0Kk.jpg",
      description: "Riley es ahora una adolescente y su mente experimenta cambios repentinos, introduciendo nuevas emociones.",
      genres: ["Animación", "Aventura", "Familia", "Comedia"],
      rating: "7.7",
      year: 2024,
      status: "healthy"
    },
    {
      title: "Dune: Parte dos",
      tmdbId: 693134,
      imdbId: "tt15239678",
      type: "movie",
      img: "https://image.tmdb.org/t/p/w500/6v4UjL43dI4C8pQ6UfB8S1l3F7q.jpg",
      description: "Paul Atreides se une a Chani y a los Fremen mientras busca venganza contra los conspiradores que destruyeron a su familia.",
      genres: ["Ciencia Ficción", "Aventura"],
      rating: "8.3",
      year: 2024,
      status: "healthy"
    },
    {
      title: "Spider-Man: No Way Home",
      tmdbId: 634649,
      imdbId: "tt10872600",
      type: "movie",
      img: "https://image.tmdb.org/t/p/w500/uJ603O61g55Jg4u2XgD65c49N0K.jpg",
      description: "Peter Parker pide ayuda al Doctor Strange para hacer que el mundo olvide su identidad secreta, desatando el multiverso.",
      genres: ["Acción", "Aventura", "Ciencia Ficción"],
      rating: "8.0",
      year: 2021,
      status: "healthy"
    }
  ];

  if (!Array.isArray(movieDatabase.trending)) return;

  let addedAny = false;
  for (const s of FAMOUS_CONTENT) {
    const exists = movieDatabase.trending.some(m => 
      (m.tmdbId && m.tmdbId === s.tmdbId) || 
      (m.title && m.title.toLowerCase() === s.title.toLowerCase())
    );
    if (!exists) {
      try {
        const docRef = await addDoc(collection(db, "movies"), { ...s, createdAt: Date.now() });
        movieDatabase.trending.push({ id: docRef.id, ...s });
        addedAny = true;
        console.log(`🌴 Contenido sembrado automáticamente: ${s.title}`);
      } catch (err) {
        console.error(`Error sembrando ${s.title}:`, err);
      }
    }
  }
  if (addedAny) {
    sessionStorage.removeItem('selvaflix_full_database');
    sessionStorage.removeItem('selvaflix_cache_timestamp');
    handleRouting();
  }
}

window.updateAdminUI(); 
loadSelvaFlixData();


// ─── Filter / Routing ────────────────────────────────────────────
let _currentFilter = '';   // 'movies' | 'series' | 'live' | ''
let _currentGenre = '';   // TMDB genre id string or ''

window.setFilter = (type) => {
  _currentFilter = type;
  _currentGenre = '';   // reset genre on main filter change

  const adminEl = document.getElementById('admin-view');
  const homeEl = document.getElementById('home-view');
  if (adminEl) adminEl.style.display = 'none';
  if (homeEl) homeEl.style.display = 'block';

  // Update filter pill active state (only main pills)
  ['filter-all', 'filter-movies', 'filter-series'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  const idMap = { '': 'filter-all', 'movies': 'filter-movies', 'series': 'filter-series' };
  document.getElementById(idMap[type] || 'filter-all')?.classList.add('active');

  // Show genre sub-bar only in movies/series view; reset genre pills
  const genreBar = document.getElementById('genre-bar');
  if (genreBar) {
    genreBar.style.display = (type === 'movies' || type === 'series') ? 'flex' : 'none';
    genreBar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('genre-all')?.classList.add('active');
  }

  history.replaceState(null, '', type ? `#${type}` : '#');
  initApp(type, '');
  
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
    genreBar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    // Find clicked button (match by onclick attr genreId)
    genreBar.querySelectorAll('.filter-btn').forEach(b => {
      const oc = b.getAttribute('onclick') || '';
      if (oc.includes(`'${genreId}'`) || (genreId === '' && b.id === 'genre-all')) {
        b.classList.add('active');
      }
    });
  }
  initApp(_currentFilter, genreId);
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
  const adminEl = document.getElementById('admin-view');
  const homeEl = document.getElementById('home-view');
  const detailEl = document.getElementById('detail-view');
  const myListEl = document.getElementById('my-list-view');
  const navbar = document.querySelector('.navbar');
  const bottomNav = document.querySelector('.bottom-nav');

  // Ocultar todo primero
  if (adminEl) adminEl.style.display = 'none';
  if (homeEl) homeEl.style.display = 'none';
  if (detailEl) detailEl.style.display = 'none';
  if (myListEl) myListEl.style.display = 'none';

  // Limpiar estado activo del nav mobile
  document.querySelectorAll('.nav-item-cinepulse').forEach(b => b.classList.remove('active'));

  if (active === 'admin-view') {
    if (adminEl) adminEl.style.display = 'block';
    if (navbar) navbar.style.display = '';
    if (bottomNav) bottomNav.style.display = '';
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
  handleRouting();
};

// Navega a la pestaña Mi Selva
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
  if (!hash.endsWith('/play') && typeof SelvaStream !== 'undefined') {
    SelvaStream.close();
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
        if (password === "selva2025") { 
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
    window.loadMetrics();
  } else if (hash === 'mylist') {
    showView('my-list-view');
    window.scrollTo(0, 0);
    window.loadMyList();
  } else {
    showView('home-view');
    const hashVal = hash || '';

    // Top filters
    const idMap = { '': 'filter-all', 'movies': 'filter-movies', 'series': 'filter-series' };
    ['filter-all', 'filter-movies', 'filter-series'].forEach(id => document.getElementById(id)?.classList.remove('active'));
    document.getElementById(idMap[hashVal])?.classList.add('active');

    // Bottom nav (Mobile)
    const btmMap = { '': 'btn-nav-home', 'movies': 'btn-nav-movies', 'series': 'btn-nav-series' };
    ['btn-nav-home', 'btn-nav-movies', 'btn-nav-series'].forEach(id => document.getElementById(id)?.classList.remove('active'));
    document.getElementById(btmMap[hashVal])?.classList.add('active');

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
        sessionStorage.removeItem('selvaflix_full_database');
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

        // 1. Si es un infoHash, necesitamos des-restringirlo primero con RD
        if (streamData.infoHash && !directUrl) {
            if (window.showToast) window.showToast("🔍 Des-restringiendo link de la selva...", "info");
            const rdData = await SelvaStream.callMasterWorker(streamData.infoHash);
            if (rdData && rdData.url) {
                directUrl = rdData.url;
            } else {
                throw new Error("No se pudo obtener el link directo de Real-Debrid.");
            }
        }

        if (!directUrl) throw new Error("No hay un link válido para exportar.");

        // 2. Enviar a Streamtape (API Remote Upload)
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
                    // 🚀 LOGICA DE AUTO-GUARDADO (POLLING)
                    // 🚨 GESTIÓN VISUAL: Guardar estado 'processing' + Ticket en DB
                    try {
                        const { getFirestore, doc, updateDoc } = await import("firebase/firestore");
                        const db = getFirestore();
                        await updateDoc(doc(db, "movies", movieId), { 
                            exportStatus: 'processing', 
                            exportTicketId: ticketId,
                            updatedAt: Date.now() 
                        });
                        
                        // Sincronizar UI localmente
                        const memItem = _allInventoryItems.find(m => m.id === movieId);
                        if (memItem) memItem.exportStatus = 'processing';
                        if (window.filterInventoryByCategory) window.filterInventoryByCategory(); 
                    } catch (e) {
                         console.error("No se pudo iniciar processing status", e);
                    }
                    
                    // 🛡️ INICIAR VIGILANCIA CENTRALIZADA
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

                            // Sync local memory
                            const memItem = _allInventoryItems.find(m => m.id === movieId);
                            if (memItem) {
                                memItem.exportStatus = update.phase;
                                if (update.url) memItem.embed = update.url;
                            }

                            if (update.message && window.showToast) {
                                window.showToast(update.message, update.phase === 'done' ? 'success' : 'info');
                            }

                            if (window.filterInventoryByCategory) window.filterInventoryByCategory();
                            
                            // Si el player está abierto con esta peli, refrescar menu
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

        // 3. Enviar a Doodstream (Opcional si hay llave - Solo Manual por ahora)
        const dsKey = SelvaStream.DOODSTREAM_KEY;
        if (dsKey) {
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

  if (query) {
    if (filtered.length > 0) renderRow(`Resultados para "${query}"`, filtered);
    else container.insertAdjacentHTML('beforeend', `<p style="padding: 50px; text-align: center; color: var(--text-muted);">No se encontro nada en esta selva... 🕵️‍♂️🥥</p>`);
  } else {
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
        
        // Obtener género
        const genre = item.genres ? (Array.isArray(item.genres) ? item.genres[0] : item.genres) : 'Action';
        
        const isBroken = item.status === 'broken' || (window._brokenIds && window._brokenIds.has(item.id));
        let statusBadgeHtml = '';
        if (isBroken) {
          statusBadgeHtml = `<div class="badge-maintenance" style="background:#FF5252; color:white;">Sin Fuentes</div>`;
        } else if (item.status === 'maintenance') {
          statusBadgeHtml = `<div class="badge-maintenance">Mantenimiento</div>`;
        }

        let streamBadge = '';
        if (isBroken) {
          streamBadge = `<span style="color: #FF5252; font-size: 0.7rem; font-weight: 800; display: flex; align-items: center; gap: 2px;">🔴 Sin Fuentes</span>`;
        } else if (item.embed && (item.embed.startsWith('http') || item.embed.includes('<iframe'))) {
          streamBadge = `<span style="color: #00E676; font-size: 0.7rem; font-weight: 800; display: flex; align-items: center; gap: 2px;">👑 Directo</span>`;
        } else if (item.tmdbId || item.imdbId) {
          streamBadge = `<span style="color: #00B0FF; font-size: 0.7rem; font-weight: 800; display: flex; align-items: center; gap: 2px;">🟢 Online HD</span>`;
        } else {
          streamBadge = `<span style="color: #FFB300; font-size: 0.7rem; font-weight: 800; display: flex; align-items: center; gap: 2px;">🟡 Buscando...</span>`;
        }
        
        const cardHtml = `
            <div class="cinepulse-movie-card" data-id="${item.id}" onclick="window.handleCardClick('${item.id}')">
              <img src="${item.img}" alt="${item.title}" loading="lazy"
                onerror="this.src='https://via.placeholder.com/500x750/1a1a1a/E74C3C?text=Sin+Imagen';">
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
              <div class="cinepulse-card-content">
                <h3 class="cinepulse-card-title">${item.title}</h3>
                <div class="cinepulse-card-meta">
                  <span class="cinepulse-card-genre">${genre}</span>
                  ${streamBadge}
                  <span class="cinepulse-card-rating">
                    <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1; font-size: 12px;">star</span>
                    ${item.rating || '8.9'}
                  </span>
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
      <div class="cinepulse-recommended-card" onclick="window.handleCardClick('${item.id}')">
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
        const genre = item.genres ? (Array.isArray(item.genres) ? item.genres[0] : item.genres) : 'Action';

        const isBroken = item.status === 'broken' || (window._brokenIds && window._brokenIds.has(item.id));
        let statusBadgeHtml = '';
        if (isBroken) {
          statusBadgeHtml = `<div class="badge-maintenance" style="background:#FF5252; color:white;">Sin Fuentes</div>`;
        } else if (item.status === 'maintenance') {
          statusBadgeHtml = `<div class="badge-maintenance">Mantenimiento</div>`;
        }

        let streamBadge = '';
        if (isBroken) {
          streamBadge = `<span style="color: #FF5252; font-size: 0.7rem; font-weight: 800; display: flex; align-items: center; gap: 2px;">🔴 Sin Fuentes</span>`;
        } else if (item.embed && (item.embed.startsWith('http') || item.embed.includes('<iframe'))) {
          streamBadge = `<span style="color: #00E676; font-size: 0.7rem; font-weight: 800; display: flex; align-items: center; gap: 2px;">👑 Directo</span>`;
        } else if (item.tmdbId || item.imdbId) {
          streamBadge = `<span style="color: #00B0FF; font-size: 0.7rem; font-weight: 800; display: flex; align-items: center; gap: 2px;">🟢 Online HD</span>`;
        } else {
          streamBadge = `<span style="color: #FFB300; font-size: 0.7rem; font-weight: 800; display: flex; align-items: center; gap: 2px;">🟡 Buscando...</span>`;
        }

        return `
          <div class="cinepulse-movie-card gallery-card" data-id="${item.id}" onclick="window.handleCardClick('${item.id}')">
            <img src="${item.img}" alt="${item.title}" loading="lazy"
              onerror="this.src='https://via.placeholder.com/500x750/1a1a1a/E74C3C?text=Sin+Imagen';">
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
            <div class="cinepulse-card-content">
              <h3 class="cinepulse-card-title">${item.title}</h3>
              <div class="cinepulse-card-meta">
                <span class="cinepulse-card-genre">${genre}</span>
                <span class="cinepulse-card-rating">
                  <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1; font-size: 12px;">star</span>
                  ${item.rating || '8.9'}
                </span>
              </div>
            </div>
                <span class="cinepulse-card-genre">${genre}</span>
                <span class="cinepulse-card-rating">
                  <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1; font-size: 12px;">star</span>
                  ${item.rating || '8.9'}
                </span>
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
  const b = items.filter(i => window._brokenIds.has(i.id)).length;
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
}

window.loadMoreInventory = () => {
  _inventoryPage++;
  _renderInventoryRows(_allInventoryItems);
};

// Mapea IDs de género a nombres amigables
const GENRE_MAP = {
  "28": "Action", "12": "Adventure", "16": "Sci-Fi", "35": "Comedy", "80": "Thriller",
  "99": "Doc", "18": "Drama", "10751": "Family", "14": "Fantasy", "36": "History",
  "27": "Horror", "10402": "Music", "9648": "Mystery", "10749": "Romance", "878": "Sci-Fi",
  "10770": "TV Movie", "53": "Thriller", "10752": "War", "37": "Western", "10759": "Action"
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
    const isBroken = window._brokenIds.has(m.id);
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

    return `
      <tr data-id="${m.id}">
        <td style="text-align: center;">
          <input type="checkbox" class="selva-check" data-id="${m.id}" onchange="window.updateSelectedCount()" style="cursor:pointer; accent-color: var(--admin-accent-orange); width: 15px; height: 15px;">
        </td>
        <td>
          <div class="cell-poster">
            <img src="${m.img}" onerror="this.src='https://via.placeholder.com/150x225?text=ERROR'; window.markAsBroken('${m.id}')" alt="poster">
          </div>
        </td>
        <td>
          <div class="cell-title-block">
            <span class="cell-title-name">${cleanTitle}</span>
            <span class="cell-title-id">ID: CP-${cleanId.toString().substring(0, 6)}</span>
          </div>
        </td>
        <td>
          <div style="display: flex; gap: 4px;">
            ${genres}
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
const ADMIN_TABS = ['dashboard', 'catalog', 'users', 'analytics', 'ads', 'actions'];

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
    if (typeof window.initMetricsSelectors === 'function') window.initMetricsSelectors();
    if (typeof window.loadMetrics === 'function') window.loadMetrics();
  } else if (tab === 'ads') {
    if (typeof window.loadAdConfig === 'function') window.loadAdConfig();
  } else if (tab === 'dashboard') {
    // Refresh dashboard stats using already-loaded inventory
    if (_allInventoryItems && _allInventoryItems.length > 0) {
      _updateDetailedStats(_allInventoryItems);
    }
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

                window.renderAdCampaignList();
            }
        }
    } catch (e) {
        console.error("❌ Error CRÍTICO cargando config de publicidad:", e);
    }
};

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
                    <p style="color: white; font-size: 0.75rem; font-weight: 800; margin: 0; white-space: nowrap; text-overflow: ellipsis; overflow: hidden;">${c.name || 'Sin Nombre'}</p>
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
        document.getElementById('ad-edit-active').checked = camp.active;
        const toggleLabel = document.getElementById('campaign-status-toggle');
        toggleLabel.innerText = camp.active ? 'CAMPAÑA ON' : 'CAMPAÑA OFF';
        toggleLabel.style.color = camp.active ? '#2ecc71' : '#555';
    }
    // No guardamos a Firestore en cada click para evitar cuota, el usuario debe dar a GUARDAR TODO
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
        scriptBtn.style.background = 'rgba(0,242,255,0.1)';
        scriptBtn.style.color = '#00f2ff';
        scriptBtn.style.border = '1px solid rgba(0,242,255,0.2)';
        mediaBtn.style.background = 'transparent';
        mediaBtn.style.color = '#555';
        mediaBtn.style.border = 'none';
        
        if (mediaLabel) mediaLabel.innerText = "⚡ Código del Script (Red)";
        if (mediaHint) mediaHint.innerHTML = "* Pega el script de Adsterra, AdMob, etc.";
    } else {
        mediaBtn.style.background = 'rgba(255,122,0,0.1)';
        mediaBtn.style.color = 'var(--primary)';
        mediaBtn.style.border = '1px solid rgba(255,122,0,0.2)';
        scriptBtn.style.background = 'transparent';
        scriptBtn.style.color = '#555';
        scriptBtn.style.border = 'none';
        
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
        autoBtn.style.background = 'rgba(0,242,255,0.1)';
        autoBtn.style.color = '#00f2ff';
        autoBtn.style.border = '1px solid rgba(0,242,255,0.2)';
        manualBtn.style.background = 'transparent';
        manualBtn.style.color = '#555';
        manualBtn.style.border = 'none';
    } else {
        manualBtn.style.background = 'rgba(255,122,0,0.1)';
        manualBtn.style.color = 'var(--primary)';
        manualBtn.style.border = '1px solid rgba(255,122,0,0.2)';
        autoBtn.style.background = 'transparent';
        autoBtn.style.color = '#555';
        autoBtn.style.border = 'none';
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
    const mode = document.getElementById('ad-edit-freq-mode').value;
    const group = document.getElementById('freq-value-group');
    const timesOnly = document.getElementById('freq-times-only-group'); // Nuevo contenedor para cuando solo queremos veces
    
    if (group) {
        group.style.display = mode === 'interval' ? 'grid' : 'none';
    }
    
    // Si es diario por peli, mostramos solo el campo de "Veces"
    const timesInput = document.getElementById('ad-edit-freq-times').closest('.form-group');
    if (mode === 'unlimited') {
        if (group) group.style.display = 'none';
        if (timesOnly) timesOnly.style.display = 'none';
    } else if (mode === 'per_movie_daily') {
        if (group) group.style.display = 'grid';
        document.getElementById('freq-value-label').parentElement.style.opacity = '0.3';
        document.getElementById('ad-edit-freq').disabled = true;
    } else if (mode === 'interval') {
        document.getElementById('freq-value-label').parentElement.style.opacity = '1';
        document.getElementById('ad-edit-freq').disabled = false;
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
    const contentType = document.getElementById('ad-campaign-editor').dataset.currentContentType || 'media';

    if (contentType === 'script') {
        label.innerText = "⚡ Código del Script (Red Externa)";
        hint.innerHTML = "* Pega el código de Adsterra, AdMob, etc.";
        layoutGroup.style.display = 'none';
        if (cardFields) cardFields.style.display = 'none';
        // En modo Script, usualmente no quieres link manual a menos que lo fuerces
        document.getElementById('ad-edit-link-container').parentElement.style.opacity = '1';
    } else {
        label.innerText = isPreroll ? "🎬 URL del Video / VAST Tag" : "🖼️ URL del Medio (Imagen/Video)";
        hint.innerHTML = isPreroll ? "* URL directa a .mp4 o link de VAST." : "* URL de la imagen/video que verá el usuario.";
        layoutGroup.style.display = needsCard ? 'block' : 'none';
        if (cardFields) cardFields.style.display = needsCard ? 'block' : 'none';
        document.getElementById('ad-edit-link-container').parentElement.style.opacity = '1';
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
            camp.coexistence = document.getElementById('ad-edit-coexistence').value;

            camp.message = document.getElementById('ad-edit-message').value;
            camp.media = document.getElementById('ad-edit-media').value;
            camp.timer = parseInt(document.getElementById('ad-edit-timer').value);
            camp.priority = parseInt(document.getElementById('ad-edit-priority').value);
            camp.layout = document.getElementById('ad-edit-layout').value;
            camp.canSkip = document.getElementById('ad-edit-can-skip').checked;
            camp.freqMode = document.getElementById('ad-edit-freq-mode').value;
            camp.freqTimes = parseInt(document.getElementById('ad-edit-freq-times').value);
            camp.freqValue = parseInt(document.getElementById('ad-edit-freq').value);
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
        sessionStorage.removeItem('selvaflix_full_database');
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
        sessionStorage.removeItem('selvaflix_full_database');
    } catch (e) {
        console.error("Error al fijar banner:", e);
        if (window.showToast) window.showToast("No se pudo clavar la bandera en la selva. 🐒", "error");
    }
};

window.setMetricsPreset = (preset) => {
  const startEl = document.getElementById('metrics-start-date');
  const endEl = document.getElementById('metrics-end-date');
  const now = new Date();
  let start = new Date();
  let end = new Date();
  
  if (preset === 'today') {
    start.setHours(0,0,0,0);
  } else if (preset === 'week') {
    start.setDate(now.getDate() - 7);
  } else if (preset === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  
  startEl.value = start.toISOString().split('T')[0];
  endEl.value = end.toISOString().split('T')[0];
  window.loadMetrics(startEl.value, endEl.value);
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

window.initMetricsSelectors = () => {
  // Por defecto: Este Mes al abrir el tab
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const lastDay = now.toISOString().split('T')[0];
  
  const startEl = document.getElementById('metrics-start-date');
  const endEl = document.getElementById('metrics-end-date');
  
  if (startEl && endEl) {
    // Solo cargamos si los campos están vacíos (primera vez que se abre)
    if (!startEl.value) {
      startEl.value = firstDay;
      endEl.value = lastDay;
      window.loadMetrics(firstDay, lastDay);
    }
  }
};

window.applyMetricsFilters = () => {
  const start = document.getElementById('metrics-start-date').value;
  const end = document.getElementById('metrics-end-date').value;
  if (!start || !end) return;
  window.loadMetrics(start, end);
};

window.loadMetrics = async (startDateStr, endDateStr) => {
  const log = document.getElementById('metrics-recent-log');
  const popularList = document.getElementById('metrics-popular-list');
  const deviceChart = document.getElementById('metrics-device-chart');
  
  // KPI Elements
  const totalVisits = document.getElementById('stat-total-visits');
  const totalPlays = document.getElementById('stat-total-plays');
  const totalUniqueEl = document.getElementById('stat-unique-visitors');
  const growthEl = document.getElementById('stat-growth');
  const growthLabel = document.getElementById('stat-growth-label');
  const peakEl = document.getElementById('stat-peak-hour');

  if (log) log.innerText = "Sincronizando con la selva... 📡";

  try {
    // await window.loadReports();
    
    // Si no hay fechas, usar mes actual por defecto
    if (!startDateStr || !endDateStr) {
        const now = new Date();
        startDateStr = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        endDateStr = now.toISOString().split('T')[0];
        document.getElementById('metrics-start-date').value = startDateStr;
        document.getElementById('metrics-end-date').value = endDateStr;
    }

    const start = new Date(startDateStr);
    start.setHours(0,0,0,0);
    const end = new Date(endDateStr);
    end.setHours(23,59,59,999);
    
    const metricsQuery = query(
      collection(db, "user_activity"), 
      where("timestamp", ">=", start.getTime()),
      where("timestamp", "<=", end.getTime()),
      orderBy("timestamp", "desc")
    );
    
    const snap = await getDocs(metricsQuery);
    const data = [];
    snap.forEach(doc => data.push(doc.data()));

    if (data.length === 0) {
      if (log) log.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);"><p>Sin actividad registrada en este periodo.</p></div>';
      [totalVisits, totalPlays, totalUniqueEl, growthEl, peakEl].forEach(el => { if(el) el.innerText = '0'; });
      return;
    }

    // 👥 Stats Base
    const uniqueVisitors = new Set(data.filter(d => d.visitorId).map(d => d.visitorId));
    const plays = data.filter(d => d.action === 'play_start' || d.action === 'watch_attempt').length;
    
    if (totalVisits) totalVisits.innerText = data.length;
    if (totalPlays) totalPlays.innerText = plays;
    if (totalUniqueEl) totalUniqueEl.innerText = uniqueVisitors.size;

    // 🚀 CRECIMIENTO (Comparativa vs periodo anterior similar)
    try {
        const rangeDuration = end.getTime() - start.getTime();
        const prevStart = new Date(start.getTime() - rangeDuration - 1);
        const prevEnd = new Date(start.getTime() - 1);
        
        const prevQuery = query(
            collection(db, "user_activity"),
            where("timestamp", ">=", prevStart.getTime()),
            where("timestamp", "<=", prevEnd.getTime())
        );
        const prevSnap = await getDocs(prevQuery);
        const prevCount = prevSnap.size;
        
        if (growthEl) {
            if (prevCount === 0) {
                growthEl.innerText = 'New';
                growthEl.style.color = '#2ECC71';
            } else {
                const diff = ((data.length - prevCount) / prevCount) * 100;
                growthEl.innerText = `${diff > 0 ? '+' : ''}${Math.round(diff)}%`;
                growthEl.style.color = diff >= 0 ? '#2ECC71' : '#E74C3C';
            }
        }
    } catch (e) { console.error("Error calculando crecimiento:", e); }

    // ⚡ PICO MÁXIMO (Hora con más tráfico)
    const hours = {};
    data.forEach(d => {
        const hour = new Date(d.timestamp).getHours();
        hours[hour] = (hours[hour] || 0) + 1;
    });
    const peakHour = Object.entries(hours).sort((a,b) => b[1] - a[1])[0];
    if (peakEl && peakHour) {
        peakEl.innerText = `${peakHour[0]}:00 hs`;
    }

    // 📅 Actividad por Día (Garantizar rango completo)
    const dayChart = document.getElementById('metrics-day-chart');
    if (dayChart) {
      const byDay = {};
      data.forEach(d => {
        const day = d.date || new Date(d.timestamp).toISOString().split('T')[0];
        if (!byDay[day]) byDay[day] = { total: 0, plays: 0 };
        byDay[day].total++;
        if (d.action === 'play_start' || d.action === 'watch_attempt') byDay[day].plays++;
      });

      // Generar lista de días en el rango
      const allDays = [];
      let current = new Date(start);
      while(current <= end) {
        allDays.push(current.toISOString().split('T')[0]);
        current.setDate(current.getDate() + 1);
      }

      const maxEvents = Math.max(...Object.values(byDay).map(v => v.total), 1);
      dayChart.innerHTML = allDays.map(day => {
        const info = byDay[day] || { total: 0, plays: 0 };
        const h1 = (info.total / maxEvents) * 100;
        const h2 = (info.plays / maxEvents) * 100;
        const shortDate = day.split('-')[2]; // Solo el número del día
        return `
          <div style="flex:1; min-width:18px; display:flex; flex-direction:column; align-items:center; gap:4px; height:100%;">
            <div style="flex:1; width:100%; display:flex; align-items:flex-end; gap:1px; position:relative; background:rgba(255,255,255,0.01); border-radius:1px;">
              <div style="width:50%; height:${h1}%; background:#3498DB; opacity:0.8;"></div>
              <div style="width:50%; height:${h2}%; background:#F1C40F; opacity:0.8;"></div>
            </div>
            <span style="font-size:0.45rem; color:#444;">${shortDate}</span>
          </div>
        `;
      }).join('');
    }

    // 🕒 Actividad por Hora (Peak Map)
    const hourChart = document.getElementById('metrics-hour-chart');
    if (hourChart) {
      const byHour = new Array(24).fill(0).map(() => ({ total: 0 }));
      data.forEach(d => {
        const h = new Date(d.timestamp).getHours();
        byHour[h].total++;
      });
      const maxH = Math.max(...byHour.map(v => v.total), 1);

      hourChart.innerHTML = byHour.map((info, h) => {
        const height = (info.total / maxH) * 100;
        const label = h.toString().padStart(2, '0');
        return `
          <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:4px; height:100%;">
            <div style="flex:1; width:100%; display:flex; align-items:flex-end; background:rgba(255,255,255,0.01);">
              <div style="width:100%; height:${height}%; background:#E67E22; opacity:0.8; border-radius:1px 1px 0 0;"></div>
            </div>
            <span style="font-size:0.45rem; color:#444;">${label}</span>
          </div>
        `;
      }).join('');
    }

    // Log Reciente
    log.innerHTML = data.slice(0, 30).map(d => {
      const date = new Date(d.timestamp).toLocaleTimeString();
      let color = "#2ECC71"; // green
      let emoji = "👀";
      if (d.action === 'play_start' || d.action === 'watch_attempt') { color = "#F1C40F"; emoji = "🎬"; }
      if (d.action === 'page_view') { color = "#3498DB"; emoji = "🧭"; }
      if (d.action === 'mass_seed') { color = "#E67E22"; emoji = "🚜"; }

      return `<div style="margin-bottom: 5px; border-bottom: 1px solid #222; padding-bottom: 2px;">
                <span style="color: #666;">[${date}]</span> 
                <span style="color: ${color}; font-weight: bold;">${emoji} ${d.action.toUpperCase()}</span>: 
                <span style="color: #eee;">${d.details?.title || d.details?.page || 'N/A'}</span>
                <span style="font-size: 0.6rem; color: #444;"> (${d.platform})</span>
            </div>`;
    }).join('');

    // Popularidad (Conteo por titulo)
    const counts = {};
    data.forEach(d => {
      if ((d.action === 'play_start' || d.action === 'watch_attempt') && d.details?.title) {
        const t = d.details.title;
        if (!counts[t]) counts[t] = { count: 0, last: 0, action: 'Reproducido' };
        counts[t].count++;
        if (d.timestamp > counts[t].last) counts[t].last = d.timestamp;
      }
    });

    const sortedPopular = Object.entries(counts).sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    popularList.innerHTML = sortedPopular.map(([title, info]) => `
            <tr>
                <td style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px;">${title}</td>
                <td style="font-weight: bold; color:white; text-align:right;">${info.count}</td>
            </tr>
        `).join('') || '<tr><td colspan="2" style="text-align:center; padding: 20px;">No hay datos.</td></tr>';

    // FCM Tokens counter
    try {
      const usersSnap = await getDocs(collection(db, "users"));
      let tokenCount = 0;
      usersSnap.forEach(d => {
          if (d.data().fcmToken) tokenCount++;
      });
      const subsEl = document.getElementById("push-subs-count");
      if(subsEl) subsEl.innerText = `${tokenCount} dispositivos suscritos.`;
    } catch (err) { console.error("Error cargando usuarios: ", err); }

    // Dispositivos (Chart simple)
    const platforms = {};
    data.forEach(d => { platforms[d.platform] = (platforms[d.platform] || 0) + 1; });
    const max = Math.max(...Object.values(platforms));

    deviceChart.innerHTML = Object.entries(platforms).map(([plat, count]) => {
      const width = (count / max) * 100;
      return `
                <div style="background: rgba(255,255,255,0.02); padding: 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.03);">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 0.6rem;">
                        <span style="color: #aaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80px;">${plat}</span>
                        <span style="color: #3498DB; font-weight: 800;">${count}</span>
                    </div>
                    <div style="height: 4px; background: rgba(255,122,0,0.05); border-radius: 2px; overflow: hidden;">
                        <div style="width: ${width}%; height: 100%; background: #3498DB; box-shadow: 0 0 5px rgba(52,152,219,0.3);"></div>
                    </div>
                </div>
            `;
    }).join('');

    // 🌍 ANALÍTICAS GEOGRÁFICAS (Fase 14)
    try {
        const geoQuery = query(
            collection(db, "analytics_geo"),
            where("ts", ">=", start.getTime()),
            where("ts", "<=", end.getTime())
        );
        const geoSnap = await getDocs(geoQuery);
        const geoData = [];
        geoSnap.forEach(d => geoData.push(d.data()));

        const geoStats = { countries: {}, cities: {} };
        geoData.forEach(d => {
            if (d.type === 'visit') {
                geoStats.countries[d.country] = (geoStats.countries[d.country] || 0) + 1;
                geoStats.cities[d.city] = (geoStats.cities[d.city] || 0) + 1;
            }
        });

        // Gráficas en pestaña Métricas
        window.renderGeoChart('metrics-geo-countries', 'Países', geoStats.countries, 'met_countries');
        window.renderGeoChart('metrics-geo-cities', 'Ciudades', geoStats.cities, 'met_cities');

        // Tabla de Desglose en Métricas
        const geoTableBody = document.getElementById('metrics-geo-table-body');
        if (geoTableBody) {
            const topCons = Object.entries(geoStats.countries).sort((a,b) => b[1] - a[1]).slice(0, 5);
            geoTableBody.innerHTML = topCons.map(([name, count]) => `
                <tr>
                    <td style="font-weight: bold; color: white;">${name}</td>
                    <td style="text-align: center;">${count}</td>
                    <td style="text-align: center; color: var(--primary);">
                        ${((count / Math.max(geoData.length, 1)) * 100).toFixed(1)}%
                    </td>
                </tr>
            `).join('') || '<tr><td colspan="3" style="text-align:center;">Sin datos geográficos.</td></tr>';
        }
    } catch (e) { console.warn("Error cargando analíticas geo:", e); }

    // La sección de "Links Reportados" ha sido removida del panel de Métricas
    // ya que esta información se gestiona desde los filtros del "Inventario".
  } catch (err) {
    console.error("Error loading metrics:", err);
    if (log) {
      log.innerHTML = `
            <div style="text-align:center; padding: 20px;">
                <p style="color: #E74C3C; font-weight:bold;">¡Fallo la conexión con las métricas! 🐒</p>
                <p style="font-size:0.7rem; color:var(--text-muted); margin-top:5px;">Error: ${err.message}</p>
                <p style="font-size:0.65rem; color:#666; margin-top:10px;">💡 Si es la primera vez, necesitas crear un índice en Firebase Console:<br>Colección "user_activity" → campo "timestamp" descendente.</p>
                <button class="btn btn-secondary" style="margin-top:15px; padding:6px 15px; font-size:0.7rem;" onclick="window.loadMetrics()">Reintentar 🔄</button>
            </div>
        `;
    }
  }
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
    alert('¡Gracias por reportar! Lo revisaremos pronto 🌴');
  } catch (e) {
    console.error('Error guardando reporte:', e);
  }
};

window.resolveReport = async (reportId) => {
  try {
    await updateDoc(doc(db, "link_reports", reportId), { status: 'resolved', resolvedAt: Date.now() });
    window.loadMetrics(); // refresca
  } catch (e) { console.error(e); }
};

window.filterInventoryByCategory = () => {
  const type = document.getElementById('inventory-type-filter')?.value || 'all';
  const category = document.getElementById('inventory-filter')?.value || 'all';
  const langFilter = document.getElementById('inventory-lang-filter')?.value || 'all';
  const genreFilter = document.getElementById('inventory-genre-filter')?.value || 'all';
  // Admin usa el buscador de la cabecera; fallback al legacy
  const searchInput = document.getElementById('admin-global-search') || document.getElementById('inventory-search');
  const query = searchInput ? searchInput.value.toLowerCase() : '';

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
    if (category === 'broken') matchHealth = window._brokenIds.has(m.id) || !m.img || (m.img && m.img.includes('placeholder'));
    if (category === 'missing') matchHealth = !m.tmdbId || m.tmdbId === "";
    if (category === 'review') matchHealth = m.status === 'review';
    if (category === 'waiting') matchHealth = m.status === 'waiting';
    if (category === 'verify') matchHealth = (m.status === 'review' || m.status === 'waiting') && m.embed && m.embed.includes('streamtape') && m.exportStatus !== 'processing';
    if (category === 'reported') matchHealth = window._reportedIds && window._reportedIds.has(m.id);
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
  sessionStorage.removeItem('selvaflix_full_database');
  sessionStorage.removeItem('selvaflix_cache_timestamp');

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
  sessionStorage.removeItem('selvaflix_full_database');
  sessionStorage.removeItem('selvaflix_cache_timestamp');
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
    sessionStorage.removeItem('selvaflix_full_database');
    sessionStorage.removeItem('selvaflix_cache_timestamp');
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
    sessionStorage.removeItem('selvaflix_full_database');
    sessionStorage.removeItem('selvaflix_cache_timestamp');
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

window.searchTMDB = async function (query, isSuggestion = false) {
  if (!query) return;
  const resultsDiv = document.getElementById('tmdb-results');
  if (!isSuggestion) resultsDiv.innerHTML = '<p style="color: var(--primary);">Buscando en Hollywood... 📡</p>';

  try {
    let data;
    const lang = document.getElementById('discover-lang')?.value || 'es-MX';
    // Si escriben solo números, lo buscamos directo por ID (Ej: 1032892)
    if (/^\d+$/.test(query.trim())) {
      const res = await fetch(`${TMDB_URL}/movie/${query.trim()}?api_key=${TMDB_API_KEY}&language=${lang}`);
      if (!res.ok) throw new Error("No encontrado");
      const movie = await res.json();
      data = { results: [movie] };
    } else {
      // Búsqueda multi (Películas y Series)
      const res = await fetch(`${TMDB_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=${lang}`);
      if (!res.ok) throw new Error("Error en API");
      data = await res.json();
    }

    if (!data.results || data.results.length === 0) {
      resultsDiv.innerHTML = '<p style="color: var(--text-muted);">No encontramos esa joya en la selva 🧐</p>';
      return;
    }

    // Save to global storage to avoid attribute escaping issues
    _tmdbLastResults = data.results.slice(0, 5);

    resultsDiv.innerHTML = (isSuggestion ? '<p style="width:100%; font-size:0.8rem; color:var(--primary); margin-bottom:5px;">💡 Sugerencias de Imagen:</p>' : '') +
      _tmdbLastResults.map((m, index) => {
        const title = m.title || m.name || "Sin Título";
        const type = m.media_type === 'tv' ? 'series' : 'movie';
        const imgUrl = m.poster_path ? (TMDB_IMG_URL + m.poster_path) : 'https://via.placeholder.com/150x225?text=SIN+POSTER';

        return `
        <div class="tmdb-item" onclick="window.selectTMDBMovie(${index})" style="cursor:pointer; min-width:100px; text-align:center;">
          <img src="${imgUrl}" alt="${title}" style="height:150px; border-radius:8px; object-fit:cover; margin-bottom:5px;" onerror="this.src='https://via.placeholder.com/150x225'">
          <p style="font-size:0.65rem; color:var(--primary); font-weight:bold;">[${type === 'series' ? 'Serie' : 'Peli'}]</p>
          <p style="font-size:0.7rem; color:white; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${title}</p>
        </div>
      `;
      }).join('');

  } catch (err) {
    console.error("TMDB error:", err);
    resultsDiv.innerHTML = '<p style="color: #E74C3C;">Error al conectar con TMDB (Revisa el ID) 🐒</p>';
  }
}

// Re-defining as global window.searchTMDB for consistency

window.selectTMDBMovie = async (index) => {
  const m = _tmdbLastResults[index];
  if (!m) return;

  const title = m.title || m.name;
  const originalTitle = m.original_title || m.original_name || "";
  const date = m.release_date || m.first_air_date || "2024";
  const type = m.media_type === 'tv' ? 'series' : 'movie';

  document.getElementById('m-title').value = title;
  document.getElementById('m-original-title').value = originalTitle;
  document.getElementById('m-img').value = m.poster_path ? (TMDB_IMG_URL + m.poster_path) : "";
  document.getElementById('m-backdrop').value = m.backdrop_path ? (TMDB_IMG_URL + m.backdrop_path) : "";
  document.getElementById('m-tmdb-id').value = m.id;
  document.getElementById('m-type').value = type;
  document.getElementById('m-year').value = date.split('-')[0];
  document.getElementById('m-rating').value = m.vote_average || '8.0';
  document.getElementById('m-embed').value = "";

  // Operación Búsqueda Pro: Obtener Títulos Alternativos, Director e ID IMDB
  try {
    const detailType = type === 'series' ? 'tv' : 'movie';
    const [extResp, altResp, credResp] = await Promise.all([
      fetch(`${TMDB_URL}/${detailType}/${m.id}/external_ids?api_key=${TMDB_API_KEY}`),
      fetch(`${TMDB_URL}/${detailType}/${m.id}/alternative_titles?api_key=${TMDB_API_KEY}`),
      fetch(`${TMDB_URL}/${detailType}/${m.id}/credits?api_key=${TMDB_API_KEY}`)
    ]);

    const extData = await extResp.json();
    document.getElementById('m-imdb-id').value = extData.imdb_id || "";

    const altData = await altResp.json();
    const titles = (altData.titles || altData.results || []).map(t => t.title);
    document.getElementById('m-alternative-titles').value = JSON.stringify(titles);

    const credData = await credResp.json();
    const director = credData.crew?.find(c => c.job === 'Director')?.name || "";
    document.getElementById('m-director').value = director;

  } catch (e) {
    console.warn("Fallo en recolección profunda de metadatos:", e);
  }

  const preview = document.getElementById('m-img-preview');
  if (preview) {
    preview.src = m.poster_path ? (TMDB_IMG_URL + m.poster_path) : 'https://via.placeholder.com/150x220?text=Previsualización';
  }

  alert(`Cosechada info de: ${title} 🥥🍹 (Metadatos Pro Activos)`);
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
async function collectUserData(action, details = {}) {
  try {
    const userData = {
      action,
      details,
      timestamp: Date.now(),
      platform: navigator.platform,
      userAgent: navigator.userAgent.substring(0, 80),
      visitorId: getVisitorId(),  // 🔑 ID de visitante unico
      date: new Date().toISOString().split('T')[0]  // '2026-03-11' para agrupar por dia
    };
    await addDoc(collection(db, "user_activity"), userData);
  } catch (e) { console.error("Error tracking:", e); }
}

// Player Logic & Multi-Server
function startPlayer(movie) {
  collectUserData("play_start", { title: movie.title, type: movie.type });

  // 🔥 Algoritmo de popularidad: guardar conteo de plays localmente
  const counts = JSON.parse(localStorage.getItem('selva_play_counts') || '{}');
  const key = movie.tmdbId || movie.id;
  counts[key] = (counts[key] || 0) + 1;
  localStorage.setItem('selva_play_counts', JSON.stringify(counts));

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
    sessionStorage.removeItem('selvaflix_full_database');
    sessionStorage.removeItem('selvaflix_cache_timestamp');
    
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
            await addDoc(collection(db, "analytics_geo"), {
                type: 'visit',
                ...geoInfo
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
        const analyticsRef = collection(db, "analytics_geo");
        // Últimos 7 días para el panel de anuncios
        const since = Date.now() - (7 * 24 * 60 * 60 * 1000);
        const q = query(analyticsRef, where("ts", ">=", since));
        const querySnapshot = await getDocs(q);
        
        let stats = { countries: {}, clicks: 0, views: 0 };

        querySnapshot.forEach((doc) => {
            const data = doc.data();
            if (data.type === 'visit') {
                stats.views++;
                stats.countries[data.country] = (stats.countries[data.country] || 0) + 1;
            } else if (data.type === 'ad_click') {
                stats.clicks++;
            }
        });

        // 📊 En el TAB de publicidad, solo mostramos la tabla de rendimiento de países vs clics
        const tableBody = document.getElementById('ad-analytics-table-body');
        if (tableBody) {
            const topCountries = Object.entries(stats.countries)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10);

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

    // Registrar en Firestore con Analytics
    try {
        const cachedGeo = JSON.parse(sessionStorage.getItem('selva_geo_cache') || '{}');
        await addDoc(collection(db, "analytics_geo"), {
            type: 'ad_click',
            adId: id,
            ts: now,
            country: cachedGeo.country || 'Desconocido',
            city: cachedGeo.city || 'Desconocido'
        });
    } catch (err) { }
};

async function startWarningOverlay(movie) {
  const overlay = document.getElementById('ad-overlay');
  if (!overlay) {
    startPlayer(movie);
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
      startPlayer(movie);
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
      startPlayer(movie);
      return;
    }

    // --- Ejecutar según Placement ---
    if (activeCampaign.placement === 'video_preroll') {
        // Lógica de VAST / Video Directo (Próxima implementación refinada)
        // Por ahora lo manejamos como un overlay con video si no es VAST
        window.showAdVideoPreroll(activeCampaign, movie);
        return;
    }

    // Default: card_overlay
    window.showWarningOverlayCard(activeCampaign, movie);

  } catch (e) {
    console.error("Error al iniciar el puente de anuncios:", e);
    startPlayer(movie);
  }
}

// 🃏 RENDERIZADO DE TARJETA (Reutilizable para Preview)
window.showWarningOverlayCard = (activeCampaign, movie, isPreview = false) => {
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
            if (!isPreview) window.finishAdFlow(activeCampaign, movie);
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
          if (!isPreview) window.finishAdFlow(activeCampaign, movie);
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

window.finishAdFlow = (activeCampaign, movie) => {
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
    startPlayer(movie);
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
window.showAdVideoPreroll = (camp, movie) => {
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
        startPlayer(m);
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
            const [_, mediaUrl, linkUrl] = item.split('|');
            const barWrapper = document.createElement('div');
            barWrapper.style.position = 'fixed';
            barWrapper.style.bottom = '15px';
            barWrapper.style.left = '50%';
            barWrapper.style.transform = 'translateX(-50%)';
            barWrapper.style.zIndex = '10000';
            barWrapper.style.maxWidth = '90%';
            barWrapper.style.pointerEvents = 'auto';
            barWrapper.innerHTML = `
                <div style="position: relative; background: #111; border: 1px solid var(--primary); border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.8); animation: socialSlideUp 0.5s ease;">
                    <button onclick="this.parentElement.parentElement.style.display='none'" style="position: absolute; top: 5px; right: 5px; background: rgba(0,0,0,0.5); border: none; color: white; border-radius: 50%; width: 20px; height: 20px; cursor: pointer; z-index: 10; display:flex; align-items:center; justify-content:center; font-size:12px;">&times;</button>
                    <a href="${linkUrl !== '#' ? linkUrl : 'javascript:void(0)'}" target="${linkUrl !== '#' ? '_blank' : '_self'}" style="text-decoration: none; display: block;">
                        <img src="${mediaUrl}" style="display: block; width: 100%; max-height: 80px; object-fit: cover;">
                    </a>
                </div>
            `;
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
  const userTier = (auth.currentUser && auth.currentUser.customClaims?.tier) || 'free';
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
        const snap = await getDoc(historyRef);
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
    if (typeof SelvaStream !== 'undefined') SelvaStream.close();
    // Volvemos al detalle — hash sin /play
    const currentHash = window.location.hash.substring(1);
    if (currentHash.includes('/play')) {
        window.location.hash = currentHash.replace('/play', '');
    } else if (!currentHash.startsWith('detail/')) {
        history.back();
    }
};

// Exported Actions
window.handleCardClick = (id) => {
    // Buscar la película para hacer un slug URL limpio
    const movie = movieDatabase?.trending?.find(m => m.id === id);
    if (movie) {
        const slug = slugify(movie.title, movie.year);
        window.location.hash = `detail/${slug}`;
    } else {
        window.location.hash = `detail/${id}`;
    }
};

// ======================================================
// DETALLE DE PELÍCULA — Vista Premium (Tailwind Design)
// ======================================================
// Cache en memoria para no repetir la consulta a TMDB al reabrir una ficha
const _backdropCache = new Map();

// La mayoría del catálogo se guardó sin campo `backdrop`, así que el hero del
// detalle terminaba usando el póster vertical. Aquí pedimos el apaisado real.
async function fetchBackdropTMDB(movie, el) {
    const clave = `${movie.type === 'series' ? 'tv' : 'movie'}:${movie.tmdbId}`;

    if (_backdropCache.has(clave)) {
        const guardado = _backdropCache.get(clave);
        if (guardado) aplicarBackdrop(el, guardado);
        return;
    }

    try {
        const tipo = movie.type === 'series' ? 'tv' : 'movie';
        const res = await fetch(`${TMDB_URL}/${tipo}/${movie.tmdbId}?api_key=${TMDB_API_KEY}&language=es-PE`);
        const data = await res.json();
        const path = data.backdrop_path;

        _backdropCache.set(clave, path || null);
        if (!path) return;

        // Solo aplicamos si el usuario sigue en la misma ficha
        if (el.isConnected) aplicarBackdrop(el, path);
    } catch (e) {
        console.warn('No se pudo traer el backdrop de TMDB:', e);
    }
}

function aplicarBackdrop(el, path) {
    const size = window.innerWidth >= 1024 ? 'w1280' : 'w780';
    el.style.backgroundImage = `url('https://image.tmdb.org/t/p/${size}${path}')`;
    el.style.backgroundPosition = 'center top';
}

window.openMovieDetail = (slugOrId, opts = {}) => {
    const movie = findMovieBySlugOrId(slugOrId);
    if (!movie) {
        console.warn('Movie not found for slug/id:', slugOrId);
        return;
    }
    // Sincronizar hash a slug limpio si llegamos por id antiguo
    const cleanSlug = slugify(movie.title, movie.year);
    const currentHash = window.location.hash.substring(1);
    if (currentHash === `detail/${movie.id}`) {
        history.replaceState(null, '', `#detail/${cleanSlug}`);
    }

    // 1. Backdrop / Hero Image
    const backdropEl = document.getElementById('detail-backdrop');
    if (backdropEl) {
        let imgUrl = movie.backdrop || movie.img || '';
        const esApaisado = !!movie.backdrop;

        // En escritorio el hero mide ~1600px: una w500 de TMDB se ve borrosa estirada.
        // Solo tocamos URLs de TMDB, los backdrops subidos a mano se quedan igual.
        if (window.innerWidth >= 1024 && imgUrl.includes('image.tmdb.org')) {
            imgUrl = imgUrl.replace(/\/w(200|300|500|780)\//, '/w1280/');
        }

        backdropEl.style.backgroundImage = `url('${imgUrl}')`;
        backdropEl.style.backgroundSize = 'cover';
        // Si lo que tenemos es el póster vertical (la mayoría del catálogo no trae
        // backdrop), encuadrar arriba deja ver solo la franja superior. El centro
        // es donde suele estar el sujeto.
        backdropEl.style.backgroundPosition = esApaisado ? 'center top' : 'center center';

        // Y en paralelo pedimos a TMDB el backdrop apaisado de verdad.
        if (!movie.backdrop && movie.tmdbId) fetchBackdropTMDB(movie, backdropEl);
    }

    // 2. Título
    const titleEl = document.getElementById('detail-title');
    if (titleEl) titleEl.textContent = movie.title || 'Sin Título';

    // 3. Año
    const yearEl = document.getElementById('detail-year');
    if (yearEl) yearEl.textContent = movie.year || movie.release_year || '';

    // 4. Rating
    const ratingEl = document.getElementById('detail-rating');
    if (ratingEl) ratingEl.textContent = movie.rating || '—';

    // 5. Sinopsis
    const synopsisEl = document.getElementById('detail-synopsis');
    if (synopsisEl) synopsisEl.textContent = movie.description || movie.overview || 'Sin descripción disponible.';

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
                    onerror="this.src='https://via.placeholder.com/300x450/1a1a1a/ff571a?text=SF'"
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
                            sessionStorage.removeItem('selvaflix_full_database');
                            sessionStorage.removeItem('selvaflix_cache_timestamp');
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
                            sessionStorage.removeItem('selvaflix_full_database');
                            sessionStorage.removeItem('selvaflix_cache_timestamp');
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
                    if (!link) return;

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

window.detailReportMovie = () => {
    const hash = window.location.hash;
    const movieId = hash.split('detail/')[1];
    const movie = movieDatabase.trending.find(m => m.id === movieId);
    if (!movie) return;
    const msg = `🚨 Reporte de contenido:\nPelícula: ${movie.title}\nID: ${movieId}\nMotivo: (describe el problema)`;
    window.showToast("¡Gracias por reportar! Revisaremos este contenido. 🛡️", "success");
};

window.detailShareMovie = async () => {
    const hash = window.location.hash;
    const movieId = hash.split('detail/')[1];
    const movie = movieDatabase.trending.find(m => m.id === movieId);
    if (!movie) return;
    const shareUrl = `${window.location.origin}${window.location.pathname}#detail/${movieId}`;
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

window.deleteMovie = async (id) => {
  if (confirm("¿Seguro que quieres eliminar esta joya de la selva? 🥥?")) {
    try {
      await deleteDoc(doc(db, "movies", id));
      sessionStorage.removeItem('selvaflix_full_database');
      sessionStorage.removeItem('selvaflix_cache_timestamp');
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
    sessionStorage.removeItem('selvaflix_full_database');
    sessionStorage.removeItem('selvaflix_cache_timestamp');
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
    sessionStorage.removeItem('selvaflix_full_database');
    sessionStorage.removeItem('selvaflix_cache_timestamp');
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

  // Llenar formulario
  document.getElementById('m-db-id').value = movie.id;
  document.getElementById('m-title').value = movie.title;
  document.getElementById('m-img').value = movie.img;
  document.getElementById('m-backdrop').value = movie.backdrop || "";
  document.getElementById('m-pinned').checked = movie.pinned || false;
  document.getElementById('m-tmdb-id').value = movie.tmdbId || "";
  document.getElementById('m-imdb-id').value = movie.imdbId || ""; // Operación IMDB-Latino
  document.getElementById('m-embed').value = movie.embed || "";
  document.getElementById('m-year').value = (movie.year || '2024').toString().split('-')[0];
  document.getElementById('m-rating').value = movie.rating || '4.8';
  document.getElementById('m-type').value = movie.type || 'movie';
  
  // VIP Fields
  const isVip = movie.isVIP || false;
  document.getElementById('m-is-vip').checked = isVip;
  document.getElementById('m-vip-options').style.display = isVip ? 'block' : 'none';
  document.getElementById('m-release-date').value = movie.releaseDate ? new Date(movie.releaseDate).toISOString().slice(0, 16) : "";
  document.getElementById('m-show-countdown').checked = movie.showCountdown !== false;

  // Actualizar previsualizaciones
  document.getElementById('m-img-preview').src = movie.img;
  document.getElementById('m-backdrop-preview').src = movie.backdrop || 'https://via.placeholder.com/600x338/111/555?text=Sin+Banner';

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
  
  window.openUploadDrawer();

  // Cargar previsualización del video al editar
  window.updateMiniPlayer();
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
  sessionStorage.removeItem('selvaflix_full_database');
  sessionStorage.removeItem('selvaflix_cache_timestamp');
  alert("¡Sembrado con éxito! 🌴");
};

// quickSeedManual consolidada más abajo

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

  // Comparación robusta: acepta tmdbId como string o number
  const existingIds = new Set(
    movieDatabase.trending
      .filter(m => m.tmdbId != null)
      .map(m => String(m.tmdbId))
  );

  const isTv = type === 'series' || type === 'anime' || type === 'tv';
  const endpoint = isTv ? 'tv' : 'movie';
  const maxExtraAttempts = 5; // Si la página 1 está llena de duplicados, probamos hasta 5 páginas más
  let pagesSearched = 0;
  let totalPagesTried = 0;

  try {
    // Buscamos las páginas pedidas, y si todas están duplicadas probamos más automáticamente
    for (let attempt = 0; pagesSearched < pages && attempt < pages + maxExtraAttempts; attempt++) {
      const pageNum = attempt + 1;
      status.innerText = `🔍 Buscando página ${pageNum}... (${pendingSeeds.length} nuevas encontradas)`;

      const sortBy = document.getElementById('discover-sort')?.value || 'popularity.desc';
      let url = `${TMDB_URL}/discover/${endpoint}?api_key=${TMDB_API_KEY}&language=${lang}&sort_by=${sortBy}&page=${pageNum}`;
      if (year && year !== '') url += `&${isTv ? 'first_air_date_year' : 'primary_release_year'}=${year}`;
      if (genre && genre !== '') url += `&with_genres=${genre}`;
      const origLang = document.getElementById('discover-orig-lang')?.value || '';
      if (origLang !== '') url += `&with_original_language=${origLang}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`TMDB respondió con error ${res.status}`);
      const data = await res.json();
      totalPagesTried++;

      if (!data.results || data.results.length === 0) break; // No hay más páginas

      let foundNew = 0;
      for (const s of data.results) {
        const tmdbIdStr = String(s.id);
        if (!existingIds.has(tmdbIdStr) && (s.poster_path || s.backdrop_path)) {
          pendingSeeds.push({
            title: s.title || s.name || 'Sin título',
            original_title: s.original_title || s.original_name || "",
            img: TMDB_IMG_URL + (s.poster_path || s.backdrop_path),
            tmdbId: tmdbIdStr,
            year: (s.release_date || s.first_air_date || '2024').split('-')[0],
            rating: s.vote_average?.toFixed(1) || '7.5',
            genres: (s.genre_ids || []).map(String),
            type: type,
            lang: lang
          });
          foundNew++;
        }
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

    status.innerText = `✅ ¡${pendingSeeds.length} coconas nuevas! Desmarca las que no quieras:`;
    confirmBtn.style.display = 'block';
    confirmBtn.innerText = `✅ Sembrar ${pendingSeeds.length} Coconas`;

    list.innerHTML = pendingSeeds.map((s, idx) => `
      <div style="background: rgba(255,255,255,0.05); padding: 8px; border-radius: 8px; display: flex; align-items: center; gap: 8px; border: 1px solid var(--glass-border);">
        <input type="checkbox" checked class="seed-check" data-idx="${idx}" onchange="window.updateSeedCount()">
        <img src="${s.img}" style="width: 35px; height: 50px; object-fit: cover; border-radius: 4px;" onerror="this.src='https://via.placeholder.com/35x50?text=IMG'">
        <div style="flex: 1; overflow: hidden;">
          <p style="font-size: 0.7rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: bold; color:white;">${s.title}</p>
          <p style="font-size: 0.6rem; color: var(--text-muted);">${s.year} · ${s.type}</p>
        </div>
      </div>
    `).join('');

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

    const mData = {
      ...s,
      imdbId: imdbId,
      embed: "",
      status: toReview ? 'review' : 'healthy',
      createdAt: Date.now()
    };
    try {
      await addDoc(moviesCol, mData);
      collectUserData("manual_seed", { title: s.title, type: s.type });
      count++;
      const percent = Math.round((count / checks.length) * 100);
      if (bar) bar.style.width = `${percent}%`;
      if (text) text.innerText = `${percent}% (${count}/${checks.length})`;
    } catch (e) {
      console.error("Error sembrando:", e);
    }
  }

  sessionStorage.removeItem('selvaflix_full_database');
  sessionStorage.removeItem('selvaflix_cache_timestamp');

  if (overlay) overlay.style.display = 'none';
  if (window.showToast) {
    window.showToast(`✅ ¡Siembra masiva completada! ${count} elementos añadidos. 🌴🍿`, "success");
  }
  document.getElementById('discover-container').style.display = 'none';
};


async function updateHeroCarousel() {
  if (!heroPool || heroPool.length === 0) return;
  const section = document.getElementById('hero-section');
  if (!section) return;

  const item = heroPool[currentHeroIndex % heroPool.length];
  if (!item) return;

  // Buscar backdrop: si no tiene, lo busca de TMDB al vuelo
  let heroImg = item.backdrop || item.img;
  
  if (!item.backdrop && item.tmdbId) {
    try {
      // Determinar si es serie o película
      const type = item.type === 'series' || item.type === 'tv' ? 'tv' : 'movie';
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
      ? '<span class="material-symbols-outlined" style="font-variation-settings: \'FILL\' 1;">check</span> En Mi Selva'
      : '<span class="material-symbols-outlined">add</span> Mi Lista';
  }
}

function startHeroAutoRotation() {
  if (heroTimer) clearInterval(heroTimer);
  heroTimer = setInterval(() => {
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

function initApp(filterType = '', genreId = '') {
  if (!movieDatabase.trending.length) return;

  const container = document.getElementById('main-content');
  if (container) {
    container.innerHTML = '';
    renderSkeletons(); // Flash visual instantáneo
  }

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
  let allContent = [...movieDatabase.trending].sort((a, b) => {
    const healthA = window._brokenIds.has(a.id) ? 0 : 1;
    const healthB = window._brokenIds.has(b.id) ? 0 : 1;
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

  // --- Motor Hero Elite Algorithm v2.40 ---
  let heroPoolRaw = allContent.filter(c => !window._brokenIds.has(c.id));
  
  if (filterType === 'series') {
    heroPoolRaw = heroPoolRaw.filter(c => c.type === 'series' || c.type === 'tv' || c.type === 'anime');
  } else if (filterType === 'movies') {
    heroPoolRaw = heroPoolRaw.filter(c => c.type === 'movie' || !c.type);
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
    // Si no hay series en el hero, intentamos poner peliculas destacadas para no dejar el hueco
    if (filterType === 'series') {
        const fallbackPool = allContent.filter(c => !window._brokenIds.has(c.id) && (c.type === 'movie' || !c.type)).slice(0, 3);
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
    const anime = allContent.filter(c => c.type === 'anime');
    console.log(`Renderizando Series (${series.length}) y Anime (${anime.length})`);
    renderGallery('Series & Anime', [
      { label: `Series${genreId ? ' · filtradas' : ''}`, items: series },
      { label: `Anime`, items: anime }
    ]);

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

    // 2. Tendencias en la Selva (Local)
    const popularity = [...allContent]
      .filter(c => c.type !== 'live')
      .map(c => ({ ...c, plays: playCounts[c.tmdbId] || playCounts[c.id] || 0 }))
      .filter(c => c.plays > 0)
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 12);
    if (popularity.length > 0) renderRow('Tendencias en la Selva', popularity);

    // 3. Categorías Estándar
    const movies = allContent.filter(c => c.type === 'movie' || !c.type).slice(0, 12);
    const series = allContent.filter(c => c.type === 'series' || c.type === 'tv').slice(0, 12);
    const anime = allContent.filter(c => c.type === 'anime').slice(0, 12);

    if (movies.length > 0) renderRow('Películas', movies, 'movies');
    if (series.length > 0) renderRow('Series', series, 'series');
    if (anime.length > 0) renderRow('Anime', anime, 'series');

    // ALGORITMO 2: Tendencias Globales de TMDB (para usuarios nuevos sin historial)
    // Corre en paralelo sin bloquear la UI (async fire-and-forget)
    (async () => {
      try {
        const trendRes = await fetch(`${TMDB_URL}/trending/all/week?api_key=${TMDB_API_KEY}&language=es-MX`);
        const trendData = await trendRes.json();
        if (!trendData.results) return;
        
        // Solo mostrar los que YA están en nuestra selva (así no mostramos links rotos)
        const selfIds = new Set(allContent.map(c => String(c.tmdbId)));
        const globalTrends = trendData.results
          .filter(t => selfIds.has(String(t.id)))
          .map(t => allContent.find(c => String(c.tmdbId) === String(t.id)))
          .filter(Boolean)
          .slice(0, 12);

        if (globalTrends.length > 0 && container.isConnected) {
          renderRow('Lo más visto en el Mundo', globalTrends);
          const worldSection = container.lastElementChild;
          // Insertar después de Tendencias en la Selva (si existe) o al principio
          const selvaRow = container.querySelector('.category-row');
          if (selvaRow) selvaRow.after(worldSection);
          else container.insertBefore(worldSection, container.firstChild);
        }
      } catch (e) {
        console.warn('No se pudo cargar tendencias globales TMDB:', e.message);
      }
    })();
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
    sessionStorage.removeItem('selvaflix_full_database');
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
  // Nota: handleRouting se dispara automáticamente cuando loadSelvaFlixData termina de cargar
  // ⚡ Cargar Publicidad al Inicio (Para todos los usuarios)
  window.loadAdConfig();

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
    year: document.getElementById('m-year').value || new Date().getFullYear().toString(),
    rating: document.getElementById('m-rating').value || '7.0',
    type: document.getElementById('m-type').value || 'movie',
    lang: document.getElementById('m-lang')?.value || 'es-MX',
    status: document.getElementById('m-status').value,
    isVIP: document.getElementById('m-is-vip').checked,
    releaseDate: document.getElementById('m-release-date')?.value ? new Date(document.getElementById('m-release-date').value).getTime() : null,
    showCountdown: document.getElementById('m-show-countdown')?.checked ?? true,
    updatedAt: Date.now()
  };

  try {
    if (dbId) {
      await updateDoc(doc(db, "movies", dbId), movieData);
      window.showToast('¡Título actualizado! 🌴🔄', 'success');
    } else {
      movieData.createdAt = Date.now();
      await addDoc(moviesCol, movieData);
      window.showToast('¡Título añadido exitosamente! 🌴🍿', 'success');
    }

    window.closeUploadDrawer();
    sessionStorage.removeItem('selvaflix_full_database');
    sessionStorage.removeItem('selvaflix_cache_timestamp');
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

// Test embed link by playing it
window.testEmbedLink = () => {
  const embedUrl = document.getElementById('m-embed').value.trim();
  if (!embedUrl) { window.showToast('Paste a video URL first', 'error'); return; }
  const preview = document.getElementById('admin-embed-preview');
  const filename = document.getElementById('admin-embed-filename');
  if (preview) preview.style.display = 'flex';
  if (filename) filename.textContent = embedUrl.substring(0, 50) + (embedUrl.length > 50 ? '…' : '');
  window.showToast('Link registered. Use Play to test.', 'info');
};

window.clearEmbedLink = () => {
  document.getElementById('m-embed').value = '';
  const preview = document.getElementById('admin-embed-preview');
  if (preview) preview.style.display = 'none';
};

// Quick admin actions from drawer
window.approveFromDrawer = async () => {
  const id = document.getElementById('m-db-id').value;
  if (!id) return;
  try {
    await updateDoc(doc(db, "movies", id), { status: 'healthy', updatedAt: Date.now() });
    document.getElementById('m-status').value = 'healthy';
    window.showToast('✅ Aprobado como Healthy', 'success');
  } catch(e) { window.showToast('Error: ' + e.message, 'error'); }
};

window.waitFromDrawer = async () => {
  const id = document.getElementById('m-db-id').value;
  if (!id) return;
  try {
    await updateDoc(doc(db, "movies", id), { status: 'waiting', updatedAt: Date.now() });
    document.getElementById('m-status').value = 'waiting';
    window.showToast('⏳ Puesto en Waiting', 'success');
  } catch(e) { window.showToast('Error: ' + e.message, 'error'); }
};

window.deleteFromDrawer = async () => {
  const id = document.getElementById('m-db-id').value;
  const title = document.getElementById('m-title').value;
  if (!id) return;
  if (!confirm(`¿Borrar "${title}"? Esto no se puede deshacer.`)) return;
  try {
    await window.deleteMovie(id);
    window.closeUploadDrawer();
  } catch(e) { window.showToast('Error: ' + e.message, 'error'); }
};

window.setAdminPriorityFromDrawer = async () => {
  const id = document.getElementById('m-db-id').value;
  const url = document.getElementById('detail-admin-manual-link-input').value.trim();
  if (!id || !url) { window.showToast('Necesitas un ID de película y una URL', 'error'); return; }
  try {
    await updateDoc(doc(db, "movies", id), { embed: url, status: 'healthy', updatedAt: Date.now() });
    document.getElementById('m-embed').value = url;
    document.getElementById('m-status').value = 'healthy';
    window.showToast('🔒 Priority link set!', 'success');
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
      sessionStorage.removeItem('selvaflix_full_database');
      sessionStorage.removeItem('selvaflix_cache_timestamp');
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
  const installBtn = document.getElementById('pwa-install-btn');
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  const showInstaller = async () => {
    if (isStandalone) return;
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        deferredPrompt = null;
        if (installBtn) installBtn.style.display = 'none';
        localStorage.setItem('pwa_installed', 'true');
      }
    }
  };

  // Listeners
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) {
      installBtn.style.display = 'flex';
    }
  });

  if (installBtn) {
    installBtn.addEventListener('click', showInstaller);
  }

  window.addEventListener('appinstalled', () => {
    localStorage.setItem('pwa_installed', 'true');
    if (installBtn) installBtn.style.display = 'none';
  });
});

// --- SISTEMA DE USUARIOS & PERFILES (Fase 6) ---
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
        sessionStorage.removeItem('selva_active_profile');
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
    const modal = document.getElementById('profile-edit-name-modal');
    const saveBtn = document.getElementById('btn-save-profile-name');
    
    input.value = _currentProfile.name;
    modal.style.display = 'flex';
    
    saveBtn.onclick = () => {
        const newName = input.value.trim();
        if (!newName) return;
        window._tempProfileToUpdate = { id: _currentProfile.id, name: newName };
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

onAuthStateChanged(auth, async (user) => {
    if (user) {
        console.log("👤 Sesión activa:", user.email);
        
        // Verificación de BAN (Admin Only)
        const userRef = doc(db, "users", user.uid);
        // En una implementación real verificaríamos un campo 'banned' en el documento del usuario.
        
        document.getElementById('user-initials').innerText = user.displayName.charAt(0);
        document.getElementById('user-initials').style.display = 'flex';
        document.getElementById('user-avatar-img').style.display = 'none';
        
        // Cargar perfiles
        await window.loadProfiles(user.uid);
        
        // Restaurar perfil activo si existe (aplica el animalito)
        const saved = sessionStorage.getItem('selva_active_profile');
        if (saved) {
            await window.applyProfile(JSON.parse(saved));
        }
        
        // 🚀 Si ya cargamos perfiles pero no hay uno activo, esconder splash para dejar ver el selector
        if (!saved) {
            window.hideSplashScreen(true);
        }
    } else {
        console.log("👻 Modo Invitado");
        const userNameEl = document.getElementById('user-name');
        if (userNameEl) userNameEl.innerText = "Login";
        document.getElementById('user-initials').innerText = "G";
        document.getElementById('user-avatar-img').style.display = 'none';
        document.getElementById('user-initials').style.display = 'flex';
        
        // 🚀 Si es invitado, dejar ver la pantalla de Auth de inmediato
        window.hideSplashScreen(true);
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
    const snap = await getDocs(profilesCol);
    const profiles = [];
    snap.forEach(d => profiles.push({ id: d.id, ...d.data() }));

    if (profiles.length === 0) {
        const defaultProfile = { name: auth.currentUser.displayName.split(' ')[0], avatar: '🐯', isChild: false, isPrimary: true };
        const docRef = await addDoc(profilesCol, defaultProfile);
        profiles.push({ id: docRef.id, ...defaultProfile });
    } else {
        // Retrocompatibilidad: Si ningún perfil es primario, establecer el primero
        const hasPrimary = profiles.some(p => p.isPrimary);
        if (!hasPrimary && profiles.length > 0) {
            profiles[0].isPrimary = true;
            const profileRef = doc(db, "users", uid, "profiles", profiles[0].id);
            await updateDoc(profileRef, { isPrimary: true }).catch(e => console.warn("No se pudo marcar perfil principal:", e));
        }
    }

    window._allProfiles = profiles; // Guardar caché local
    window.renderProfiles(profiles);
    
    const saved = sessionStorage.getItem('selva_active_profile');
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

window.renderProfiles = (profiles) => {
    const grid = document.getElementById('profiles-grid');
    if (!grid) return;

    grid.innerHTML = profiles.map(p => {
        const action = _isManagingProfiles 
            ? `window.editSpecificProfile('${p.id}', '${p.name}', '${p.avatar}', '${p.pin || ''}', ${p.isPrimary || false})`
            : `window.selectProfile('${p.id}', '${p.name}', '${p.avatar}', '${p.pin || ''}')`;
            
        const primaryBadge = p.isPrimary ? `<span style="position: absolute; top: -10px; left: -10px; font-size: 1.5rem; filter: drop-shadow(0 2px 5px rgba(0,0,0,0.5)); z-index: 5;" title="Perfil Principal">👑</span>` : '';

        return `
            <div class="profile-item" style="width: 150px; position: relative;">
                <div onclick="${action}" style="cursor:pointer; transition: transform 0.2s; width: 120px; height: 120px; background: #222; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 3.5rem; margin: 0 auto 10px; border: 3px solid transparent; box-shadow: 0 10px 20px rgba(0,0,0,0.3); position: relative;" onmouseover="this.style.borderColor='white';" onmouseout="this.style.borderColor='transparent';">
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
    }).join('') + `
        <div class="profile-item" onclick="window.showAddProfile()" style="cursor:pointer; width: 150px;">
            <div style="width: 120px; height: 120px; background: none; border: 2px dashed #444; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 3rem; margin: 0 auto 10px; color: #444;" onmouseover="this.style.borderColor='#888'; this.style.color='#888';" onmouseout="this.style.borderColor='#444'; this.style.color='#444';">
                <span style="font-size: 3rem;">+</span>
            </div>
            <p style="color: #444; font-size: 1.1rem;">Añadir</p>
        </div>
    `;
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
        sessionStorage.setItem('selva_active_profile', JSON.stringify(p));
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
                sessionStorage.setItem('selva_active_profile', JSON.stringify(p));
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
            sessionStorage.setItem('selva_active_profile', JSON.stringify(p));
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
                sessionStorage.setItem('selva_active_profile', JSON.stringify(p));
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
                sessionStorage.setItem('selva_active_profile', JSON.stringify(p));
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
            sessionStorage.removeItem('selva_active_profile');
            _currentProfile = null;
            window.showProfileSelector();
        }
    } catch (e) {
        console.error("❌ Error al eliminar perfil:", e);
        if (window.showToast) window.showToast("Ocurrió un error al intentar eliminar el perfil.", "error");
    }
};

window.openAvatarPicker = () => {
    console.log("🐾 Abriendo Selector de Personajes...");
    const modal = document.getElementById('avatar-selector-modal');
    const grid = document.getElementById('avatar-options-grid');
    const avatars = ['🦁', '🐯', '🦒', '🐘', '🐊', '🦜', '🦥', '🐺', '🦊', '🐶', '🐱', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵'];
    
    if (grid) {
        grid.innerHTML = avatars.map(a => `
            <div onclick="window.finalizeProfileUpdate('${a}')" style="font-size: 3rem; cursor: pointer; padding: 10px; border-radius: 10px; transition: background 0.2s; display: flex; align-items: center; justify-content: center;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='none'">
                ${a}
            </div>
        `).join('');
    }
    
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
        sessionStorage.setItem('selva_active_profile', JSON.stringify(_currentProfile));
        window.applyProfile(_currentProfile);
    }
};

window.showAddProfile = async () => {
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

        if (history.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        const grid = document.getElementById('continue-watching-grid');
        if (!grid) return;
        
        grid.innerHTML = history.map(h => {
            const progress = (h.lastTime / h.duration) * 100;
            const poster = (h.poster && h.poster.startsWith('http')) ? h.poster : 'https://image.tmdb.org/t/p/w300' + (h.poster || h.poster_path);
            return `
                <div class="card-horizontal-container" onclick="window.handleCardClick('${h.movieId}')">
                    <div class="card-horizontal-media">
                        <img src="${poster}" alt="${h.title}" loading="lazy" onerror="this.src='/icon_192.png'">
                        <div class="progress-bar-h">
                            <div class="progress-fill-h" style="width: ${progress}%;"></div>
                        </div>
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
    const myList = [];
    window._myListIds.clear();
    snap.forEach(d => { const data = d.data(); myList.push(data); window._myListIds.add(data.movieId); });
    const badge = document.getElementById("nav-fav-count");
    const buildCard = (m) => {
        const p = (m.poster || "").startsWith("http") ? m.poster : "https://image.tmdb.org/t/p/w300" + m.poster;
        return `<div class="mylist-card" onclick='window.handleCardClick("${m.movieId}")'><div class="mylist-card-bg" style="background-image:url('${p}');"></div><div class="mylist-card-gradient"></div><div class="mylist-card-overlay"><button class="mylist-play-btn" onclick="event.stopPropagation();window.handleCardClick('${m.movieId}')"><span class="material-symbols-outlined">play_arrow</span></button><button class="mylist-remove-btn" onclick="event.stopPropagation();window.toggleMyList('${m.movieId}',this)"><span class="material-symbols-outlined">close</span></button></div><div class="mylist-card-title">${m.title}</div></div>`;
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
  const embedUrl = document.getElementById('m-embed').value.trim();
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

window.generateSource = (serverType) => {
  const tmdbId = document.getElementById('m-tmdb-id').value.trim();
  const imdbId = document.getElementById('m-imdb-id').value.trim();
  const type = document.getElementById('m-type').value;

  if (!tmdbId && !imdbId) {
    alert("¡Necesitas primero buscar y seleccionar la película en TMDb para obtener el ID! 🐒");
    return;
  }

  let generatedUrl = "";
  const isTV = (type === 'series' || type === 'tv' || type === 'anime');

  if (serverType === 'vidsrc_to') {
    if (isTV) {
      generatedUrl = `https://vidsrc.to/embed/tv/${tmdbId}/1/1`;
      alert("Se generó el enlace para la Temporada 1, Episodio 1. Puedes editar los números de temporada y episodio en la URL si lo deseas. 🍿");
    } else {
      generatedUrl = `https://vidsrc.to/embed/movie/${tmdbId}`;
    }
  } else if (serverType === 'vidsrc_me') {
    if (isTV) {
      generatedUrl = `https://vidsrc.xyz/embed/tv/${tmdbId}/1-1`;
    } else {
      generatedUrl = `https://vidsrc.xyz/embed/movie/${tmdbId}`;
    }
  } else if (serverType === 'vidsrc_pro') {
    if (isTV) {
      generatedUrl = `https://vidsrc.pro/embed/tv/${tmdbId}/1/1`;
    } else {
      generatedUrl = `https://vidsrc.pro/embed/movie/${tmdbId}`;
    }
  } else if (serverType === 'superembed') {
    const id = imdbId || tmdbId;
    generatedUrl = `https://multiembed.to/imdb.php?video_id=${id}`;
  }

  if (generatedUrl) {
    document.getElementById('m-embed').value = generatedUrl;
    window.updateMiniPlayer();
    window.showToast("Fuente generada con éxito 🔌", "success");
  }
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
      // Si tiene infoHash, de-restringimos primero si es posible, o usamos la url directa si existe
      let directUrl = s.url;
      if (s.infoHash && !directUrl) {
        window.showToast("De-restringiendo link magnet...", "info");
        SelvaStream.callMasterWorker(s.infoHash).then(rdData => {
          if (rdData && rdData.url) {
            document.getElementById('m-embed').value = rdData.url;
            window.updateMiniPlayer();
            window.showToast("¡Magnet de-restringido cargado en el video!", "success");
          } else {
            window.showToast("No se pudo de-restringir. Poniendo infoHash.", "warning");
            document.getElementById('m-embed').value = s.infoHash;
          }
        });
      } else {
        document.getElementById('m-embed').value = directUrl || s.infoHash || "";
        window.updateMiniPlayer();
        window.showToast("Enlace de origen cargado con éxito", "success");
      }
    }
  });
};

