// Caché del catálogo en IndexedDB.
//
// Antes vivía en localStorage ('selvaflix_full_database'). Con ~10k títulos el
// JSON pesaba 4,4 M caracteres: casi el tope de Chrome (~5 M) y muy por encima
// del de Safari/iOS (5 MB en bytes UTF-16). Cuando no entraba, setItem tiraba
// QuotaExceededError dentro de la carga, la promesa nunca se resolvía y la app
// quedaba en negro — y "volvía" sola a medida que el catálogo crecía.
// IndexedDB no tiene ese tope y guarda el objeto tal cual (sin JSON.parse
// síncrono de 4 MB al arrancar).
//
// La vigencia se sigue marcando con 'selvaflix_cache_timestamp' en
// localStorage (lectura síncrona, barata): sin timestamp = caché inválido.

const DB_NAME = 'selvamov';
const STORE = 'catalogo';
const KEY = 'trending';
export const CACHE_TIME_KEY = 'selvaflix_cache_timestamp';
const LEGACY_KEY = 'selvaflix_full_database';

let _dbPromise = null;
function abrirDb() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('sin IndexedDB'));
  if (!_dbPromise) {
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { _dbPromise = null; reject(req.error); };
      // Otra pestaña con una versión vieja abierta: no esperar para siempre.
      req.onblocked = () => { _dbPromise = null; reject(new Error('IndexedDB bloqueada')); };
    });
  }
  return _dbPromise;
}

function tx(modo, fn) {
  return abrirDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, modo);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

// Devuelve el array de títulos guardado, o null. Nunca lanza.
export async function leerCatalogoCache() {
  try {
    const trending = await tx('readonly', s => s.get(KEY));
    return Array.isArray(trending) ? trending : null;
  } catch (e) {
    console.warn('Caché del catálogo ilegible:', e?.message || e);
    return null;
  }
}

// Guarda el array de títulos y marca la hora. Nunca lanza.
export async function guardarCatalogoCache(trending) {
  try {
    await tx('readwrite', s => s.put(trending, KEY));
    localStorage.setItem(CACHE_TIME_KEY, Date.now().toString());
  } catch (e) {
    console.warn('No se pudo guardar el catálogo en caché:', e?.message || e);
  }
}

export function cacheCatalogoVigente(maxEdadMs) {
  const ts = parseInt(localStorage.getItem(CACHE_TIME_KEY) || '', 10);
  return Number.isFinite(ts) && (Date.now() - ts) < maxEdadMs;
}

// Hay timestamp pero pasó el tiempo: la copia sirve para mostrar al instante
// mientras se refresca por detrás. Sin timestamp (primera visita o
// invalidarCacheCatalogo) es false: ahí se espera a la red.
export function cacheCatalogoVencidoPorTiempo() {
  return Number.isFinite(parseInt(localStorage.getItem(CACHE_TIME_KEY) || '', 10));
}

// Fuerza a que la próxima carga espere el catálogo fresco (el admin acaba de
// editar). El contenido de IndexedDB se conserva como respaldo si la red falla.
export function invalidarCacheCatalogo() {
  try {
    localStorage.removeItem(CACHE_TIME_KEY);
    localStorage.removeItem(LEGACY_KEY); // limpia el caché viejo de localStorage
  } catch {}
}

// El caché viejo ocupaba casi todo localStorage: liberarlo para que el resto
// de la app (perfil, anuncios, progreso) pueda escribir.
try { localStorage.removeItem(LEGACY_KEY); } catch {}
