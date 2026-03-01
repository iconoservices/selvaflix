import './style.css'

const movieDatabase = {
  trending: [
    { id: 1, title: 'Cocona Fugitiva', year: 2024, rating: '4.8', img: 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?auto=format&fit=crop&q=80&w=500', embed: 'https://www.youtube.com/embed/dQw4w9WgXcQ' },
    { id: 2, title: 'Selva de Cristal', year: 2023, rating: '4.5', img: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&q=80&w=500', embed: 'https://www.youtube.com/embed/dQw4w9WgXcQ' },
    { id: 3, title: 'El Despertar Tropical', year: 2024, rating: '4.9', img: 'https://images.unsplash.com/photo-1501854140801-50d01674aa3e?auto=format&fit=crop&q=80&w=500', embed: 'https://www.youtube.com/embed/dQw4w9WgXcQ' },
    { id: 4, title: 'Operación Amazonas', year: 2022, rating: '4.2', img: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&q=80&w=500', embed: 'https://www.youtube.com/embed/dQw4w9WgXcQ' },
    { id: 5, title: 'Secretos del Jaguar', year: 2024, rating: '4.7', img: 'https://images.unsplash.com/photo-1549488344-1f9b8d2bd1f3?auto=format&fit=crop&q=80&w=500', embed: 'https://www.youtube.com/embed/dQw4w9WgXcQ' },
  ],
  series: [
    { id: 101, title: 'Crónicas de la Hoja', seasons: 3, img: 'https://images.unsplash.com/photo-1502082553048-f009c37129b9?auto=format&fit=crop&q=80&w=500' },
    { id: 102, title: 'Reyes del Manguaré', seasons: 1, img: 'https://images.unsplash.com/photo-1518495973542-4542c06a5843?auto=format&fit=crop&q=80&w=500' },
    { id: 103, title: 'Bajo el Sol', seasons: 5, img: 'https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&q=80&w=500' },
  ],
  live: [
    { id: 201, title: 'Selva Sports 24/7', active: true, img: 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&q=80&w=500' },
    { id: 202, title: 'Nature Channel HD', active: true, img: 'https://images.unsplash.com/photo-1472214103451-9374bd1c798e?auto=format&fit=crop&q=80&w=500' },
  ]
};

function renderRow(title, data) {
  const container = document.getElementById('main-content');
  const rowHtml = `
    <section class="category-row">
      <div class="row-header">
        <h2 class="row-title">${title}</h2>
      </div>
      <div class="movie-list">
        ${data.map(item => `
          <div class="movie-card" data-id="${item.id}" data-type="${item.seasons ? 'series' : 'movie'}" data-embed="${item.embed || ''}">
            <img src="${item.img}" alt="${item.title}" class="card-img" loading="lazy">
            <div class="card-info">
              <h3 class="card-title">${item.title}</h3>
              <p class="card-meta">${item.year || (item.seasons + ' Temporadas') || 'EN VIVO'} • ★ ${item.rating || 'TOP'}</p>
            </div>
          </div>
        `).join('')}
      </div>
    </section>
  `;
  container.insertAdjacentHTML('beforeend', rowHtml);
}

// Player Handling
function openPlayer(embedUrl) {
  const modal = document.getElementById('player-modal');
  const iframe = document.getElementById('player-iframe');
  const loader = document.getElementById('player-loader');

  if (!embedUrl) {
    alert('Próximamente... estamos cosechando esta peli 🥥');
    return;
  }

  modal.style.display = 'flex';
  loader.style.opacity = '1';
  loader.style.display = 'flex';

  // The Sandbox Shield: No popups, no forms, just essence
  iframe.src = embedUrl;
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');

  iframe.onload = () => {
    setTimeout(() => {
      loader.style.opacity = '0';
      setTimeout(() => loader.style.display = 'none', 800);
    }, 1500); // Give it some time for the effect
  };
}

function closePlayer() {
  const modal = document.getElementById('player-modal');
  const iframe = document.getElementById('player-iframe');
  modal.style.display = 'none';
  iframe.src = ''; // Stop video
}

function initApp() {
  const heroTitle = document.getElementById('hero-title');
  const heroDesc = document.getElementById('hero-desc');

  heroTitle.innerText = "Cocona Fugitiva";
  heroDesc.innerText = "Una aventura salvaje a traves del Amazonas que cambiara todo lo que creias saber sobre la selva.";

  renderRow('Recien Cosechadas', movieDatabase.trending);
  renderRow('Series del Momento', movieDatabase.series);
  renderRow('En Vivo en la Selva', movieDatabase.live);

  // Event Listeners
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.movie-card');
    if (card) {
      const embed = card.getAttribute('data-embed');
      openPlayer(embed);
    }

    if (e.target.id === 'close-player' || e.target.classList.contains('player-modal')) {
      closePlayer();
    }
  });

  // Hero Play Button
  document.querySelector('.btn-primary').addEventListener('click', () => {
    openPlayer('https://www.youtube.com/embed/dQw4w9WgXcQ'); // Sample trailer
  });
}

document.addEventListener('DOMContentLoaded', initApp);
