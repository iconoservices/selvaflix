import './style.css'
import { initializeApp } from "firebase/app";
import { getFirestore, collection, onSnapshot, addDoc, deleteDoc, doc, updateDoc } from "firebase/firestore";
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

// --- TMDB API Config ---
const TMDB_API_KEY = '15d2ea6d0dc1d476efbca3eba2b9bbfb'; // Clave publica para demos
const TMDB_URL = 'https://api.themoviedb.org/3';
const TMDB_IMG_URL = 'https://image.tmdb.org/t/p/w500';

let movieDatabase = { trending: [] };
let currentPlayerMovie = null;

// Firebase Listener (Real-time sync)
onSnapshot(moviesCol, (snapshot) => {
  movieDatabase.trending = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  const hash = window.location.hash.replace('#', '');
  if (hash === 'admin') renderInventory();
  else if (hash === 'live') renderChannels();
  else if (hash === 'movies') renderMoviesView();
  else if (hash === 'series') renderSeriesView();
  else initApp();
});


// Routing Logic
function showView(active) {
  ['home-view', 'movies-view', 'series-view', 'tv-view', 'admin-view'].forEach(v => {
    const el = document.getElementById(v);
    if (el) el.style.display = (v === active) ? 'block' : 'none';
  });
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
  const navMap = { 'home-view': 'nav-home', 'movies-view': 'nav-movies', 'series-view': 'nav-series', 'tv-view': 'nav-live' };
  if (navMap[active]) document.getElementById(navMap[active])?.classList.add('active');
}

function handleRouting() {
  const hash = window.location.hash.replace('#', '');
  if (hash === 'admin') { showView('admin-view'); renderInventory(); }
  else if (hash === 'live') { showView('tv-view'); renderChannels(); }
  else if (hash === 'movies') { showView('movies-view'); renderMoviesView(); }
  else if (hash === 'series') { showView('series-view'); renderSeriesView(); }
  else { showView('home-view'); initApp(); }
}

function renderMoviesView() {
  const container = document.getElementById('movies-content');
  container.innerHTML = '';
  const movies = [...movieDatabase.trending]
    .filter(c => c.type === 'movie' || !c.type)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  if (movies.length === 0) {
    container.innerHTML = '<p style="padding:50px;text-align:center;color:var(--text-muted);">La cartelera está vacía... 🎬</p>';
    return;
  }

  const section = document.createElement('section');
  section.className = 'category-row';
  section.innerHTML = `<div class="row-header"><h2 class="row-title">Todas las Películas 🎬</h2></div>`;
  container.appendChild(section);
  _renderCardsInto(section, movies);
}

function renderSeriesView() {
  const container = document.getElementById('series-content');
  container.innerHTML = '';
  const series = [...movieDatabase.trending]
    .filter(c => c.type === 'series' || c.type === 'tv' || c.type === 'anime')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  if (series.length === 0) {
    container.innerHTML = '<p style="padding:50px;text-align:center;color:var(--text-muted);">No hay series por aquí... 🏆</p>';
    return;
  }

  const section = document.createElement('section');
  section.className = 'category-row';
  section.innerHTML = `<div class="row-header"><h2 class="row-title">Series y Animes de la Jungla 🏆⛩️</h2></div>`;
  container.appendChild(section);
  _renderCardsInto(section, series);
}

function renderChannels() {
  const container = document.getElementById('main-channels');
  const liveChannels = [...movieDatabase.trending]
    .filter(c => c.type === 'live' || (c.embed && !c.tmdbId))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  if (liveChannels.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);padding:50px;text-align:center;width:100%;">Buscando señal... 📡</p>';
    return;
  }

  container.innerHTML = liveChannels.map(ch => `
    <div class="tv-card" onclick="window.handleChannelClick('${ch.embed}')">
      <img src="${ch.img}" alt="${ch.title}" onerror="this.src='https://via.placeholder.com/600x400/111/FF7A00?text=SIN+SEÑAL'">
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

// Render Movie Rows
function _renderCardsInto(container, data) {
  if (!data || data.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);padding:30px;">La selva está vacía aquí... 🌿</p>';
    return;
  }
  container.innerHTML = data.map(item => `
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
}

