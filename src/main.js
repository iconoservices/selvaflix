import './style.css'
import { SelvaStream } from './components/Player/Player.js'
import './components/Player/Player.css'
/* 
   🌴 Perla de Sabiduría: Firebase es nuestro "Puesto de Vigilancia". 
   Mantiene un ojo en los datos y nos avisa al instante cuando algo cambia en la selva.
*/
import { initializeApp } from "firebase/app";
import { getFirestore, collection, onSnapshot, addDoc, deleteDoc, doc, updateDoc, query, orderBy, limit, getDocs } from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";

// --- Firebase Configuration ---
const firebaseConfig = {
  apiKey: "AIzaSyCABaNkvULmjBatNh0Giih01IDH4sNbt1Q",
  authDomain: "selvaflix-5d991.firebaseapp.com",
  projectId: "selvaflix-5d991",
  storageBucket: "selvaflix-5d991.firebasestorage.app",
  messagingSenderId: "935630160406",
  appId: "1:935630160406:web:171ecfcb9e4258628bab37",
  measurementId: "G-N4DRH9QPE3"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);
const moviesCol = collection(db, "movies");

// --- Service Worker Registration ---
/* 
   🧹 El "Conserje Invisible": Este pequeño script corre en segundo plano. 
   Su trabajo es asegurarse de que la app abra rápido y tenga comida (datos) incluso si cae un diluvio y se va el internet.
*/
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('🌴 Selva PWA: Service Worker Activo'))
      .catch(err => console.error('Error registrando SW:', err));
  });
}

// --- TMDB API Config ---
const TMDB_API_KEY = '15d2ea6d0dc1d476efbca3eba2b9bbfb'; // Clave publica para demos
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

      // �️ Vigía Inteligente: Validar que el objeto tenga cara y ojos
      if (!hydratedObject || !Array.isArray(hydratedObject.trending)) {
        throw new Error("Caché incompleto o corrupto");
      }

      console.log(`🟢 Objeto rehidratado: { trending: ${hydratedObject.trending.length} }. (0 lecturas)`);
      movieDatabase = hydratedObject;
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
    } catch (error) {
      console.error("❌ Error en la expedición de datos:", error);
      return; // Muerte súbita
    }
  }

  // 3. Renderizar
  if (document.getElementById('admin-view')?.style.display === 'block') {
    _updateDetailedStats(movieDatabase.trending);
  }

  // Nota: handleRouting ya sabe si es la primera vez al revisar el DOM
  handleRouting();
}

// Iniciar recolección al cargar
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
  ['filter-all', 'filter-movies', 'filter-series', 'filter-live'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  const idMap = { '': 'filter-all', 'movies': 'filter-movies', 'series': 'filter-series', 'live': 'filter-live' };
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


function showView(active) {
  const adminEl = document.getElementById('admin-view');
  const homeEl = document.getElementById('home-view');
  if (active === 'admin-view') {
    if (adminEl) adminEl.style.display = 'block';
    if (homeEl) homeEl.style.display = 'none';
  } else {
    if (adminEl) adminEl.style.display = 'none';
    if (homeEl) homeEl.style.display = 'block';
  }
}

function handleRouting() {
  const hash = window.location.hash.replace('#', '');
  if (hash === 'admin') {
    showView('admin-view');
    renderInventory();
  } else {
    showView('home-view');
    const hashVal = hash || '';

    // Top filters
    const idMap = { '': 'filter-all', 'movies': 'filter-movies', 'series': 'filter-series', 'live': 'filter-live' };
    ['filter-all', 'filter-movies', 'filter-series', 'filter-live'].forEach(id => document.getElementById(id)?.classList.remove('active'));
    document.getElementById(idMap[hashVal])?.classList.add('active');

    // Bottom nav (Mobile)
    const btmMap = { '': 'btn-nav-home', 'movies': 'btn-nav-movies', 'series': 'btn-nav-series', 'live': 'btn-nav-live' };
    ['btn-nav-home', 'btn-nav-movies', 'btn-nav-series', 'btn-nav-live'].forEach(id => document.getElementById(id)?.classList.remove('active'));
    document.getElementById(btmMap[hashVal])?.classList.add('active');

    const genreBar = document.getElementById('genre-bar');
    if (genreBar) genreBar.style.display = (hashVal === 'movies' || hashVal === 'series') ? 'flex' : 'none';
    initApp(hashVal, '');
  }
}

function renderChannels(container) {
  if (!container) return;
  const liveChannels = [...movieDatabase.trending]
    .filter(c => c.type === 'live' || (c.embed && !c.tmdbId))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  if (liveChannels.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);padding:50px;text-align:center;width:100%;">Buscando señal... 📡</p>';
    return;
  }

  container.innerHTML = liveChannels.map(ch => `
    <div class="tv-card" onclick="window.handleChannelClick('${ch.embed}')">
      <img src="${ch.img}" alt="${ch.title}" style="width:100%;height:100%;object-fit:cover;" onerror="this.src='https://via.placeholder.com/600x400/111/FF7A00?text=SIN+SEÑAL'">
      <div class="tv-info">
        <h3 style="font-size:0.95rem;">${ch.title}</h3>
        <p style="font-size:0.7rem;color:var(--primary);">&#x25cf; EN VIVO</p>
      </div>
    </div>
  `).join('');
}

