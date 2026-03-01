import './style.css'
import { initializeApp } from "firebase/app";
import { getFirestore, collection, onSnapshot, addDoc, deleteDoc, doc } from "firebase/firestore";

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
const moviesCol = collection(db, "movies");

// --- TMDB API Config ---
const TMDB_API_KEY = '15d2ea6d0dc1d476efbca3eba2b9bbfb'; // Clave publica para demos
const TMDB_URL = 'https://api.themoviedb.org/3';
const TMDB_IMG_URL = 'https://image.tmdb.org/t/p/w500';

let movieDatabase = { trending: [] };
let currentPlayerMovie = null;

// Firebase Listener (Real-time sync)
onSnapshot(moviesCol, (snapshot) => {
  movieDatabase.trending = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const hash = window.location.hash;
  if (hash === '#admin') renderInventory();
  else initApp();
});


// Routing Logic
function handleRouting() {
  const hash = window.location.hash;
  const homeView = document.getElementById('home-view');
  const adminView = document.getElementById('admin-view');

  if (hash === '#admin') {
    homeView.style.display = 'none';
    adminView.style.display = 'block';
    renderInventory();
  } else {
    homeView.style.display = 'block';
    adminView.style.display = 'none';
    initApp();
  }
}

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
function renderRow(title, data) {
  const container = document.getElementById('main-content');
  if (!data || data.length === 0) return;

  const rowHtml = `
    <section class="category-row">
      <div class="row-header">
        <h2 class="row-title">${title}</h2>
      </div>
      <div class="movie-list">
        ${data.map(item => `
          <div class="movie-card" data-id="${item.id}" onclick="window.handleCardClick('${item.id}')">
            ${item.status === 'maintenance' ? '<div class="badge-maintenance">Mantenimiento</div>' : ''}
            <img src="${item.img}" alt="${item.title}" class="card-img" loading="lazy" onerror="this.src='https://via.placeholder.com/500x750?text=No+Poster'">
            <div class="card-info">
              <h3 class="card-title">${item.title}</h3>
              <p class="card-meta">${item.year || 'Estreno'} • ★ ${item.rating || '4.8'}</p>
            </div>
          </div>
        `).join('')}
      </div>
    </section>
  `;
  container.insertAdjacentHTML('beforeend', rowHtml);
}

// Admin: Render Inventory Table
function renderInventory() {
  const list = document.getElementById('inventory-list');
  const allMovies = [...movieDatabase.trending];

  list.innerHTML = allMovies.map(m => `
    <tr>
      <td>${m.title}</td>
      <td>
        <span style="color: ${m.status === 'healthy' ? '#2ECC71' : '#E74C3C'}">
          ${m.status === 'healthy' ? '● Activo' : '● Mantenimiento'}
        </span>
      </td>
      <td>
        <button class="action-btn btn-delete" onclick="window.deleteMovie('${m.id}')">Borrar</button>
      </td>
    </tr>
  `).join('');
}

// TMDB Search Integration
async function searchTMDB(query) {
  if (!query) return;
  const resultsDiv = document.getElementById('tmdb-results');
  resultsDiv.innerHTML = '<p style="color: var(--primary);">Buscando en Hollywood... 📡</p>';

  try {
    let data;
    // Si escriben solo números, lo buscamos directo por ID (Ej: 1032892)
    if (/^\d+$/.test(query.trim())) {
      const res = await fetch(`${TMDB_URL}/movie/${query.trim()}?api_key=${TMDB_API_KEY}&language=es-ES`);
      if (!res.ok) throw new Error("No encontrado");
      const movie = await res.json();
      data = { results: [movie] };
    } else {
      // Búsqueda normal por nombre
      const res = await fetch(`${TMDB_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=es-ES`);
      if (!res.ok) throw new Error("Error en API");
      data = await res.json();
    }

    if (!data.results || data.results.length === 0) {
      resultsDiv.innerHTML = '<p style="color: var(--text-muted);">No encontramos esa joya en la selva 🧐</p>';
      return;
    }

    resultsDiv.innerHTML = data.results.slice(0, 5).map(m => `
      <div class="tmdb-item" onclick="window.selectTMDBMovie(${JSON.stringify(m).replace(/"/g, '&quot;')})">
        <img src="${TMDB_IMG_URL + m.poster_path}" alt="${m.title}" onerror="this.src='https://via.placeholder.com/150x225'">
        <p>${m.title}</p>
      </div>
    `).join('');
  } catch (err) {
    resultsDiv.innerHTML = '<p style="color: #E74C3C;">Error al conectar con TMDB (Revisa el ID) 🐒</p>';
  }
}