function renderRow(title, data) {
  const container = document.getElementById('main-content');
  if (!data || data.length === 0) return;
  const section = document.createElement('section');
  section.className = 'category-row';
  section.innerHTML = `
    <div class="row-header"><h2 class="row-title">${title}</h2></div>
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
}

// Admin: Render Inventory Table
let _allInventoryItems = [];
window._brokenIds = new Set(); // Para rastrear imágenes que fallaron en esta sesión

function renderInventory() {
  _allInventoryItems = [...movieDatabase.trending];
  _renderInventoryRows(_allInventoryItems);
}

function _renderInventoryRows(items) {
  const list = document.getElementById('inventory-list');
  const typeMaps = {
    movie: { e: '🎬', t: 'Peli' },
    series: { e: '🏆', t: 'Serie' },
    live: { e: '🔴', t: 'TV' },
    anime: { e: '⛩️', t: 'Anime' }
  };

  if (items.length === 0) {
    list.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--text-muted);">No se encontraron coconas con ese filtro... 🍃</td></tr>';
    return;
  }

  list.innerHTML = items.map(m => {
    const isBroken = window._brokenIds.has(m.id);
    const meta = typeMaps[m.type] || typeMaps.movie;
    return `
      <tr style="${isBroken ? 'background: rgba(231, 76, 60, 0.05);' : ''}">
        <td><input type="checkbox" class="coco-check" data-id="${m.id}"></td>
        <td>
          <div style="background: rgba(255,255,255,0.1); padding: 4px 8px; border-radius: 4px; font-size: 0.6rem; text-align: center;">
            ${meta.e} ${meta.t}
          </div>
        </td>
        <td style="display: flex; align-items: center; gap: 10px;">
          <div style="position: relative;">
            <img src="${m.img}" 
                 style="width: 40px; height: 60px; object-fit: cover; border-radius: 4px; ${isBroken ? 'border: 2px solid #E74C3C;' : ''}" 
                 onerror="this.src='https://via.placeholder.com/40x60?text=ER'; window.markAsBroken('${m.id}')">
          </div>
          <span style="${isBroken ? 'color: #E74C3C; font-weight: bold;' : ''}">${m.title}</span>
        </td>
        <td>
          <span style="color: ${m.status === 'healthy' ? '#2ECC71' : '#E74C3C'}">
            ${isBroken ? '⚠️ Error Link' : (m.status === 'healthy' ? '● Activo' : '● Mant.')}
          </span>
        </td>
        <td>
          <div style="display: flex; gap: 5px;">
            <button class="action-btn btn-edit" onclick="window.editMovie('${m.id}')">✏️</button>
            <button class="action-btn btn-delete" onclick="window.deleteMovie('${m.id}')">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

window.markAsBroken = (id) => {
  if (!window._brokenIds.has(id)) {
    window._brokenIds.add(id);
    // No refrescamos todo el tiempo para evitar bucles, solo si el filtro está activo lo verás luego
  }
};

window.filterInventoryByCategory = () => {
  const type = document.getElementById('inventory-type-filter').value;
  const category = document.getElementById('inventory-filter').value;
  const searchInput = document.getElementById('inventory-search');
  const query = searchInput ? searchInput.value.toLowerCase() : '';

  let filtered = _allInventoryItems.filter(m => m.title.toLowerCase().includes(query));

  if (type !== 'all') {
    filtered = filtered.filter(m => m.type === type || (type === 'movie' && !m.type));
  }

  if (category === 'broken') {
    filtered = filtered.filter(m => window._brokenIds.has(m.id) || !m.img || m.img.includes('placeholder'));
  } else if (category === 'missing') {
    filtered = filtered.filter(m => !m.tmdbId || m.tmdbId === "");
  }

  _renderInventoryRows(filtered);

  const bulkBtn = document.getElementById('btn-bulk-delete');
  if (bulkBtn) {
    bulkBtn.style.display = (category === 'broken') ? 'block' : 'none';
    bulkBtn.innerText = `🗑️ Borrar ${filtered.length} con Error`;
  }

  const statusEl = document.getElementById('inventory-status');
  if (statusEl) statusEl.innerText = `Viendo ${filtered.length} coconas.`;
};

window.bulkDeleteCurrentFilter = async () => {
  const filter = document.getElementById('inventory-filter').value;
  if (filter !== 'broken') return;

  const searchInput = document.getElementById('inventory-search');
  const query = searchInput ? searchInput.value.toLowerCase() : '';
  const toDelete = _allInventoryItems.filter(m =>
    m.title.toLowerCase().includes(query) &&
    (window._brokenIds.has(m.id) || !m.img || m.img.includes('placeholder'))
  );

  if (toDelete.length === 0) return;
  if (!confirm(`¿Estás seguro de borrar ${toDelete.length} coconas con error de tu selva? 🌴🗑️`)) return;

  for (const item of toDelete) {
    await deleteDoc(doc(db, "movies", item.id));
  }
  alert(`¡Limpieza completada! Se fueron ${toDelete.length} intrusos.`);
};

window.deleteSelectedCoconas = async () => {
  const selected = document.querySelectorAll('.coco-check:checked');
  if (selected.length === 0) { alert("¡Primero selecciona qué quieres borrar! 🐒"); return; }

  if (!confirm(`¿Seguro que quieres borrar ${selected.length} coconas? Esta acción no se deshace. 🗑️🦁`)) return;

  for (const check of selected) {
    const id = check.dataset.id;
    await deleteDoc(doc(db, "movies", id));
  }
  alert(`¡Limpieza total! Se eliminaron ${selected.length} elementos.`);
};

window.selectAllCoconas = (checked) => {
  document.querySelectorAll('.coco-check').forEach(c => c.checked = checked);
};

// TMDB Search Integration
async function searchTMDB(query, isSuggestion = false) {
  if (!query) return;
  const resultsDiv = document.getElementById('tmdb-results');
  if (!isSuggestion) resultsDiv.innerHTML = '<p style="color: var(--primary);">Buscando en Hollywood... 📡</p>';

  try {
    let data;
    // Si escriben solo números, lo buscamos directo por ID (Ej: 1032892)
    if (/^\d+$/.test(query.trim())) {
      const res = await fetch(`${TMDB_URL}/movie/${query.trim()}?api_key=${TMDB_API_KEY}&language=es-ES`);
      if (!res.ok) throw new Error("No encontrado");
      const movie = await res.json();
      data = { results: [movie] };
    } else {
      // Búsqueda multi (Películas y Series)
      const res = await fetch(`${TMDB_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=es-ES`);
      if (!res.ok) throw new Error("Error en API");
      data = await res.json();
    }

    if (!data.results || data.results.length === 0) {
      resultsDiv.innerHTML = '<p style="color: var(--text-muted);">No encontramos esa joya en la selva 🧐</p>';
      return;
    }

    resultsDiv.innerHTML = (isSuggestion ? '<p style="width:100%; font-size:0.8rem; color:var(--primary); margin-bottom:5px;">💡 Sugerencias de Imagen:</p>' : '') +
      data.results.slice(0, 5).map(m => {
        const title = m.title || m.name || "Sin Título";
        const type = m.media_type === 'tv' ? 'series' : 'movie';
        const imgUrl = TMDB_IMG_URL + m.poster_path;

        if (isSuggestion) {
          return `
          <div class="tmdb-item" onclick="window.suggestImage('${imgUrl}')" style="min-width: 80px;">
            <img src="${imgUrl}" alt="${title}" style="height: 120px;" onerror="this.src='https://via.placeholder.com/80x120'">
          </div>
        `;
        }

        return `
        <div class="tmdb-item" onclick="window.selectTMDBMovie(${JSON.stringify(m).replace(/"/g, '&quot;')})">
          <img src="${imgUrl}" alt="${title}" onerror="this.src='https://via.placeholder.com/150x225'">
          <p style="font-size:0.7rem;">[${type === 'series' ? 'Serie' : 'Peli'}]</p>
          <p>${title}</p>
        </div>
      `;
      }).join('');
  } catch (err) {
    resultsDiv.innerHTML = '<p style="color: #E74C3C;">Error al conectar con TMDB (Revisa el ID) 🐒</p>';
  }
}

window.selectTMDBMovie = (m) => {
  const title = m.title || m.name;
  const date = m.release_date || m.first_air_date || "2024";
  const type = m.media_type === 'tv' ? 'series' : 'movie';

  document.getElementById('m-title').value = title;
  document.getElementById('m-img').value = TMDB_IMG_URL + m.poster_path;
  document.getElementById('m-tmdb-id').value = m.id;
  document.getElementById('m-type').value = type;
  document.getElementById('m-meta').value = `${date.split('-')[0]} / ${m.vote_average || '8.0'}`;
  document.getElementById('m-embed').value = "";

  const preview = document.getElementById('m-img-preview');
  if (preview) preview.src = TMDB_IMG_URL + m.poster_path;

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
function startAdCountdown(callback) {
  const adOverlay = document.getElementById('ad-overlay');
  const skipBtn = document.getElementById('skip-ad-btn');

  adOverlay.style.display = 'flex';
  let countdown = 5;
  skipBtn.innerText = `Cerrando en ${countdown}...`;
  skipBtn.disabled = true;

  const timer = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      clearInterval(timer);
      skipBtn.innerText = "Continuar a la Selva 🍿";
      skipBtn.disabled = false;
    } else {
      skipBtn.innerText = `Cerrando en ${countdown}...`;
    }
  }, 1000);

  // El listener del boton de skip ya esta configurado en initApp
  // pero necesitamos asegurarnos de que ejecute el callback cuando se limpie
  const skipHandler = () => {
    if (callback) callback();
    skipBtn.removeEventListener('click', skipHandler);
  };
  skipBtn.addEventListener('click', skipHandler);
}