window.handleChannelClick = (url) => {
  const modal = document.getElementById('player-modal');
  const iframe = document.getElementById('player-iframe');
  modal.style.display = 'flex';
  document.getElementById('server-switcher').style.display = 'none';
  document.getElementById('ad-overlay').style.display = 'none';
  iframe.src = url;
};

// Global Search (Filter)
function handleGlobalSearch(query) {
  const allMovies = [...movieDatabase.trending];
  const filtered = allMovies.filter(m => m.title.toLowerCase().includes(query.toLowerCase()));

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
function _renderCardsInto(container, data) {
  if (!data || data.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);padding:30px;">La selva está vacía aquí... 🌿</p>';
    return;
  }

  const CHUNK_SIZE = 12;
  let currentIndex = 0;
  container.innerHTML = '';

  function renderNextChunk() {
    const chunk = data.slice(currentIndex, currentIndex + CHUNK_SIZE);
    const html = chunk.map(item => `
        <div class="movie-card" data-id="${item.id}" onclick="window.handleCardClick('${item.id}')">
          ${item.status === 'maintenance' ? '<div class="badge-maintenance">Mantenimiento</div>' : ''}
          <img src="${item.img}" alt="${item.title}" class="card-img" loading="lazy"
            onerror="this.parentElement.style.border='2px solid #E74C3C'; this.src='https://via.placeholder.com/500x750/1a1a1a/E74C3C?text=Sin+Imagen';">
          <div class="card-info">
            <h3 class="card-title">${item.title}</h3>
            <p class="card-meta">${item.year || 'Estreno'} • ★ ${item.rating || '4.8'}</p>
          </div>
        </div>
      `).join('');

    container.insertAdjacentHTML('beforeend', html);
    currentIndex += CHUNK_SIZE;

    if (currentIndex < data.length) {
      requestAnimationFrame(renderNextChunk);
    }
  }

  renderNextChunk();
}

function renderRow(title, data, seeAllHash = '') {
  const container = document.getElementById('main-content');
  if (!data) return;
  const section = document.createElement('section');
  section.className = 'category-row';
  section.innerHTML = `
    <div class="row-header">
      <h2 class="row-title">${title}</h2>
      ${seeAllHash ? `<a href="#${seeAllHash}" class="see-all-btn">Ver todos →</a>` : ''}
    </div>
    <div class="row-container">
      <button class="row-arrow row-arrow-left">◀</button>
      <div class="movie-list"></div>
      <button class="row-arrow row-arrow-right">▶</button>
    </div>
  `;
  container.appendChild(section);

  const list = section.querySelector('.movie-list');
  _renderCardsInto(list, data);

  const leftBtn = section.querySelector('.row-arrow-left');
  const rightBtn = section.querySelector('.row-arrow-right');

  leftBtn.onclick = () => list.scrollBy({ left: -list.offsetWidth * 0.8, behavior: 'smooth' });
  rightBtn.onclick = () => list.scrollBy({ left: list.offsetWidth * 0.8, behavior: 'smooth' });

  // Wire see-all link
  const seeAllLink = section.querySelector('.see-all-btn');
  if (seeAllLink && seeAllHash) {
    seeAllLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.hash = seeAllHash;
    });
  }
}

