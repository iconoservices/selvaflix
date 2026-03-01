import './style.css'

// TMDB API Config (Public Demo Key - should be changed for production)
const TMDB_API_KEY = 'c5307b8a7b3d3408436473062f6b39ec';
const TMDB_URL = 'https://api.themoviedb.org/3';
const TMDB_IMG_URL = 'https://image.tmdb.org/t/p/w500';

// Initial state with some sample movies
let movieDatabase = JSON.parse(localStorage.getItem('selvaflix_v2')) || {
  trending: [
    { id: 533535, title: 'Cocona Fugitiva (Deadpool)', year: 2024, rating: '4.8', img: 'https://image.tmdb.org/t/p/w500/87mY5pT7bBInmHqNf7e7j7f7F7.jpg', tmdbId: 533535, status: 'healthy' },
    { id: 19995, title: 'Avatar: La Selva de Cristal', year: 2009, rating: '4.5', img: 'https://image.tmdb.org/t/p/w500/6EiRUJTLGE7m4QDJu10v9SRq7v5.jpg', tmdbId: 19995, status: 'healthy' },
  ],
  series: [],
  live: []
};

let currentPlayerMovie = null;

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
  const allMovies = [...movieDatabase.trending, ...movieDatabase.series, ...movieDatabase.live];
  const filtered = allMovies.filter(m => m.title.toLowerCase().includes(query.toLowerCase()));

  const container = document.getElementById('main-content');
  container.innerHTML = '';

  if (query) {
    renderRow(`Resultados para "${query}"`, filtered);
  } else {
    initApp();
  }
}

// Render Movie Rows
function renderRow(title, data) {
  const container = document.getElementById('main-content');
  if (!data || data.length === 0) {
    if (title.includes("Resultados")) {
      container.insertAdjacentHTML('beforeend', `<p style="padding: 50px; text-align: center; color: var(--text-muted);">No se encontro nada en esta selva... 🕵️‍♂️🥥</p>`);
    }
    return;
  }

  const rowHtml = `
    <section class="category-row">
      <div class="row-header">
        <h2 class="row-title">${title}</h2>
      </div>
      <div class="movie-list">
        ${data.map(item => `
          <div class="movie-card" data-id="${item.id}" onclick="window.handleCardClick(${item.id})">
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
  const allMovies = [...movieDatabase.trending, ...movieDatabase.series, ...movieDatabase.live];

  list.innerHTML = allMovies.map(m => `
    <tr>
      <td>${m.title}</td>
      <td>
        <span style="color: ${m.status === 'healthy' ? '#2ECC71' : '#E74C3C'}">
          ${m.status === 'healthy' ? '● Activo' : '● Mantenimiento'}
        </span>
      </td>
      <td>
        <button class="action-btn btn-edit" onclick="window.editMovie(${m.id})">Editar</button>
        <button class="action-btn btn-delete" onclick="window.deleteMovie(${m.id})">Borrar</button>
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
    const res = await fetch(`${TMDB_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=es-ES`);
    const data = await res.json();

    resultsDiv.innerHTML = data.results.slice(0, 5).map(m => `
      <div class="tmdb-item" onclick="window.selectTMDBMovie(${JSON.stringify(m).replace(/"/g, '&quot;')})">
        <img src="${TMDB_IMG_URL + m.poster_path}" alt="${m.title}" onerror="this.src='https://via.placeholder.com/150x225'">
        <p>${m.title}</p>
      </div>
    `).join('');
  } catch (err) {
    resultsDiv.innerHTML = '<p style="color: #E74C3C;">Error al conectar con TMDB 🐒</p>';
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

// Player Logic & Multi-Server
function openPlayer(movieId) {
  const allMovies = [...movieDatabase.trending, ...movieDatabase.series, ...movieDatabase.live];
  const movie = allMovies.find(m => m.id == movieId);
  if (!movie) return;

  currentPlayerMovie = movie;
  const modal = document.getElementById('player-modal');
  modal.style.display = 'flex';

  // Reset switcher
  const switcher = document.getElementById('server-switcher');
  if (movie.tmdbId) {
    switcher.style.display = 'flex';
    updateServer('vidsrc');
  } else {
    switcher.style.display = 'none';
    const iframe = document.getElementById('player-iframe');
    iframe.src = movie.embed || "";
  }
}

function updateServer(serverKey) {
  if (!currentPlayerMovie || !currentPlayerMovie.tmdbId) return;

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
    case 'vidsrc': url = `https://vidsrc.me/embed/movie?tmdb=${tmdbId}`; break;
    case 'superembed': url = `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1`; break;
    case '2embed': url = `https://www.2embed.cc/embed/${tmdbId}`; break;
    default: url = `https://vidsrc.me/embed/movie?tmdb=${tmdbId}`;
  }

  iframe.src = url;
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');

  iframe.onload = () => {
    setTimeout(() => {
      loader.style.opacity = '0';
      setTimeout(() => loader.style.display = 'none', 800);
    }, 1500);
  };
}

// Exported Actions
window.handleCardClick = (id) => openPlayer(id);

window.deleteMovie = (id) => {
  movieDatabase.trending = movieDatabase.trending.filter(m => m.id !== id);
  localStorage.setItem('selvaflix_v2', JSON.stringify(movieDatabase));
  renderInventory();
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

  // Global Search
  document.getElementById('global-search').addEventListener('input', (e) => handleGlobalSearch(e.target.value));

  // TMDB Search Button
  document.getElementById('btn-tmdb-search').addEventListener('click', () => {
    const query = document.getElementById('tmdb-search-input').value;
    searchTMDB(query);
  });

  // Movie Form Submit
  document.getElementById('movie-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const newMovie = {
      id: Date.now(),
      title: document.getElementById('m-title').value,
      img: document.getElementById('m-img').value,
      tmdbId: document.getElementById('m-tmdb-id').value,
      embed: document.getElementById('m-embed').value,
      year: document.getElementById('m-meta').value.split('/')[0].trim(),
      rating: document.getElementById('m-meta').value.split('/')[1]?.trim() || '4.8',
      status: 'healthy'
    };
    movieDatabase.trending.unshift(newMovie);
    localStorage.setItem('selvaflix_v2', JSON.stringify(movieDatabase));
    e.target.reset();
    document.getElementById('tmdb-results').innerHTML = '';
    renderInventory();
    alert('¡Cosecha Exitosa! 🌴🍿 Peli guardada y lista en el Inicio.');
  });

  // Server Switcher Clicks
  document.getElementById('server-switcher').addEventListener('click', (e) => {
    if (e.target.classList.contains('server-btn')) {
      updateServer(e.target.dataset.server);
    }
  });

  // Player Close
  document.getElementById('close-player').addEventListener('click', () => {
    document.getElementById('player-modal').style.display = 'none';
    document.getElementById('player-iframe').src = '';
  });
});