async function openPlayer(movieId) {
  const allMovies = [...movieDatabase.trending];
  const movie = allMovies.find(m => m.id === movieId);
  if (!movie) return;

  collectUserData("watch_attempt", { title: movie.title, id: movie.id });

  currentPlayerMovie = movie;
  const modal = document.getElementById('player-modal');
  modal.style.display = 'flex';

  const isSeries = movie.type === 'series' || movie.type === 'tv' || movie.type === 'anime';
  const nav = document.getElementById('series-navigator');
  if (nav) nav.style.display = isSeries ? 'flex' : 'none';
  if (isSeries && movie.tmdbId) {
    try {
      const resp = await fetch(`${TMDB_URL}/tv/${movie.tmdbId}?api_key=${TMDB_API_KEY}&language=es-ES`);
      const details = await resp.json();
      const sSel = document.getElementById('series-season');
      const eSel = document.getElementById('series-episode');

      if (details.seasons) {
        sSel.innerHTML = details.seasons
          .filter(s => s.season_number > 0)
          .map(s => `<option value="${s.season_number}">${s.name || `Temp ${s.season_number}`}</option>`).join('');

        const updateE = (sNum) => {
          const s = details.seasons.find(x => x.season_number == sNum);
          const count = s ? s.episode_count : 24;
          eSel.innerHTML = Array.from({ length: count }, (_, i) => `<option value="${i + 1}">Capítulo ${i + 1}</option>`).join('');
        };

        updateE(details.seasons.find(s => s.season_number > 0)?.season_number || 1);
        sSel.onchange = () => { updateE(sSel.value); window.changeEpisode(); };
      }
    } catch (e) { console.error("TMDB Error:", e); }
  } else if (isSeries) {
    // Fallback if no TMDB ID
    document.getElementById('series-season').innerHTML = '<option value="1">Temp 1</option>';
    document.getElementById('series-episode').innerHTML = Array.from({ length: 24 }, (_, i) => `<option value="${i + 1}">Capítulo ${i + 1}</option>`).join('');
  }

  startAdCountdown(() => {
    if (movie.tmdbId) {
      document.getElementById('server-switcher').style.display = 'flex';
      updateServer('vidsrc');
    } else {
      document.getElementById('server-switcher').style.display = 'none';
      document.getElementById('player-iframe').src = movie.embed || "";
    }
  });
}