window.selectTMDBMovie = (m) => {
  document.getElementById('m-title').value = m.title;
  document.getElementById('m-img').value = TMDB_IMG_URL + m.poster_path;
  document.getElementById('m-tmdb-id').value = m.id;
  document.getElementById('m-meta').value = `${m.release_date.split('-')[0]} / ${m.vote_average}`;
  document.getElementById('m-embed').value = ""; // Clear manual embed to use auto multi-server
  alert(`Cosechada info de: ${m.title} 🥥🍹`);
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

function openPlayer(movieId) {
  const allMovies = [...movieDatabase.trending];
  const movie = allMovies.find(m => m.id === movieId);
  if (!movie) return;

  collectUserData("watch_attempt", { title: movie.title, id: movie.id });

  currentPlayerMovie = movie;
  const modal = document.getElementById('player-modal');
  modal.style.display = 'flex';

  startAdCountdown(() => {
    if (movie.tmdbId) {
      document.getElementById('server-switcher').style.display = 'flex';
      updateServer('vidsrc', true); // true para saltarse el countdown interno si ya paso el de openPlayer
    } else {
      document.getElementById('server-switcher').style.display = 'none';
      document.getElementById('player-iframe').src = movie.embed || "";
    }
  });
}

function updateServer(serverKey, skipCountdown = false) {
  if (!currentPlayerMovie || !currentPlayerMovie.tmdbId) return;

  const loadIframe = () => {
    const iframe = document.getElementById('player-iframe');
    const loader = document.getElementById('player-loader');
    const tmdbId = currentPlayerMovie.tmdbId;

    // Visual active state
    document.querySelectorAll('.server-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.server === serverKey);
    });

    loader.style.display = 'flex';
    loader.style.opacity = '1';

    let url = "";
    switch (serverKey) {
      case 'vidsrc': url = `https://vidsrc.xyz/embed/movie?tmdb=${tmdbId}&lang=es`; break;
      case 'superembed': url = `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&lang=es`; break;
      case 'smashy': url = `https://player.smashy.stream/movie/${tmdbId}?lang=es`; break;
      case 'autoembed': url = `https://autoembed.co/movie/tmdb/${tmdbId}?lang=es`; break;
      case '2embed': url = `https://www.2embed.cc/embed/${tmdbId}`; break;
      default: url = `https://vidsrc.xyz/embed/movie?tmdb=${tmdbId}&lang=es`;
    }

    iframe.src = url;
    // Probando los limites del Sandbox: Bloqueando popups pero permitiendo lo basico
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-presentation');

    iframe.onload = () => {
      setTimeout(() => {
        loader.style.opacity = '0';
        setTimeout(() => loader.style.display = 'none', 800);
      }, 1500);
    };
  };

  if (skipCountdown) {
    loadIframe();
  } else {
    // Si cambia de servidor, le volvemos a mostrar el anuncio de "Consejo"
    startAdCountdown(loadIframe);
  }
}

// Exported Actions
window.handleCardClick = (id) => openPlayer(id);

window.deleteMovie = async (id) => {
  try {
    await deleteDoc(doc(db, "movies", id));
  } catch (e) {
    console.error("Error eliminando pelicula: ", e);
  }
};

function initApp() {
  const container = document.getElementById('main-content');
  container.innerHTML = '';
  renderRow('Recien Cosechadas', movieDatabase.trending);

  document.getElementById('hero-title').innerText = "Cocona Fugitiva";
  document.getElementById('hero-title').style.opacity = "1";
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

  // Movie Form Submit (Save to Firebase)
  document.getElementById('movie-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newMovie = {
      title: document.getElementById('m-title').value,
      img: document.getElementById('m-img').value,
      tmdbId: document.getElementById('m-tmdb-id').value,
      embed: document.getElementById('m-embed').value,
      year: document.getElementById('m-meta').value.split('/')[0].trim(),
      rating: document.getElementById('m-meta').value.split('/')[1]?.trim() || '4.8',
      status: 'healthy',
      createdAt: Date.now()
    };

    try {
      await addDoc(moviesCol, newMovie);
      e.target.reset();
      document.getElementById('tmdb-results').innerHTML = '';
      alert('¡Cosecha Exitosa en la Nube de Firebase! ☁️🌴🍿');
    } catch (error) {
      console.error("Error añadiendo documento: ", error);
      alert('Uy, hubo un problema guardando en la selva 🐒');
    }
  });

  document.getElementById('server-switcher').addEventListener('click', (e) => {
    if (e.target.classList.contains('server-btn')) {
      updateServer(e.target.dataset.server);
    }
  });

  document.getElementById('skip-ad-btn').addEventListener('click', () => {
    document.getElementById('ad-overlay').style.display = 'none';
  });

  document.getElementById('close-player').addEventListener('click', () => {
    document.getElementById('player-modal').style.display = 'none';
    document.getElementById('player-iframe').src = '';
  });

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