// Galería de página completa con Chunking (v4.4)
function renderGallery(title, groups) {
  const container = document.getElementById('main-content');
  container.innerHTML = '';

  groups.forEach(({ label, items }) => {
    if (!items || items.length === 0) return;
    const section = document.createElement('section');
    section.className = 'category-row';
    section.innerHTML = `
      <div class="row-header" style="margin-bottom:20px;">
        <h2 class="row-title">${label} <span style="font-size:0.85rem;color:var(--text-muted);font-weight:400;">(${items.length})</span></h2>
      </div>
      <div class="gallery-grid"></div>
    `;
    container.appendChild(section);

    const grid = section.querySelector('.gallery-grid');
    const CHUNK_SIZE = 12;
    let currentIndex = 0;

    function renderNextChunk() {
      const chunk = items.slice(currentIndex, currentIndex + CHUNK_SIZE);
      const html = chunk.map(item => `
        <div class="movie-card gallery-card" data-id="${item.id}" onclick="window.handleCardClick('${item.id}')">
          ${item.status === 'maintenance' ? '<div class="badge-maintenance">Mantenimiento</div>' : ''}
          <img src="${item.img}" alt="${item.title}" class="card-img" loading="lazy"
            onerror="this.parentElement.style.border='2px solid #E74C3C'; this.src='https://via.placeholder.com/500x750/1a1a1a/E74C3C?text=Sin+Imagen';">
          <div class="card-info">
            <h3 class="card-title">${item.title}</h3>
            <p class="card-meta">${item.year || 'Estreno'} • ★ ${item.rating || '4.8'}</p>
          </div>
        </div>
      `).join('');

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
  _allInventoryItems = [...movieDatabase.trending].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  _inventoryPage = 1;
  _updateDetailedStats(_allInventoryItems);
  _renderInventoryRows(_allInventoryItems);
}

function _updateDetailedStats(items) {
  const m = items.filter(i => i.type === 'movie' || !i.type).length;
  const s = items.filter(i => i.type === 'series' || i.type === 'tv' || i.type === 'anime').length;
  const l = items.filter(i => i.type === 'live').length;
  const b = items.filter(i => window._brokenIds.has(i.id)).length;

  document.getElementById('count-movies').innerText = m;
  document.getElementById('count-series').innerText = s;
  document.getElementById('count-live').innerText = l;
  document.getElementById('count-broken').innerText = b;
}

window.loadMoreInventory = () => {
  _inventoryPage++;
  _renderInventoryRows(_allInventoryItems);
};

function _renderInventoryRows(items) {
  const grid = document.getElementById('inventory-grid');
  const status = document.getElementById('inventory-status');
  const loadMore = document.getElementById('load-more-container');

  const typeIcons = { movie: '🎬', series: '🏆', live: '🔴', anime: '⛩️' };
  const langIcons = { 'es-MX': '🇲🇽', 'es-PE': '🇵🇪', 'es-ES': '🇪🇸', 'en-US': '🇺🇸' };

  if (!grid) return;

  if (items.length === 0) {
    grid.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:50px; color:var(--text-muted); background:rgba(255,255,255,0.02); border-radius:15px; border:1px dashed #333;">No se encontraron tesoros con ese filtro... 🍃🕵️‍♂️</div>';
    if (loadMore) loadMore.style.display = 'none';
    if (status) status.innerText = "0 títulos encontrados.";
    return;
  }

  const end = _inventoryPage * _inventoryPerPage;
  const visibleItems = items.slice(0, end);

  if (status) status.innerText = `Mostrando ${visibleItems.length} de ${items.length} títulos totales.`;
  if (loadMore) loadMore.style.display = end < items.length ? 'block' : 'none';

  grid.innerHTML = visibleItems.map(m => {
    const isBroken = window._brokenIds.has(m.id);
    const icon = typeIcons[m.type] || '🎬';
    const lang = langIcons[m.lang] || '🇲🇽';

    return `
      <div class="admin-inv-card" data-id="${m.id}" style="background: rgba(255,255,255,0.03); border: 1px solid ${isBroken ? '#E74C3C' : 'var(--glass-border)'}; border-radius: 12px; padding: 10px; position: relative; transition: transform 0.2s ease; border: 1px solid rgba(255,255,255,0.05);">
        <input type="checkbox" class="selva-check" data-id="${m.id}" onchange="window.updateSelectedCount()" style="position: absolute; top: 10px; right: 10px; z-index: 5; width: 16px; height: 16px; cursor:pointer; accent-color: var(--primary);">
        
        <div style="position: relative; aspect-ratio: 2/3; border-radius: 8px; overflow: hidden; margin-bottom: 8px; background: #111; box-shadow: 0 4px 10px rgba(0,0,0,0.3);">
            <img src="${m.img}" 
                 style="width: 100%; height: 100%; object-fit: cover; opacity: ${isBroken ? '0.4' : '1'};" 
                 onerror="this.src='https://via.placeholder.com/150x225?text=ERROR'; window.markAsBroken('${m.id}')">
            <div style="position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(transparent, rgba(0,0,0,0.9)); padding: 6px; font-size: 0.65rem; display: flex; justify-content: space-between; align-items: center;">
                <span title="${m.type}">${icon}</span>
                <span title="${m.lang}">${lang}</span>
            </div>
            ${isBroken ? '<div style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); color:#E74C3C; font-weight:bold; font-size:0.6rem; text-shadow:0 0 5px black;">IMAGEN ROTA</div>' : ''}
        </div>

        <p style="font-size: 0.7rem; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #eee; margin-bottom: 8px; padding: 0 2px;">${m.title}</p>
        
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 5px;">
            <div style="display:flex; align-items:center; gap:4px;">
                <div style="width: 7px; height: 7px; border-radius: 50%; background: ${isBroken ? '#E74C3C' : (m.status === 'healthy' ? '#2ECC71' : '#F1C40F')}; box-shadow: 0 0 5px ${isBroken ? '#E74C3C' : (m.status === 'healthy' ? '#2ECC71' : '#F1C40F')};"></div>
                <span style="font-size: 0.6rem; color: var(--text-muted);">${isBroken ? 'Error' : (m.status === 'healthy' ? 'OK' : 'Mant.')}</span>
            </div>
            <div style="display: flex; gap: 6px;">
                <button onclick="window.editMovie('${m.id}')" title="Editar" style="background: rgba(255,255,255,0.08); border: none; color: white; width:22px; height:22px; display:flex; align-items:center; justify-content:center; border-radius: 5px; cursor: pointer; font-size: 0.65rem; border:1px solid rgba(255,255,255,0.1);">✏️</button>
                <button onclick="window.deleteMovie('${m.id}')" title="Borrar" style="background: rgba(231,76,60,0.1); border: 1px solid rgba(231,76,60,0.2); color: #E74C3C; width:22px; height:22px; display:flex; align-items:center; justify-content:center; border-radius: 5px; cursor: pointer; font-size: 0.65rem;">🗑️</button>
            </div>
        </div>
      </div>
    `;
  }).join('');
}

window.updateSelectedCount = () => {
  const selected = document.querySelectorAll('.selva-check:checked').length;
  const btn = document.getElementById('btn-delete-selected');
  const countSpan = document.getElementById('selected-count');
  if (btn && countSpan) {
    countSpan.innerText = selected;
    btn.style.display = selected > 0 ? 'inline-block' : 'none';
    btn.style.boxShadow = '0 0 15px rgba(230, 126, 34, 0.4)';
  }
};

window.switchAdminTab = (tab) => {
  const invTab = document.getElementById('admin-inventory-tab');
  const metTab = document.getElementById('admin-metrics-tab');
  const btnInv = document.getElementById('btn-admin-inventory');
  const btnMet = document.getElementById('btn-admin-metrics');

  if (tab === 'inventory') {
    invTab.style.display = 'block';
    metTab.style.display = 'none';
    btnInv.classList.add('active');
    btnMet.classList.remove('active');
    renderInventory();
  } else {
    invTab.style.display = 'none';
    metTab.style.display = 'block';
    btnInv.classList.remove('active');
    btnMet.classList.add('active');
    window.loadMetrics();
  }
};

window.loadMetrics = async () => {
  const log = document.getElementById('metrics-recent-log');
  const popularList = document.getElementById('metrics-popular-list');
  const deviceChart = document.getElementById('metrics-device-chart');
  const totalVisits = document.getElementById('stat-total-visits');
  const totalPlays = document.getElementById('stat-total-plays');

  if (log) log.innerText = "Sincronizando con la selva... 📡";

  try {
    const q = query(collection(db, "user_activity"), orderBy("timestamp", "desc"), limit(50));
    const snap = await getDocs(q);

    const data = [];
    snap.forEach(doc => data.push(doc.data()));

    if (data.length === 0) {
      log.innerText = "Sin actividad reciente. 🌴";
      return;
    }

    // Stats basicos
    totalVisits.innerText = data.length;
    const plays = data.filter(d => d.action === 'play_start' || d.action === 'watch_attempt').length;
    totalPlays.innerText = plays;

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
                <td>${title}</td>
                <td style="color: #F1C40F;">Reproducido</td>
                <td style="font-weight: bold; color:white;">${info.count}</td>
                <td style="font-size: 0.7rem; color: var(--text-muted);">${new Date(info.last).toLocaleDateString()}</td>
            </tr>
        `).join('') || '<tr><td colspan="4" style="text-align:center; padding: 20px;">No hay reproducciones recientes.</td></tr>';

    // Dispositivos (Chart simple)
    const platforms = {};
    data.forEach(d => { platforms[d.platform] = (platforms[d.platform] || 0) + 1; });
    const max = Math.max(...Object.values(platforms));

    deviceChart.innerHTML = Object.entries(platforms).map(([plat, count]) => {
      const width = (count / max) * 100;
      return `
                <div style="text-align: left; font-size: 0.7rem;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                        <span>${plat}</span>
                        <span>${count}</span>
                    </div>
                    <div style="height: 6px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden;">
                        <div style="width: ${width}%; height: 100%; background: #3498DB;"></div>
                    </div>
                </div>
            `;
    }).join('');

  } catch (err) {
    console.error("Error loading metrics:", err);
    if (log) {
      log.innerHTML = `
            <div style="text-align:center; padding: 20px;">
                <p style="color: #E74C3C; font-weight:bold;">¡Fallo la conexión con las métricas! 🐒</p>
                <p style="font-size:0.7rem; color:var(--text-muted); margin-top:5px;">Error: ${err.message}</p>
                <p style="font-size:0.6rem; color:#444; margin-top:10px;">Nota: Si es la primera vez, Firebase puede tardar 1-2 minutos en generar el índice de búsqueda.</p>
                <button class="btn btn-secondary" style="margin-top:15px; padding:6px 15px; font-size:0.7rem;" onclick="window.loadMetrics()">Reintentar 🔄</button>
            </div>
        `;
    }
  }
};

window.markAsBroken = (id) => {
  if (!window._brokenIds.has(id)) {
    window._brokenIds.add(id);
  }
};

window.filterInventoryByCategory = () => {
  const type = document.getElementById('inventory-type-filter').value;
  const category = document.getElementById('inventory-filter').value;
  const langFilter = document.getElementById('inventory-lang-filter')?.value || 'all';
  const genreFilter = document.getElementById('inventory-genre-filter')?.value || 'all';
  const searchInput = document.getElementById('inventory-search');
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
  const selected = Array.from(document.querySelectorAll('.selva-check:checked')).map(cb => cb.dataset.id);
  if (selected.length === 0) { alert("¡No has seleccionado ninguna joya para pelar! 🐒"); return; }

  const confirmed = confirm(`¿Estás seguro de que quieres eliminar ${selected.length} elementos para siempre? 🔥`);
  if (!confirmed) return;

  const overlay = document.getElementById('delete-progress-overlay');
  const bar = document.getElementById('progress-bar-fill');
  const text = document.getElementById('progress-percent');

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
  alert(`¡Limpieza completada! ${count} elementos eliminados. 🧹🌴`);
  if (bar) bar.style.width = "0%";
};

window.selectAllVisible = (checked) => {
  document.querySelectorAll('.selva-check').forEach(c => c.checked = checked);
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
  const date = m.release_date || m.first_air_date || "2024";
  const type = m.media_type === 'tv' ? 'series' : 'movie';

  document.getElementById('m-title').value = title;
  document.getElementById('m-img').value = m.poster_path ? (TMDB_IMG_URL + m.poster_path) : "";
  document.getElementById('m-tmdb-id').value = m.id;
  document.getElementById('m-type').value = type;
  document.getElementById('m-year').value = date.split('-')[0];
  document.getElementById('m-rating').value = m.vote_average || '8.0';
  document.getElementById('m-embed').value = "";

  // Operación IMDB-Latino: Obtener ID real
  try {
    const extResp = await fetch(`${TMDB_URL}/${type === 'series' ? 'tv' : 'movie'}/${m.id}/external_ids?api_key=${TMDB_API_KEY}`);
    const extData = await extResp.json();
    document.getElementById('m-imdb-id').value = extData.imdb_id || "";
  } catch (e) {
    console.warn("No se pudo obtener IMDB ID en selección manual.");
    document.getElementById('m-imdb-id').value = "";
  }

  const preview = document.getElementById('m-img-preview');
  if (preview) {
    preview.src = m.poster_path ? (TMDB_IMG_URL + m.poster_path) : 'https://via.placeholder.com/150x220?text=Previsualización';
  }

  alert(`Cosechada info de: ${title} 🥥🍹`);
};

// --- DATA & ADS SYSTEM ---
async function collectUserData(action, details = {}) {
  try {
    const userData = {
      action,
      details,
      timestamp: Date.now(),
      platform: navigator.platform,
      userAgent: navigator.userAgent
    };
    await addDoc(collection(db, "user_activity"), userData);
  } catch (e) { console.error("Error tracking:", e); }
}

// Player Logic & Multi-Server
function startPlayer(movie) {
  collectUserData("play_start", { title: movie.title, type: movie.type });
  SelvaStream.open(movie);
}

function startWarningOverlay(movie) {
  const adOverlay = document.getElementById('ad-overlay');
  const skipBtn = document.getElementById('skip-ad-btn');

  // Lógica: Una vez por película/serie al día
  const today = new Date().toISOString().split('T')[0];
  const storageKey = `warned_${movie.id}_${today}`;

  if (localStorage.getItem(storageKey)) {
    startPlayer(movie);
    return;
  }

  if (adOverlay) adOverlay.style.display = 'flex';

  const isAdmin = document.getElementById('admin-view')?.style.display === 'block';
  let timeLeft = 5;

  const timer = setInterval(() => {
    timeLeft--;
    if (skipBtn && !isAdmin) skipBtn.innerText = `Cerrando en ${timeLeft}...`;

    if (timeLeft <= 0) {
      finish();
    }
  }, 1000);

  function finish() {
    if (timer) clearInterval(timer);
    localStorage.setItem(storageKey, 'true');
    if (adOverlay) adOverlay.style.display = 'none';
    if (skipBtn) skipBtn.onclick = null; // Clear handler
    startPlayer(movie);
  }

  if (skipBtn) {
    if (isAdmin) {
      skipBtn.innerText = "⚡ Saltar y Comprobar (Modo Admin)";
      skipBtn.disabled = false;
      skipBtn.style.cursor = "pointer";
      skipBtn.style.opacity = "1";
      skipBtn.onclick = finish;
    } else {
      skipBtn.innerText = `Cerrando en ${timeLeft}...`;
      skipBtn.disabled = true;
      skipBtn.style.cursor = "not-allowed";
      skipBtn.style.opacity = "0.7";
      skipBtn.onclick = null;
    }
  }
}

window.closeWarningOverlay = () => {
  const overlay = document.getElementById('ad-overlay');
  if (overlay) overlay.style.display = 'none';
};

window.openPlayer = async (movieId) => {
  const allMovies = [...movieDatabase.trending];
  const movie = allMovies.find(m => m.id === movieId);
  if (!movie) return;

  collectUserData("watch_attempt", { title: movie.title, id: movie.id });

  currentPlayerMovie = movie;

  // Iniciar la secuencia de seguridad y comerciales antes del Play
  startWarningOverlay(movie);
}

// La lógica de servidores y episodios ahora vive en SelvaStream Engine 🍿

// Exported Actions
window.handleCardClick = (id) => openPlayer(id);

window.deleteMovie = async (id) => {
  if (confirm("¿Seguro que quieres eliminar esta joya de la selva? 🥥?")) {
    try {
      await deleteDoc(doc(db, "movies", id));
    } catch (e) {
      console.error("Error eliminando pelicula: ", e);
    }
  }
};


window.editMovie = (id) => {
  const movie = movieDatabase.trending.find(m => m.id === id);
  if (!movie) return;

  // Llenar formulario
  document.getElementById('m-db-id').value = movie.id;
  document.getElementById('m-title').value = movie.title;
  document.getElementById('m-img').value = movie.img;
  document.getElementById('m-tmdb-id').value = movie.tmdbId || "";
  document.getElementById('m-imdb-id').value = movie.imdbId || ""; // Operación IMDB-Latino
  document.getElementById('m-embed').value = movie.embed || "";
  document.getElementById('m-year').value = (movie.year || '2024').toString().split('-')[0];
  document.getElementById('m-rating').value = movie.rating || '4.8';
  document.getElementById('m-type').value = movie.type || 'movie';

  // Actualizar preview
  document.getElementById('m-img-preview').src = movie.img;

  // Cambiar botones
  document.getElementById('submit-btn').innerText = "¡Actualizar en la Selva! 🔄";
  document.getElementById('cancel-edit').style.display = "block";

  // Sugerir imágenes automáticamente al editar
  if (movie.title) searchTMDB(movie.title, true);

  // Hacer scroll al formulario
  document.getElementById('movie-form').scrollIntoView({ behavior: 'smooth' });
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
    status: 'healthy',
    createdAt: Date.now()
  };
  await addDoc(moviesCol, data);
  alert("¡Sembrado con éxito! 🌴");
};

window.quickSeedManual = async (ch, type) => {
  const exists = movieDatabase.trending.find(m => m.title == ch.name);
  if (exists) { alert("Este canal ya existe."); return; }
  const data = { ...ch, title: ch.name, type, status: 'healthy', createdAt: Date.now() };
  delete data.name;
  await addDoc(moviesCol, data);
  alert("¡Canal Agregado! 📺");
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
    alert('Error interno: recarga la página e inténtalo de nuevo.');
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

    const mData = {
      ...s,
      imdbId: imdbId,
      embed: "",
      status: 'healthy',
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

  if (overlay) overlay.style.display = 'none';
  alert(`¡Siembra masiva completada! ${count} elementos añadidos. 🌴🍿`);
  document.getElementById('discover-container').style.display = 'none';
};


function updateHeroCarousel() {
  if (!heroPool || heroPool.length === 0) return;
  const section = document.getElementById('hero-section');
  if (!section) return;

  section.style.display = 'flex';
  section.style.gap = '20px';
  section.style.overflowX = 'auto';
  section.style.padding = '20px 5%';
  section.style.marginTop = '100px';
  section.style.marginBottom = '20px';
  section.style.scrollbarWidth = 'none';

  // Mostrar 3 tarjetas a partir del indice actual (circular)
  const itemsToShow = [];
  for (let i = 0; i < 3; i++) {
    const item = heroPool[(currentHeroIndex + i) % heroPool.length];
    if (item) itemsToShow.push(item);
  }

  section.innerHTML = itemsToShow.map(item => `
    <div class="hero-card" onclick="window.openPlayer('${item.id}')" style="flex: 1; min-width: 300px; height: 300px; background-image: linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0.1)), url('${item.img}'); background-size: cover; background-position: center 20%; border-radius: 16px; position: relative; cursor: pointer; border: 1px solid var(--glass-border); transition: transform 0.3s ease; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
      <div style="position: absolute; bottom: 20px; left: 20px; right: 20px;">
        <h2 style="color: white; font-size: 1.6rem; margin-bottom: 5px; text-shadow: 0 2px 5px rgba(0,0,0,0.8); font-family: 'Outfit', sans-serif; font-weight: 800;">${item.title}</h2>
        <p style="color: var(--primary); font-size: 0.9rem; font-weight: bold; text-shadow: 0 1px 3px rgba(0,0,0,0.8);">⭐ ${item.rating || '4.8'} • ${item.year || '2024'}</p>
        <button class="btn btn-primary" style="margin-top: 10px; padding: 8px 20px; font-size: 0.8rem;">▶ Reproducir</button>
      </div>
    </div>
  `).join('');
}

function startHeroAutoRotation() {
  if (heroTimer) clearInterval(heroTimer);
  heroTimer = setInterval(() => {
    if (heroPool.length > 3) {
      currentHeroIndex = (currentHeroIndex + 1) % heroPool.length;
      const section = document.getElementById('hero-section');
      if (section) {
        section.style.opacity = '0.5';
        setTimeout(() => {
          updateHeroCarousel();
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

  // Actividad: Vista de página
  collectUserData("page_view", { page: filterType || 'home' });

  // ORDEN INTELIGENTE: Salud -> Fecha de Creación
  let allContent = [...movieDatabase.trending].sort((a, b) => {
    const healthA = window._brokenIds.has(a.id) ? 0 : 1;
    const healthB = window._brokenIds.has(b.id) ? 0 : 1;
    if (healthA !== healthB) return healthB - healthA;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  // Apply genre filter if set (genre stored as array or single string in item.genres)
  if (genreId) {
    allContent = allContent.filter(c => {
      const g = c.genres || c.genre_ids || [];
      return Array.isArray(g) ? g.map(String).includes(String(genreId)) : String(g) === String(genreId);
    });
  }

  // Pool de Recomendados (Hero Carousel - 3 items)
  heroPool = allContent.filter(c => !window._brokenIds.has(c.id));

  if (filterType === 'series') heroPool = heroPool.filter(c => c.type === 'series' || c.type === 'tv' || c.type === 'anime');
  else if (filterType === 'live') heroPool = heroPool.filter(c => c.type === 'live');
  else if (filterType === 'movies') heroPool = heroPool.filter(c => c.type === 'movie' || !c.type);
  else heroPool = heroPool.slice(0, 10);

  heroPool = heroPool.slice(0, 3);

  // Hero Carousel Priority (v4.4)
  if (heroPool.length > 0) {
    document.getElementById('hero-section').style.display = 'flex';
    updateHeroCarousel();
    // La rotación iniciará al final para no estorbar el pintado inicial
  } else {
    document.getElementById('hero-section').style.display = 'none';
  }

  // Rows / Gallery based on filter
  if (filterType === 'movies') {
    const movies = allContent.filter(c => c.type === 'movie' || !c.type);
    if (movies.length > 0) {
      renderGallery('🎬 Películas', [{ label: `🎬 Películas${genreId ? ' · filtradas' : ''}`, items: movies }]);
    } else {
      if (container) container.innerHTML = '<p style="padding:80px;text-align:center;color:var(--text-muted);">No hay películas con ese filtro 🌿</p>';
    }

  } else if (filterType === 'series') {
    const series = allContent.filter(c => c.type === 'series' || c.type === 'tv');
    const anime = allContent.filter(c => c.type === 'anime');
    renderGallery('🏆 Series & Anime', [
      { label: `🏆 Series${genreId ? ' · filtradas' : ''}`, items: series },
      { label: `⛩️ Anime`, items: anime }
    ]);

  } else if (filterType === 'live') {
    if (container) container.innerHTML = '';
    renderRow('Canales en Vivo 🔴', []);
    const sec = container.lastElementChild;
    const list = sec.querySelector('.movie-list');
    list.id = 'main-channels';
    renderChannels(list);

  } else {
    // HOME: filas de muestra + 'Ver todos'
    if (container) container.innerHTML = ''; // Los skeletons cumplieron su misión
    const movies = allContent.filter(c => c.type === 'movie' || !c.type).slice(0, 12);
    const series = allContent.filter(c => c.type === 'series' || c.type === 'tv').slice(0, 12);
    const anime = allContent.filter(c => c.type === 'anime').slice(0, 12);
    const releases = allContent.filter(c => c.type !== 'live').slice(0, 12);
    const liveChannels = allContent.filter(c => c.type === 'live');

    if (releases.length > 0) renderRow('✨ Lo más nuevo', releases, 'movies');
    if (movies.length > 0) renderRow('🎬 Películas', movies, 'movies');
    if (series.length > 0) renderRow('🏆 Series', series, 'series');
    if (anime.length > 0) renderRow('⛩️ Anime', anime, 'series');
    if (liveChannels.length > 0) {
      renderRow('🔴 Canales en Vivo', [], 'live');
      const sec = container.lastElementChild;
      const list = sec.querySelector('.movie-list');
      list.id = 'main-channels';
      renderChannels(list);
    }
  }

  // 🚀 Encendido del motor de rotación (al final para liberar el hilo principal)
  if (heroPool.length > 3) {
    startHeroAutoRotation();
  }
}

window.renderChannels = (container) => {
  const channels = movieDatabase.trending.filter(m => m.type === 'live');
  if (channels.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; padding: 40px; text-align: center; background: rgba(255,255,255,0.02); border-radius: 20px; border: 1px dashed #333;">
        <p style="color:var(--text-muted); margin-bottom:15px;">La selva está en silencio... No hay canales aún.</p>
        <button onclick="window.location.hash='admin'; window.switchAdminTab('inventory');" class="btn btn-primary" style="font-size:0.8rem;">🚜 Sembrar Canales</button>
      </div>
    `;
    return;
  }

  container.innerHTML = channels.map(ch => `
    <div class="movie-card live-card" onclick="window.handleCardClick('${ch.id}')" style="min-width: 200px; height: 120px;">
       <div class="card-img-wrapper" style="height: 100%;">
          <img src="${ch.img}" alt="${ch.title}" loading="lazy" style="object-fit: contain; background: #fff; padding: 10px;">
          <div class="card-overlay">
            <div class="play-btn-circle"><span>▶</span></div>
          </div>
          <div class="live-badge">EN VIVO</div>
       </div>
       <div class="card-info" style="padding: 8px;">
          <h3 class="card-title" style="font-size: 0.8rem;">${ch.title}</h3>
       </div>
    </div>
  `).join('');
};

window.handleCardClick = (id) => {
  const movie = movieDatabase.trending.find(m => m.id === id);
  if (movie) openPlayer(id);
};

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
  window.addEventListener('hashchange', handleRouting);

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

  // Movie Form Submit (Add or Update)
  document.getElementById('movie-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dbId = document.getElementById('m-db-id').value;

    const title = document.getElementById('m-title').value.trim();
    const img = document.getElementById('m-img').value.trim();

    if (!title) { alert('¡Falta el título! 🌴'); return; }
    if (!img) { alert('¡Falta la imagen del póster! Busca una en TMDB o pega la URL. 🖼️'); return; }

    const movieData = {
      title,
      img,
      tmdbId: document.getElementById('m-tmdb-id').value.trim(),
      imdbId: document.getElementById('m-imdb-id').value.trim(), // Operación IMDB-Latino
      embed: document.getElementById('m-embed').value.trim(),
      year: document.getElementById('m-year').value || new Date().getFullYear().toString(),
      rating: document.getElementById('m-rating').value || '7.0',
      type: document.getElementById('m-type').value || 'movie',
      status: 'healthy',
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
      document.getElementById('m-img-preview').src = 'https://via.placeholder.com/150x220?text=Previsualización';
      document.getElementById('cancel-edit').style.display = "none";
      document.getElementById('tmdb-results').innerHTML = '';

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
    document.getElementById('m-img-preview').src = 'https://via.placeholder.com/150x220?text=Previsualización';
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

  // --- PWA ASYMMETRIC LOGIC (ZERO SPAM) ---
  const installBtn = document.getElementById('pwa-install-btn');
  const smartBanner = document.getElementById('pwa-smart-banner');
  const closeBanner = document.getElementById('pwa-banner-close');
  const installBannerBtn = document.getElementById('pwa-banner-install-btn');
  const iosGuide = document.getElementById('ios-install-guide');
  const closeIosGuide = document.getElementById('ios-guide-close');

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  // 1. Detect device
  const isIos = /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream;

  // 2. Courtship logic (Increment visits)
  let visitCount = parseInt(localStorage.getItem('pwa_visit_count') || '0') + 1;
  localStorage.setItem('pwa_visit_count', visitCount);
  const lastVisit = parseInt(localStorage.getItem('pwa_last_visit') || '0');
  const now = Date.now();
  const timeSinceLastVisit = now - lastVisit;
  localStorage.setItem('pwa_last_visit', now);

  const shouldShowBanner = () => {
    if (isStandalone) return false;
    if (localStorage.getItem('pwa_installed')) return false;

    // Visita 1: Despues de 5 segundos
    if (visitCount === 1) return true;

    // Visita 2: Scroll al 50% (handled via scroll listener)
    if (visitCount === 2) return false;

    // Visita 3: Tras 20 segundos (handled via timeout)
    if (visitCount === 3) return false;

    // Visita 4+: Una si, una no, o tras 48h
    if (visitCount >= 4) {
      const wait48h = timeSinceLastVisit > (48 * 60 * 60 * 1000);
      return (visitCount % 2 === 0) || wait48h;
    }
    return false;
  };

  const showInstaller = () => {
    if (isStandalone) return;
    if (isIos) {
      if (iosGuide) iosGuide.style.display = 'flex';
    } else if (deferredPrompt) {
      if (smartBanner) smartBanner.style.display = 'block';
    }
  };

  // Listeners
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) {
      installBtn.style.display = 'flex';
      installBtn.classList.add('pulse');
    }

    // Trigger courtship banners
    if (shouldShowBanner()) {
      setTimeout(showInstaller, 5000);
    }
  });

  // Visita 2: Scroll 50% logic
  window.addEventListener('scroll', () => {
    if (visitCount === 2 && !localStorage.getItem('pwa_banner_seen_v2')) {
      const scrollPercent = (window.scrollY + window.innerHeight) / document.documentElement.scrollHeight;
      if (scrollPercent > 0.5) {
        localStorage.setItem('pwa_banner_seen_v2', 'true');
        showInstaller();
      }
    }
  });

  // Visita 3: Timeout 20s
  if (visitCount === 3) {
    setTimeout(showInstaller, 20000);
  }

  // Action: Install Button Click
  if (installBtn) {
    installBtn.addEventListener('click', showInstaller);
  }

  if (installBannerBtn) {
    installBannerBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          deferredPrompt = null;
          if (smartBanner) smartBanner.style.display = 'none';
          if (installBtn) installBtn.style.display = 'none';
          localStorage.setItem('pwa_installed', 'true');
        }
      }
    });
  }

  if (closeBanner) closeBanner.onclick = () => smartBanner.style.display = 'none';
  if (closeIosGuide) closeIosGuide.onclick = () => iosGuide.style.display = 'none';

  window.addEventListener('appinstalled', () => {
    localStorage.setItem('pwa_installed', 'true');
    if (installBtn) installBtn.style.display = 'none';
    if (smartBanner) smartBanner.style.display = 'none';
  });
});