function updateServer(serverKey, season = 1, episode = 1) {
  if (!currentPlayerMovie || !currentPlayerMovie.tmdbId) return;

  const loadIframe = () => {
    const iframe = document.getElementById('player-iframe');
    const loader = document.getElementById('player-loader');
    const tmdbId = currentPlayerMovie.tmdbId;

    document.querySelectorAll('.server-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.server === serverKey);
    });

    loader.style.display = 'flex';
    loader.style.opacity = '1';

    let url = "";
    const type = currentPlayerMovie.type || 'movie';
    const isSeries = type === 'series' || type === 'tv';

    switch (serverKey) {
      case 'vidsrc':
        url = isSeries
          ? `https://vidsrc.xyz/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}&lang=es`
          : `https://vidsrc.xyz/embed/movie?tmdb=${tmdbId}&lang=es`;
        break;
      case 'superembed':
        url = isSeries
          ? `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}&lang=es`
          : `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&lang=es`;
        break;
      case 'smashy':
        url = isSeries
          ? `https://player.smashy.stream/tv/${tmdbId}?s=${season}&e=${episode}&lang=es`
          : `https://player.smashy.stream/movie/${tmdbId}?lang=es`;
        break;
      case 'autoembed':
        url = isSeries
          ? `https://autoembed.co/tv/tmdb/${tmdbId}?s=${season}&e=${episode}&lang=es`
          : `https://autoembed.co/movie/tmdb/${tmdbId}?lang=es`;
        break;
      default:
        url = `https://vidsrc.xyz/embed/${isSeries ? 'tv' : 'movie'}?tmdb=${tmdbId}&lang=es`;
    }

    iframe.src = url;
    // Navigation for series enabled
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-presentation allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation');

    iframe.onload = () => {
      setTimeout(() => {
        loader.style.opacity = '0';
        setTimeout(() => loader.style.display = 'none', 800);
      }, 1500);
    };
  };

  loadIframe();
}

window.changeEpisode = () => {
  const s = document.getElementById('series-season').value || 1;
  const e = document.getElementById('series-episode').value || 1;
  const activeServer = document.querySelector('.server-btn.active').dataset.server;
  updateServer(activeServer, s, e);
};

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
  document.getElementById('m-embed').value = movie.embed || "";
  document.getElementById('m-meta').value = `${movie.year || '2024'} / ${movie.rating || '4.8'}`;
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
    let url = `${TMDB_URL}/discover/${isTv ? 'tv' : 'movie'}?api_key=${TMDB_API_KEY}&language=es-ES&sort_by=popularity.desc&page=1`;

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

  const data = {
    title: s.title || s.name,
    img: TMDB_IMG_URL + s.poster_path,
    tmdbId: s.id.toString(),
    embed: "",
    year: (s.release_date || s.first_air_date || "2024").split('-')[0],
    rating: s.vote_average?.toFixed(1) || "8.5",
    type: type,
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

window.massSeedMovies = async () => {
  const pages = parseInt(document.getElementById('mass-seed-amount').value) || 1;
  const year = document.getElementById('discover-year').value;
  const genre = document.getElementById('discover-genre').value;

  const confirmed = confirm(`¿Quieres sembrar hasta ${pages * 20} películas? 🚜🍿`);
  if (!confirmed) return;

  const btn = document.getElementById('btn-mass-seed');
  const originalText = btn.innerText;
  btn.disabled = true;

  const existingIds = new Set(movieDatabase.trending.map(m => m.tmdbId));
  let addedCount = 0;

  try {
    for (let p = 1; p <= pages; p++) {
      btn.innerText = `🚜 Cosechando pág ${p}/${pages}...`;
      let url = `${TMDB_URL}/discover/movie?api_key=${TMDB_API_KEY}&language=es-ES&sort_by=popularity.desc&page=${p}`;
      if (year) url += `&primary_release_year=${year}`;
      if (genre) url += `&with_genres=${genre}`;

      const res = await fetch(url);
      const data = await res.json();

      for (const s of data.results) {
        if (!existingIds.has(s.id.toString())) {
          const mData = {
            title: s.title,
            img: TMDB_IMG_URL + s.poster_path,
            tmdbId: s.id.toString(),
            embed: "",
            year: (s.release_date || "2024").split('-')[0],
            rating: s.vote_average?.toFixed(1) || "7.5",
            type: 'movie',
            status: 'healthy',
            createdAt: Date.now()
          };
          await addDoc(moviesCol, mData);
          existingIds.add(s.id.toString());
          addedCount++;
        }
      }
    }
    alert(`¡Cosecha completada! 🌴🍿\nSe añadieron ${addedCount} nuevas coconas.`);
  } catch (err) {
    console.error(err);
    alert("Algo falló en la cosecha 🐒");
  } finally {
    btn.disabled = false;
    btn.innerText = originalText;
  }
};

let heroTimer = null;
let heroPool = [];
let currentHeroIndex = 0;

function updateHeroCarousel() {
  if (heroPool.length === 0) return;
  const item = heroPool[currentHeroIndex];
  const section = document.getElementById('hero-section');
  const title = document.getElementById('hero-title');
  const sub = document.getElementById('hero-subtitle');
  const btn = document.getElementById('hero-play-btn');

  if (!section || !title || !sub || !btn) return;

  // Transición suave
  section.style.transition = 'opacity 0.4s ease';
  section.style.opacity = '0.5';

  setTimeout(() => {
    title.innerText = item.title;
    sub.innerText = `${item.year || '2024'} • ⭐ ${item.rating || '4.8'}`;
    section.style.backgroundImage = `linear-gradient(to right, rgba(0,0,0,0.95), transparent), url(${item.img})`;
    btn.onclick = () => openPlayer(item.id);
    section.style.opacity = '1';
  }, 400);

  currentHeroIndex = (currentHeroIndex + 1) % heroPool.length;
}

function initApp() {
  const container = document.getElementById('main-content');
  container.innerHTML = '';

  // ORDEN INTELIGENTE: Salud -> Fecha de Creación
  const allContent = [...movieDatabase.trending].sort((a, b) => {
    const healthA = window._brokenIds.has(a.id) ? 0 : 1;
    const healthB = window._brokenIds.has(b.id) ? 0 : 1;
    if (healthA !== healthB) return healthB - healthA;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  // Pool de Recomendados (Hero Carousel - 3 items)
  heroPool = allContent
    .filter(c => (c.type === 'movie' || !c.type) && !window._brokenIds.has(c.id))
    .slice(0, 3);

  if (heroPool.length > 0) {
    currentHeroIndex = 0;
    updateHeroCarousel();
    if (heroTimer) clearInterval(heroTimer);
    heroTimer = setInterval(updateHeroCarousel, 5000); // Cambio cada 5 segundos
  }

  const releases = allContent.slice(0, 20);
  const movies = allContent.filter(c => c.type === 'movie' || !c.type).slice(0, 50);
  const series = allContent.filter(c => c.type === 'series' || c.type === 'tv').slice(0, 50);
  const anime = allContent.filter(c => c.type === 'anime' || c.title.toLowerCase().includes('anime')).slice(0, 30);

  // Rows Estilo Netflix
  if (releases.length > 0) renderRow('Lo más nuevo en SelvaFlix ✨', releases);
  if (series.length > 0) renderRow('Series que no te puedes perder 🏆', series);
  if (anime.length > 0) renderRow('Zonas Anime y Calificadas ⛩️', anime);
  if (movies.length > 0) renderRow('Cosecha de Películas 🎬', movies);
}

// Initial Setup
document.addEventListener('DOMContentLoaded', () => {
  handleRouting();
  window.addEventListener('hashchange', handleRouting);

  document.getElementById('global-search').addEventListener('input', (e) => handleGlobalSearch(e.target.value));

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
  document.getElementById('m-img').addEventListener('paste', (e) => {
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
    const movieData = {
      title: document.getElementById('m-title').value,
      img: document.getElementById('m-img').value,
      tmdbId: document.getElementById('m-tmdb-id').value,
      embed: document.getElementById('m-embed').value,
      year: document.getElementById('m-meta').value.split('/')[0].trim(),
      rating: document.getElementById('m-meta').value.split('/')[1]?.trim() || '4.8',
      type: document.getElementById('m-type').value || 'movie',
      status: 'healthy',
      updatedAt: Date.now()
    };

    try {
      if (dbId) {
        // ACTUALIZAR
        await updateDoc(doc(db, "movies", dbId), movieData);
        alert('¡Actualización Exitosa! 🌴🔄');
      } else {
        // AGREGAR
        movieData.createdAt = Date.now();
        await addDoc(moviesCol, movieData);
        alert('¡Cosecha Exitosa! 🌴🍿');
      }

      // Reset
      e.target.reset();
      document.getElementById('m-db-id').value = "";
      document.getElementById('m-img-preview').src = 'https://via.placeholder.com/150x220?text=Previsualización';
      document.getElementById('submit-btn').innerText = "¡Guardar en la Selva! 🌴✨";
      document.getElementById('cancel-edit').style.display = "none";
      document.getElementById('tmdb-results').innerHTML = '';

    } catch (error) {
      console.error("Error en operación: ", error);
      alert('Uy, hubo un problema en la selva 🐒');
    }
  });

  document.getElementById('cancel-edit').addEventListener('click', () => {
    document.getElementById('movie-form').reset();
    document.getElementById('m-db-id').value = "";
    document.getElementById('m-img-preview').src = 'https://via.placeholder.com/150x220?text=Previsualización';
    document.getElementById('submit-btn').innerText = "¡Guardar en la Selva! 🌴✨";
    document.getElementById('cancel-edit').style.display = "none";
  });

  document.getElementById('server-switcher').addEventListener('click', (e) => {
    if (e.target.classList.contains('server-btn')) {
      updateServer(e.target.dataset.server);
    }
  });

  document.getElementById('close-player').addEventListener('click', () => {
    const modal = document.getElementById('player-modal');
    const iframe = document.getElementById('player-iframe');
    modal.style.display = 'none';
    iframe.src = ""; // Detener audio/video al cerrar
  });

  document.getElementById('skip-ad-btn').addEventListener('click', () => {
    document.getElementById('ad-overlay').style.display = 'none';
  });

  // Discovery Handlers
  document.getElementById('btn-discover-movies').addEventListener('click', () => discoverContent('movie'));
  document.getElementById('btn-discover-series').addEventListener('click', () => discoverContent('tv'));
  document.getElementById('btn-discover-live').addEventListener('click', () => discoverContent('live'));
  document.getElementById('btn-mass-seed').addEventListener('click', () => window.massSeedMovies());

  // Detectar dispositivo para recomendar bloqueador
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  const adblockLink = document.getElementById('adblock-link');
  const adblockText = document.getElementById('adblock-text');

  if (/android/i.test(userAgent)) {
    adblockLink.href = "https://play.google.com/store/apps/details?id=com.brave.browser";
    adblockLink.innerText = "Brave para Android";
  } else if (/iPad|iPhone|iPod/.test(userAgent) && !window.MSStream) {
    adblockLink.href = "https://apps.apple.com/us/app/brave-private-web-browser/id1052879175";
    adblockLink.innerText = "Brave para iPhone/iPad";
  } else {
    adblockLink.href = "https://brave.com/";
    adblockLink.innerText = "Brave Browser o uBlock Origin";
  }
});
