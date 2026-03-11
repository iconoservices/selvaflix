/* 
   🦅 SelvaStream Engine v1.0
   Arquitecto: Antigravity
   Misión: Encapsulamiento de reproducción segura y premium.
*/

export const SelvaStream = {
    currentPlayerMovie: null,
    torrentClient: null,
    hls: null,
    lastScrapedStreams: [],
    showTraditional: false,
    MASTER_WORKER_URL: 'https://icono-proxy.jnmcsky.workers.dev', // IconoServices Master Tunnel
    AUTH_TOKEN: import.meta.env.VITE_AUTH_TOKEN || localStorage.getItem('iconoservices_token') || '', // Token cargado desde Vercel (Seguridad)

    /**
     * Sanea la URL para evitar inyecciones maliciosas.
     * @param {string} url 
     * @returns {string}
     */
    sanitizeUrl(url) {
        if (!url) return '';
        try {
            const parsed = new URL(url);
            // Protocolos permitidos
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
            return url;
        } catch (e) {
            console.error('⚠️ URL de Cocona no válida para saneamiento:', url);
            return '';
        }
    },

    /**
     * Inyecta el HTML del reproductor en el contenedor base (Búnker).
     */
    init() {
        const modal = document.getElementById('player-modal');
        if (!modal) {
            console.error('❌ Búnker player-modal no encontrado en index.html.');
            return;
        }

        // Si ya tiene contenido (ya fue inyectado), no lo duplicamos
        if (document.getElementById('close-player')) return;

        modal.innerHTML = `
            <div id="close-player" class="player-close">&times;</div>
            <div id="admin-player-toolbar" style="display:none; position:absolute; top:65px; left:20px; z-index:9999; gap: 10px; flex-wrap: wrap;">
                <button id="admin-delete-player-btn" style="background:#e74c3c; color:white; border:none; padding:8px 15px; border-radius:8px; cursor:pointer; font-weight:bold; box-shadow:0 4px 10px rgba(0,0,0,0.5); font-size: 11px;">🗑️ Ocultar/Borrar</button>
                <button id="admin-approve-player-btn" style="display:none; background:#2ecc71; color:black; border:none; padding:8px 15px; border-radius:8px; cursor:pointer; font-weight:bold; box-shadow:0 4px 10px rgba(0,0,0,0.5); font-size: 11px;">✅ Aprobar a la Selva</button>
            </div>
            <div class="video-layout">
                <div class="video-container">
                    <div id="player-loader" class="loader-overlay">
                        <div class="loader-logo">SELVAFLIX</div>
                        <div class="loader-text">Explorando la selva...</div>
                        <div class="spinner-tropical"></div>
                    </div>
                    <iframe id="player-iframe" src="" style="display:none;" 
                        allow="autoplay"
                        allowfullscreen>
                    </iframe>
                    <div id="native-player-container" style="display:none; width: 100%; height: 100%; position: relative;">
                        <video id="native-video-player" style="width: 100%; height: 100%; background: #000;" controls playsinline webkit-playsinline></video>
                    </div>
                    
                    <div id="webtorrent-status" style="display:none; position:absolute; bottom:20px; left:20px; background:rgba(0,0,0,0.8); padding:10px; border-radius:8px; color:#fff; font-size:12px; z-index:100; border: 1px solid var(--primary);">
                        <div style="color:var(--primary); font-weight:bold; margin-bottom:5px;">🕸️ Conectando a la red P2P...</div>
                        <div id="wt-progress">Buscando semillas...</div>
                    </div>

                    <!-- Panel de Información Inicial (Directo) -->
                    <div id="player-start-screen" class="player-start-screen" style="display:none;">
                        <div class="start-bg" id="start-bg"></div>
                        <div class="start-content">
                            <div class="start-poster-container">
                                <img id="start-poster-img" src="" alt="Poster">
                            </div>
                            <div class="start-info">
                                <h2 id="start-title">CARGANDO...</h2>
                                <div class="start-meta">
                                    <span id="start-year" class="start-meta-badge" style="display:none;"></span>
                                    <span id="start-rating" class="start-meta-badge" style="display:none;"></span>
                                </div>
                                <div id="start-overview" class="start-overview"></div>
                                <div id="vip-status-msg" class="start-subtitle">🔍 Buscando señales VIP...</div>
                                <div class="start-actions" style="margin-top:20px; display:none;" id="start-actions">
                                    <button id="start-play-btn" class="play-btn-premium" onclick="SelvaStream.playFirstAvailable()">
                                        <span class="play-icon">▶</span> REPRODUCIR AHORA
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>
                <div class="player-sidebar-column">
                    <div class="sidebar-top-row" style="display: flex; gap: 10px; margin-bottom: 10px;">
                        <button id="floating-sources-btn" class="sources-btn-modern" onclick="SelvaStream.toggleVipMenu()" style="flex: 1; min-height: 45px;">
                             📡 OTRAS FUENTES VIP
                        </button>
                        <div id="side-vip-menu" class="side-vip-menu">
                            <div class="vip-menu-header">
                                <span>🚀 FUENTES VIP</span>
                                <button onclick="SelvaStream.toggleVipMenu()" style="background:rgba(231,76,60,0.2); border:1px solid #e74c3c; color:white; border-radius:50%; width:30px; height:30px; display:flex; align-items:center; justify-content:center; cursor:pointer;">&times;</button>
                            </div>
                            <div id="vip-menu-list"></div>
                        </div>
                    </div>

                    <div class="guide-sidebar-grid">
                        <div class="sidebar-card notifications-card">
                            <h3>📌 NOTIFICACIONES</h3>
                            <div id="player-notifications" class="player-notifications">
                                <p>Disfruta de la mejor calidad VIP en SelvaFlix.</p>
                            </div>
                        </div>
                        <div class="sidebar-card actions-card">
                            <h3>🛠️ ACCIONES</h3>
                            <button id="report-broken-btn" style="width:100%; height: auto; background: rgba(231,76,60,0.15); border: 1px solid rgba(231,76,60,0.3); color: #E74C3C; padding: 10px; border-radius: 8px; font-size: 0.65rem; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px;">🚨 REPORTE</button>
                            
                            <a id="external-player-btn" href="#" target="_blank" style="display:none; align-items:center; justify-content:center; gap:8px; background: linear-gradient(135deg, #e67e22, #d35400); color:white; padding:10px; border-radius: 8px; text-decoration:none; font-weight:bold; margin-top:10px; font-size:0.65rem; box-shadow: 0 4px 10px rgba(0,0,0,0.3);">
                                🎬 ABRIR EN VLC
                            </a>

                            <div class="sidebar-ad-space" style="margin-top: 8px;">
                                <span>🔥 SelvaFlix VIP</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <!-- Controles y Servidores -->
            <div id="player-controls-root"></div>
        `;

        // Eventos básicos
        document.getElementById('close-player')?.addEventListener('click', () => this.close());

        document.getElementById('admin-delete-player-btn')?.addEventListener('click', () => {
            if (window.deleteMovie && this.currentPlayerMovie) {
                const id = this.currentPlayerMovie.id;
                let hasNext = window.playNextReview ? window.playNextReview(id) : false;
                window.deleteMovie(id);
                if (!hasNext) this.close();
            }
        });

        document.getElementById('admin-approve-player-btn')?.addEventListener('click', () => {
            if (window.approveMovie && this.currentPlayerMovie) {
                const id = this.currentPlayerMovie.id;
                let hasNext = window.playNextReview ? window.playNextReview(id) : false;
                window.approveMovie(id);
                if (!hasNext) this.close();
            }
        });

        document.getElementById('report-broken-btn')?.addEventListener('click', () => {
            if (window.reportBrokenLink && this.currentPlayerMovie) {
                window.reportBrokenLink(this.currentPlayerMovie.id, this.currentPlayerMovie.title);
            }
        });
        if (!document.getElementById('selva-player-css')) {
            const style = document.createElement('style');
            style.id = 'selva-player-css';
            style.innerHTML = `
                .player-start-screen {
                    position: absolute; top:0; left:0; width:100%; height:100%;
                    z-index: 200; display: flex; align-items: center; justify-content: center;
                    background: #000; overflow: hidden;
                }
                .start-bg {
                    position: absolute; top:0; left:0; width:100%; height:100%;
                    background-size: cover; background-position: center;
                    filter: blur(20px) brightness(0.3); opacity: 0.6;
                    transform: scale(1.1);
                }
                .start-content {
                    position: relative; z-index: 10; text-align: center; color: white;
                    animation: fadeIn 0.8s ease-out;
                }
                .start-content h2 { font-size: 1.8rem; text-shadow: 0 4px 15px rgba(0,0,0,0.9); margin-bottom: 20px; font-weight: 800; padding: 0 20px; }
                .start-play-btn {
                    margin: 0 auto;
                    background: var(--primary); color: black; border: none;
                    padding: 15px 40px; border-radius: 60px; font-size: 1.1rem;
                    font-weight: 900; cursor: pointer; display: flex; align-items: center; gap: 10px;
                    transition: all 0.3s;
                    box-shadow: 0 10px 30px rgba(255,122,0,0.4);
                }
                @media (max-width: 600px) {
                    .start-content h2 { font-size: 1.3rem; }
                    .start-play-btn { padding: 12px 30px; font-size: 1rem; }
                }
                .start-play-btn:hover { transform: scale(1.05); box-shadow: 0 0 50px rgba(255,122,0,0.8); }
                .play-icon { font-size: 1.3rem; }
                .start-subtitle { margin-top: 12px; font-size: 0.75rem; opacity: 0.7; letter-spacing: 1.5px; }

                .guide-sidebar { width: 140px !important; min-width: 140px !important; flex-shrink: 0; font-size: 10px; }
                .video-container { flex: 1; }

                .vip-badge { background: #2ecc71; color: black; padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-left: 5px; }
                .latino-badge { background: var(--primary); color: black; padding: 2px 6px; border-radius: 4px; font-size: 10px; margin-left: 5px; }
                
                /* Floating VIP Menu */
                .floating-sources-btn {
                    position: absolute; bottom: 80px; right: 20px; z-index: 250;
                    background: rgba(0,0,0,0.8); color: var(--primary); border: 1px solid var(--primary);
                    padding: 8px 15px; border-radius: 20px; font-weight: 800; font-size: 11px;
                    cursor: pointer; transition: all 0.3s;
                }
                .floating-sources-btn:hover { background: var(--primary); color: black; }
                
                .side-vip-menu {
                    position: absolute; top: 0; right: -300px; width: 300px; height: 100%;
                    background: rgba(10,10,10,0.95); backdrop-filter: blur(20px);
                    z-index: 10005; transition: right 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                    border-left: 1px solid #333; padding: 85px 20px 20px 20px; overflow-y: auto;
                }
                .side-vip-menu.active { right: 0; }
                .vip-menu-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; color: var(--primary); font-weight: 800; border-bottom: 1px solid #333; padding-bottom: 10px; }
                .vip-menu-header button { background: none; border: none; color: white; font-size: 24px; cursor: pointer; }

                .compact-sidebar { width: 180px !important; font-size: 11px; }
                .sidebar-ad-space { margin-top: auto; background: rgba(255,122,0,0.1); border: 1px dashed var(--primary); padding: 10px; text-align: center; border-radius: 8px; font-weight: bold; font-size: 10px; color: var(--primary); }

                @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

                .series-selectors {
                    background: rgba(255,255,255,0.03);
                    border: 1px solid rgba(255,255,255,0.08);
                    border-radius: 18px;
                    padding: 15px;
                    margin-bottom: 20px;
                    display: flex;
                    gap: 15px;
                    backdrop-filter: blur(10px);
                }
                .selva-select-wrapper {
                    flex: 1;
                    position: relative;
                }
                .selva-select-wrapper label {
                    font-size: 10px;
                    color: var(--primary);
                    font-weight: 900;
                    text-transform: uppercase;
                    letter-spacing: 1.5px;
                    margin-bottom: 8px;
                    display: block;
                    opacity: 0.8;
                }
                .selva-custom-select {
                    width: 100%;
                    background: #0a0a0a;
                    color: #fff;
                    border: 1px solid #333;
                    padding: 12px 15px;
                    border-radius: 12px;
                    font-size: 14px;
                    font-weight: 600;
                    outline: none;
                    cursor: pointer;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    appearance: none;
                    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23FF7A00' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
                    background-repeat: no-repeat;
                    background-position: right 12px center;
                    background-size: 18px;
                }
                .selva-custom-select:hover {
                    border-color: var(--primary);
                    box-shadow: 0 0 15px rgba(255,122,0,0.2);
                    transform: translateY(-2px);
                }
                .selva-custom-select:focus {
                    border-color: var(--primary);
                }
            `;
            document.head.appendChild(style);
        }
        // El Spinner se apaga cuando el iframe carga
        const iframe = document.getElementById('player-iframe');
        if (iframe) {
            iframe.onload = () => {
                const loader = document.getElementById('player-loader');
                if (loader) {
                    loader.style.opacity = '0';
                    setTimeout(() => loader.style.display = 'none', 500);
                }

                // Intento heurístico de detección de errores por Cross-Origin (Si el iframe está en blanco por bloqueo)
                try {
                    // Si el servidor se niega a conectar por sandbox/x-frame-options, el título interno o el body estarán vacíos
                    // Muchos navegadores modernos bloquean directamente el acceso y lanzan una DOMException
                    // Atrapamos la DOMException en el catch como indicador de que el iframe CARGÓ, pero de un origen externo exitoso.
                    // Si el iframe está "en blanco" por bloqueo del navegador (CORS/Sandbox estricto en la misma ventana), a veces no lanza error sino que queda accesible pero vacío.
                    const iframeWindow = iframe.contentWindow;
                    if (iframeWindow && iframeWindow.document && iframe.style.display !== 'none' && iframeWindow.document.body.innerHTML.length < 50) {
                        // Sospechoso de bloqueo de Sandbox.
                        this.handlePlayerError();
                    }
                } catch (error) {
                    // DOMException por Cross-Origin significa que el sitio externo cargó correctamente y protegió su DOM.
                    // Esto es lo que queremos que pase. Significa que hay contenido.
                }
            };

            // OnError nativo (Rara vez dispara para iframes cors, pero es bueno tenerlo)
            iframe.onerror = () => {
                this.handlePlayerError();
            };
        }
    },

    // Rescate de emergencia temporalmente desactivado para depuración de pantalla negra
    handlePlayerError() {
        console.warn("⚠️ Servidor bloqueado u hostil detectado. Análisis nativo (Fallback desactivado).");
        // const activeBtn = document.querySelector('.server-btn.active');
        // const currentServer = activeBtn ? activeBtn.dataset.server : '';

        // Si falló el PRO (5) o S1, saltamos directo al confiable Streamwish (S2)
        // if (currentServer === 'latino-5' || currentServer === 'latino-1') {
        //     const s = document.getElementById('selva-season')?.value || 1;
        //     const e = document.getElementById('selva-episode')?.value || 1;
        //     console.log("🔄 Saltando automáticamente al Servidor 2 (Respaldo)");

        //     if (activeBtn) {
        //         activeBtn.innerText = "⏳ Vuelve en 1h";
        //         activeBtn.style.background = "rgba(231, 76, 60, 0.4)";
        //         activeBtn.style.borderColor = "#c0392b";
        //     }

        //     this.updateServer('latino-2', s, e);
        // }
    },
    /**
     * Abre el reproductor con el contenido seleccionado.
     */
    // Abre el reproductor con el contenido seleccionado.
    /**
     * Abre el reproductor con el contenido seleccionado.
     */
    async open(movie) {
        this.currentPlayerMovie = movie;
        this.init();
        const modal = document.getElementById('player-modal');
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';

        // Check if Admin
        const isAdmin = sessionStorage.getItem('selva_admin_active');
        const adminToolbar = document.getElementById('admin-player-toolbar');
        const adminAppBtn = document.getElementById('admin-approve-player-btn');
        
        if (adminToolbar) adminToolbar.style.display = isAdmin ? 'flex' : 'none';
        if (adminAppBtn) adminAppBtn.style.display = (isAdmin && movie.status === 'review') ? 'block' : 'none';

        // Reset elements
        const iframe = document.getElementById('player-iframe');
        const nativeContainer = document.getElementById('native-player-container');
        const nativePlayer = document.getElementById('native-video-player');
        const statusDiv = document.getElementById('webtorrent-status');
        const loader = document.getElementById('player-loader');
        const startScreen = document.getElementById('player-start-screen');

        if (iframe) iframe.style.display = 'none';
        if (nativeContainer) nativeContainer.style.display = 'none';
        if (nativePlayer) nativePlayer.pause();
        if (loader) loader.style.display = 'none';

        const dynamicSources = document.getElementById('vip-dynamic-container');
        if (dynamicSources) dynamicSources.style.display = 'none';

        // Mostrar Start Screen
        if (startScreen) {
            startScreen.style.display = 'flex';
            document.getElementById('start-title').innerText = movie.title || movie.name || 'Cargando...';
            const bg = document.getElementById('start-bg');
            
            const poster = movie.img || movie.poster_path || '';
            // TMDB URLs: use w500 for poster, original for blurred background
            let finalImg = poster;
            if (poster && !poster.startsWith('http')) {
                finalImg = `https://image.tmdb.org/t/p/w500${poster}`;
            }
            const bgImg = poster && !poster.startsWith('http') ? `https://image.tmdb.org/t/p/original${poster}` : finalImg;
            
            if (bg) bg.style.backgroundImage = `url(${bgImg})`;
            
            const startPoster = document.getElementById('start-poster-img');
            if (startPoster) {
                startPoster.src = poster ? finalImg : 'https://via.placeholder.com/500x750?text=SelvaFlix';
            }
            
            const startYear = document.getElementById('start-year');
            const startRating = document.getElementById('start-rating');
            const startOverview = document.getElementById('start-overview');
            
            if (startYear) {
                const year = movie.year || (movie.release_date || movie.first_air_date || '').split('-')[0];
                if (year) {
                    startYear.innerText = year;
                    startYear.style.display = 'inline-block';
                } else {
                    startYear.style.display = 'none';
                }
            }
            
            if (startRating) {
                if (movie.vote_average) {
                    startRating.innerText = `⭐ ${parseFloat(movie.vote_average).toFixed(1)}`;
                    startRating.style.display = 'inline-block';
                } else {
                    startRating.style.display = 'none';
                }
            }
            
            if (startOverview) {
                startOverview.innerText = movie.overview || '';
            }
            
            const msgEl = document.getElementById('vip-status-msg');
            if (msgEl) msgEl.innerHTML = '🔍 Buscando señales VIP...';

            const startActions = document.getElementById('start-actions');
            if (startActions) startActions.style.display = 'none';
        }

        // Si hay link manual de Admin, mostrar badge VIP
        if (movie.embed) {
            console.log("💎 Detectado Link de Admin (Prioridad Total)");
        }

        this.renderControls();

        // Si es serie, cargar metadatos de TMDB para temporadas
        const isSeries = ['series', 'tv', 'anime'].includes(movie.type);
        if (isSeries && movie.tmdbId) {
            await this.loadSeriesMetadata(movie.tmdbId);
        }

        // ✅ AUTO-SCAN: Al abrir, buscar fuentes VIP inmediatamente sin click extra
        const id = movie.imdbId || movie.tmdbId;
        const type = movie.type === 'series' ? 'series' : 'movie';
        if (id) this.loadDebridAuto(id, type);
    },

    async loadSeriesMetadata(tmdbId) {
        try {
            const TMDB_API_KEY = '15d2ea6d0dc1d476efbca3eba2b9bbfb';
            const TMDB_URL = 'https://api.themoviedb.org/3';

            const resp = await fetch(`${TMDB_URL}/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=es-PE`);
            const details = await resp.json();

            const sSel = document.getElementById('selva-season');
            const eSel = document.getElementById('selva-episode');

            if (details.seasons && sSel && eSel) {
                sSel.innerHTML = details.seasons
                    .filter(s => s.season_number > 0)
                    .map(s => `<option value="${s.season_number}">${s.name || `Temp ${s.season_number}`}</option>`).join('');

                const updateE = (sNum) => {
                    const s = details.seasons.find(x => x.season_number == sNum);
                    const count = s ? s.episode_count : 24;
                    eSel.innerHTML = Array.from({ length: count }, (_, i) => `<option value="${i + 1}">Capítulo ${i + 1}</option>`).join('');
                };

                updateE(details.seasons.find(s => s.season_number > 0)?.season_number || 1);

                sSel.onchange = () => {
                    updateE(sSel.value);
                    this.updateFromSelectors();
                };
                eSel.onchange = () => this.updateFromSelectors();
            }
        } catch (e) {
            console.error('❌ Error cargando info de serie:', e);
        }
    },

    updateFromSelectors() {
        const s = document.getElementById('selva-season')?.value || 1;
        const e = document.getElementById('selva-episode')?.value || 1;
        const activeBtn = document.querySelector('.server-btn.active');
        const server = activeBtn ? activeBtn.dataset.server : (localStorage.getItem('selva_pref_lang') === 'english' ? 'english-1' : 'latino-1');
        this.updateServer(server, s, e);
    },

    loadInitialSource() {
        // Obsoleto: Ahora se maneja vía Start Screen -> loadDebridAuto
    },

    updateServer(serverKey, season = 1, episode = 1) {
        const loader = document.getElementById('player-loader');
        if (!loader) return;

        const startScreen = document.getElementById('player-start-screen');
        if (startScreen) startScreen.style.display = 'none';

        loader.style.display = 'flex';
        loader.style.opacity = '1';

        // ✅ SERVIDORES CLÁSICOS ELIMINADOS (Premium Only)
        loader.innerHTML = `
            <div class="loader-logo">SOLO VIP</div>
            <div class="loader-text">Los servidores con publicidad fueron eliminados para tu seguridad.</div>
            <button onclick="SelvaStream.loadDebridAuto()" style="margin-top:20px; background:var(--primary); color:black; border:none; padding:10px 20px; border-radius:10px; font-weight:bold; cursor:pointer;">REPRODUCIR VIP</button>
        `;
    },

    setPreference(lang) {
        localStorage.setItem('selva_pref_lang', lang);
        const s = document.getElementById('selva-season')?.value || 1;
        const e = document.getElementById('selva-episode')?.value || 1;

        // Re-cargar el servidor actual con la nueva preferencia de idioma
        const activeBtn = document.querySelector('.server-btn.active');
        const currentServer = activeBtn ? activeBtn.dataset.server : 'latino-1';

        this.updateServer(currentServer, s, e);
        this.renderControls();
    },

    updateDownloadBtn(url) {
        const btn = document.getElementById('selva-download-btn');
        if (!btn) return;

        const isDirectFile = /\.(mp4|mkv|avi|webm|mov|m3u8)(\?.*)?$/i.test(url);
        if (isDirectFile) {
            btn.href = url;
            btn.setAttribute('download', this.currentPlayerMovie.title || 'video');
            btn.innerHTML = '⬇️ Descargar';
            btn.style.display = 'inline-flex';
        } else if (url) {
            btn.href = url;
            btn.removeAttribute('download');
            btn.innerHTML = '🔗 Abrir Link';
            btn.style.display = 'inline-flex';
        } else {
            btn.style.display = 'none';
        }
    },

    refreshState() {
        const s = document.getElementById('selva-season')?.value || 1;
        const e = document.getElementById('selva-episode')?.value || 1;
        this.renderControls();
    },

    toggleVipMenu() {
        const menu = document.getElementById('side-vip-menu');
        if (menu) menu.classList.toggle('active');
        // Solo actualiza la lista VIP, no re-dibuja los controles completos
        this.renderVipMenuList();
    },

    // Rellena el menú lateral VIP sin tocar el resto del DOM
    renderVipMenuList() {
        const vipMenuList = document.getElementById('vip-menu-list');
        const floatingBtn = document.getElementById('floating-sources-btn');
        
        if (this.lastScrapedStreams.length > 0) {
            if (floatingBtn) {
                floatingBtn.innerHTML = `✅ ${this.lastScrapedStreams.length} FUENTES VIP ▾`;
            }
            if (vipMenuList) {
                vipMenuList.innerHTML = this.lastScrapedStreams.map((s, index) => {
                    const qRaw = (s.title + ' ' + s.name).toLowerCase();
                    
                    // 📊 DETECCIóN DE CALIDAD
                    const quality = qRaw.includes('4k') || qRaw.includes('uhd') ? '4K UHD' : (qRaw.includes('1080') ? '1080p FHD' : (qRaw.includes('720') ? '720p HD' : 'HD'));
                    
                    // 🛡️ STATUS VIP / DEBRID
                    const isDebrid = s.name.toLowerCase().includes('[rd+]') || s.name.toLowerCase().includes('debrid') || s.title.toLowerCase().includes('[rd+]');
                    
                    // 🌍 IDIOMAS Y BANDERAS
                    const isLatino = qRaw.includes('latino') || qRaw.includes('latin') || qRaw.includes('cinecalidad') || qRaw.includes('dual');
                    const isCastellano = qRaw.includes('castellano') || qRaw.includes('espana') || qRaw.includes('españa') || qRaw.includes('spanish');
                    const isEnglish = qRaw.includes('english') || qRaw.includes('subbed');
                    
                    let langLabel = 'MULTI';
                    if (isLatino) langLabel = '🇲🇽 LATINO';
                    else if (isCastellano) langLabel = '🇪🇸 CASTELLANO';
                    else if (isEnglish) langLabel = '🇺🇸 INGLES';

                    // 📦 FORMATO Y PESO (Refactorizado con Deep Scan)
                    const formatMatch = qRaw.match(/\.(mkv|mp4|m3u8|avi|ts)/i);
                    const fileFormat = s.detectedFormat || (formatMatch ? formatMatch[1].toUpperCase() : 'VIDEO');
                    
                    const weightMatch = qRaw.match(/(\d+(\.\d+)?\s*(gb|mb))/i);
                    const weight = s.detectedWeight || (weightMatch ? weightMatch[0].toUpperCase() : '');

                    // ⚙️ MODO ADMIN: Botón para coronar fuente
                    const isAdmin = sessionStorage.getItem('selva_admin_active');
                    const movieRef = this.currentPlayerMovie || {};
                    const isSuggested = movieRef.suggestedVipHash && s.infoHash === movieRef.suggestedVipHash;
                    // Escape de comillas para evitar romper el atributo onclick
                    const safeTitle = (s.title || '').replace(/'/g, "").replace(/"/g, ""); // Limpieza total para el confirm
                    const crownBtn = isAdmin ? `
                        <button class="crown-btn" 
                                onclick="console.log('👑 Click Corona v2.17'); event.stopPropagation(); window.selvaExecuteCrownPromotion('${movieRef.id}', '${s.infoHash}')" 
                                style="position:absolute; bottom:12px; left:12px; background:rgba(0,0,0,0.6); border:1.5px solid #FF7A00; color:#FF7A00; border-radius:50%; width:38px; height:38px; display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:9999; font-size:1.2rem; box-shadow:0 0 15px rgba(255,122,0,0.4); transition: all 0.2s;" 
                                onmouseover="this.style.transform='scale(1.2)';" onmouseout="this.style.transform='scale(1)';"
                                title="Coronar esta fuente">
                            👑
                        </button>
                    ` : '';

                    return `
                        <div class="stream-card-vip" onclick='if(event.target.closest(".crown-btn")) return; SelvaStream.toggleVipMenu(); SelvaStream.handleExternalStream(${JSON.stringify(s).replace(/'/g, "&#39;")})'  
                                style="background: ${isSuggested ? 'rgba(255,122,0,0.1)' : 'rgba(255,122,0,0.05)'}; border: 1px solid ${isSuggested ? '#FF7A00' : 'rgba(255,122,0,0.15)'}; border-radius: 12px; padding: 15px; cursor: pointer; transition: all 0.2s ease; border-left: 4px solid ${isSuggested ? '#FF7A00' : (isDebrid ? '#FF7A00' : '#2ECC71')}; position: relative; overflow: hidden; text-align:left; margin-bottom:10px;">
                            ${isSuggested ? `<div style="position:absolute; top:-10px; right:-25px; background:#FF7A00; color:white; padding:15px 30px; transform:rotate(45deg); font-size:0.55rem; font-weight:900; letter-spacing:1px; z-index:10; pointer-events:none;">👑 SUGERIDA</div>` : (index === 0 ? `<div style="position:absolute; top:-10px; right:-25px; background:#FF7A00; color:white; padding:15px 30px; transform:rotate(45deg); font-size:0.5rem; font-weight:900; letter-spacing:1px; z-index:10; pointer-events:none;">EL MEJOR</div>` : '')}
                            ${crownBtn}
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <div style="font-size:0.65rem; font-weight:900; color:${isDebrid ? '#FF7A00' : '#2ECC71'}; text-transform:uppercase; letter-spacing:1px; display:flex; align-items:center; gap:5px; margin-bottom:2px;">
                                    ${s.providerName || 'PREMIUM'} • ${langLabel}
                                </div>
                                <div style="color:white; font-size:0.82rem; font-weight:700; line-height:1.3; margin:2px 0; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;">
                                    ${s.title.split('\n')[0]}
                                </div>
                                <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:5px;">
                                    <span style="background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; font-size:0.55rem; color:#fff; font-weight:900;">${quality}</span>
                                    <span style="background:rgba(46,204,113,0.1); padding:2px 6px; border-radius:4px; font-size:0.55rem; color:#2ecc71; font-weight:700; border:1px solid rgba(46,204,113,0.2);">${fileFormat}</span>
                                    ${s.detectedVideoCodec ? `<span style="background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; font-size:0.55rem; color:#fff; font-weight:700;">${s.detectedVideoCodec}</span>` : ''}
                                    ${s.detectedAudioCodec ? `<span style="background:rgba(52,152,219,0.1); padding:2px 6px; border-radius:4px; font-size:0.55rem; color:#3498db; font-weight:700;">🎵 ${s.detectedAudioCodec}</span>` : ''}
                                    ${weight ? `<span style="font-size:0.6rem; color:#bbb; font-weight:500;">⚖️ ${weight}</span>` : ''}
                                    ${isDebrid ? '<span style="color:#FF7A00; font-size:0.55rem; font-weight:900; border:1px solid #FF7A00; padding:1px 4px; border-radius:3px;">REAL-DEBRID</span>' : ''}
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        } else {
            if (vipMenuList) {
                vipMenuList.innerHTML = '<p style="text-align:center; opacity:0.5; font-size:12px; margin-top:20px;">Explorando la selva para encontrar fuentes...</p>';
            }
        }
    },

    renderControls() {
        const root = document.getElementById('player-controls-root');
        if (!root) return;
        // Actualizar lista VIP también
        this.renderVipMenuList();

        const isSeries = ['series', 'tv', 'anime'].includes(this.currentPlayerMovie?.type);
        const seasonHtml = isSeries ? `
            <div class="series-selectors">
                <div class="selva-select-wrapper">
                    <label>Temporada</label>
                    <select id="selva-season" class="selva-custom-select"></select>
                </div>
                <div class="selva-select-wrapper">
                    <label>Episodio</label>
                    <select id="selva-episode" class="selva-custom-select"></select>
                </div>
            </div>
        ` : '';

        root.innerHTML = `
            <div class="player-controls" style="margin-top: 20px;">
                ${seasonHtml}
            </div>
        `;
    },

    close() {
        const modal = document.getElementById('player-modal');
        const iframe = document.getElementById('player-iframe');
        const nativePlayer = document.getElementById('native-video-player');
        const statusDiv = document.getElementById('webtorrent-status');

        if (modal) modal.style.display = 'none';
        if (iframe) iframe.src = '';

        if (nativePlayer) {
            nativePlayer.pause();
            nativePlayer.removeAttribute('src');
            nativePlayer.load();
        }

        if (statusDiv) statusDiv.style.display = 'none';

        const dynamicSources = document.getElementById('vip-dynamic-container');
        if (dynamicSources) dynamicSources.style.display = 'none';

        if (statusDiv) statusDiv.style.display = 'none';

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }

        if (this.torrentClient) {
            try {
                this.torrentClient.destroy();
            } catch (e) { }
            this.torrentClient = null;
        }

        document.body.style.overflow = ''; // Restaurar scroll
    },

    async loadDebridAuto(id, type) {
        // Detener reproductores actuales para forzar la carga Debrid
        const startScreen = document.getElementById('player-start-screen');
        const iframe = document.getElementById('player-iframe');
        const loader = document.getElementById('player-loader');
        const statusDiv = document.getElementById('webtorrent-status');
        const nativeContainer = document.getElementById('native-player-container');
        const nativePlayer = document.getElementById('native-video-player');

        if (startScreen) startScreen.style.display = 'none';
        if (iframe) iframe.style.display = 'none';
        if (loader) {
            loader.style.display = 'flex';
            loader.style.opacity = '1';
        }
        if (statusDiv) statusDiv.style.display = 'none';
        if (nativeContainer) nativeContainer.style.display = 'none';
        if (nativePlayer) nativePlayer.pause();


        const movie = this.currentPlayerMovie;

        // PRIORIDAD 1: Link Manual de Administrador (Vía Panel Admin)
        if (movie && movie.embed && (movie.embed.startsWith('http') || movie.embed.includes('<iframe'))) {
            const isDirect = movie.embed.endsWith('.mp4') || movie.embed.endsWith('.m3u8') || movie.embed.endsWith('.mkv');
            console.log("💎 Usando Link Manual (Prioridad Admin)");
            this.handleExternalStream({
                url: movie.embed,
                name: '[DIRECCIÓN VIP]',
                title: movie.title || 'Carga Directa',
                providerName: 'Admin'
            });
            return;
        }

        const loaderText = document.querySelector('.loader-text');
        if (loaderText) loaderText.innerText = '🚀 Invocando Auto-VIP Debrid...';

        try {
            const providers = "cinecalidad,mejortorrent,wolfmax4k,yts,1337x,torrent9,limetorrents,eztv,rarbg";
            const tConfig = `providers=${providers}|sort=seeders|qualityfilter=scr,cam`;

            const urls = [
                `https://torrentio.strem.fun/${tConfig}/stream/${type}/${id}.json`,
                `https://comet.strem.fun/stream/${type}/${id}.json`
            ];

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 9000); // 9s para conexiones lentas de celular

            const responses = await Promise.allSettled(urls.map(u =>
                fetch(u, { signal: controller.signal }).then(r => r.json())
            ));
            clearTimeout(timeoutId);

            let allStreams = [];
            responses.forEach((res, i) => {
                if (res.status === 'fulfilled' && res.value && res.value.streams) {
                    res.value.streams.forEach(s => s.providerName = i === 0 ? "T-IO" : "COMET");
                    allStreams = allStreams.concat(res.value.streams);
                }
            });

            // --- 🕵️‍♂️ PRE-PROCESAMIENTO Y SCORING INTELIGENTE ---
            let streams = [];
            allStreams.forEach(s => {
                const qRaw = ((s.title || '') + ' ' + (s.name || '')).toLowerCase();
                const url = (s.url || '').toLowerCase();

                // 0. Filtro Básico "No admitidos"
                if (qRaw.includes('dublado') || qRaw.includes('legendado') || qRaw.includes('português') || qRaw.includes('pt-br') || qRaw.includes('hindi') || qRaw.includes('tamil')) return;
                
                const isDirect = url.includes('.m3u8') || url.includes('.mp4') || url.includes('.mkv') || url.includes('.webm') || qRaw.includes('[rd+]');
                if (!s.infoHash && !isDirect) return; // Filtro de seguridad VIP

                // 1. Detección Profunda de Formato (Título -> URL)
                let extMatch = qRaw.match(/\.(mkv|mp4|m3u8|avi|ts|webm)/i);
                if (!extMatch) extMatch = url.match(/\.(mkv|mp4|m3u8|avi|ts|webm)/i);
                s.detectedFormat = extMatch ? extMatch[1].toUpperCase() : 'VIDEO';

                // 2. Detección y Cálculo de Peso
                const weightMatch = qRaw.match(/(\d+(\.\d+)?)\s*(gb|mb)/i);
                s.detectedWeight = weightMatch ? weightMatch[0].toUpperCase() : '';
                s.weightGB = 0;
                if (weightMatch) {
                   let val = parseFloat(weightMatch[1]);
                   if (weightMatch[3].toLowerCase() === 'mb') val = val / 1024;
                   s.weightGB = val;
                }

                // 3. Detección de Idioma (Lista Ampliada)
                const kwLat = ['latino', 'spanish', 'esp', 'español', 'castellano', 'cinecalidad', 'mx', 'pe', 'dual'];
                const isLat = kwLat.some(k => qRaw.includes(k));
                const isMulti = qRaw.includes('multi');
                
                // La Gran Purga (Falsos MULTI Europeos)
                const kwEurope = ['french', 'truefrench', 'ita', 'italian', 'ger', 'german', 'rus'];
                const isEuropean = kwEurope.some(k => qRaw.includes(k));
                const isEng = qRaw.includes('english') || qRaw.includes('subbed') || qRaw.includes('sub');

                // 3.5 Detección de Codecs (Audio y Video)
                if (qRaw.includes('264') || qRaw.includes('avc')) s.detectedVideoCodec = 'H264';
                else if (qRaw.includes('265') || qRaw.includes('hevc')) s.detectedVideoCodec = 'HEVC';
                
                if (qRaw.includes('aac') || qRaw.includes('mp3')) s.detectedAudioCodec = 'AAC';
                else if (qRaw.includes('ac3') || qRaw.includes('dts') || qRaw.includes('dd5') || qRaw.includes('truehd')) s.detectedAudioCodec = 'AC3';

                // 4. Sistema de Puntaje (Score) Equitable
                let score = 0;
                
                // 0. EL DEDO DE DIOS: Prioridad Absoluta Manual (Protegida)
                try {
                   const movieRef = this.currentPlayerMovie || {};
                   if (movieRef.suggestedVipHash && s.infoHash && s.infoHash === movieRef.suggestedVipHash) {
                       score += 10000; // El Rey de la Selva
                   }
                } catch(err) { /* Silenciar error para no trapar el loop */ }

                // A. Idioma (El Rey Absoluto)
                if (isLat) {
                    score += 500; // Corona
                } else if (isEuropean) {
                    score -= 500; // Purga letal
                } else if (isEng && !isMulti) {
                    score -= 200; // Penalizar Inglés Puro
                } else if (isMulti) {
                    score += 50; // Fallback decente
                }

                // B. VIP / Debrid
                if (qRaw.includes('[rd+]') || s.providerName === 'T-IO') score += 50;
                
                // C. Formato y Codecs (Amigabilidad iOS/Móvil)
                if (s.detectedFormat === 'MP4' || s.detectedFormat === 'M3U8') score += 50; 
                else if (s.detectedFormat === 'MKV') score += 5; 
                else if (s.detectedFormat === 'VIDEO') score -= 100; // Formatos sin audio/identidad -> Abajo

                if (s.detectedAudioCodec === 'AC3') score -= 50; // Riesgo mudo en iOS
                else if (s.detectedAudioCodec === 'AAC') score += 20;

                // D. Peso (Premia ligeros, castiga obesos)
                if (s.weightGB > 0) {
                    if (s.weightGB >= 1.5 && s.weightGB <= 4.5) score += 30; // Punto dulce
                    else if (s.weightGB > 10.0) score -= 150; // Obesidad extrema
                }
                
                // E. Resolución
                if (qRaw.includes('1080')) score += 10;
                else if (qRaw.includes('720')) score += 5;

                s.selvaScore = score;
                streams.push(s);
            });

            if (streams.length === 0) throw new Error("No hay semillas VIP válidas");

            // Ordenar de mayor a menor score
            streams.sort((a, b) => (b.selvaScore || 0) - (a.selvaScore || 0));

            this.lastScrapedStreams = streams;
            this.renderControls();

            // ✅ LISTA INMEDIATA: Mostrar fuentes directamente sin click
            const loader3 = document.getElementById('player-loader');
            if (loader3) loader3.style.display = 'none';
            const ss2 = document.getElementById('player-start-screen');
            if (ss2) ss2.style.display = 'flex';

            const msgEl = document.getElementById('vip-status-msg');
            if (msgEl) msgEl.textContent = `✅ ${streams.length} fuentes VIP encontradas. Revisa otras opciones:`;

            // Habilitar el botón de Play en la Start Screen
            const startActions = document.getElementById('start-actions');
            if (startActions) startActions.style.display = 'block';
        } catch (e) {
            console.error("Motor VIP falló:", e);
            const msgEl = document.getElementById('vip-status-msg');
            if (msgEl) msgEl.innerHTML = '<span style="color:#e74c3c;">⚠️ No se encontraron fuentes VIP. <button onclick="SelvaStream.loadDebridAuto()" style="background:var(--primary);color:black;border:none;padding:4px 10px;border-radius:6px;font-weight:bold;cursor:pointer;margin-left:6px;">Reintentar</button></span>';
        }
    },

    playFirstAvailable() {
        if (this.lastScrapedStreams && this.lastScrapedStreams.length > 0) {
            this.handleExternalStream(this.lastScrapedStreams[0]);
        } else {
            console.warn("No hay fuentes listas para reproducir automáticamente.");
            this.fetchExternalStreams();
        }
    },

    handleExternalStream(stream) {
        console.log("Cargando fuente externa:", stream);

        // Mapeo Heurístico (Analytics Local): Recordamos qué proveedor usamos
        localStorage.setItem(`last_source_${this.currentPlayerMovie.id}`, stream.providerName || 'Unknown');

        const iframe = document.getElementById('player-iframe');
        const nativePlayer = document.getElementById('native-video-player');
        
        // 🛠 TRUCO SELVAFLIX: Forzar el "desbloqueo" del reproductor en móviles 
        // tocándolo en el hilo exacto del click del usuario.
        nativePlayer.play().catch(() => {});
        nativePlayer.pause();
        
        const statusDiv = document.getElementById('webtorrent-status');
        const loader = document.getElementById('player-loader');

        // Ponemos el póster al reproductor nativo por si el Autoplay es bloqueado, no se vea todo negro
        const posterImg = document.getElementById('start-poster-img');
        if (posterImg && posterImg.src) {
            nativePlayer.setAttribute('poster', posterImg.src);
        }

        // OCULTAR INTERFAZ DE CARGA/INICIO PARA DAR PASO AL VIDEO
        const startScreen = document.getElementById('player-start-screen');
        if (startScreen) startScreen.style.display = 'none';

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }

        if (stream.url && !stream.infoHash) {
            // Es un link directo. Puede ser un Iframe o un Video MP4 / M3U8
            const isHls = stream.url.includes('.m3u8');
            const isDirectVideo = isHls || stream.url.endsWith('.mp4') || stream.url.endsWith('.mkv') || stream.name?.includes('[RD+]') || stream.title?.includes('[RD+]');

            if (isDirectVideo) {
                // Motor VIP de Real Debrid (Reproductor Nativo con URL directa)
                iframe.style.display = 'none';
                iframe.src = '';
                statusDiv.style.display = 'none';
                loader.style.display = 'none';

                nativePlayer.style.display = 'block';
                const nativeContainer = document.getElementById('native-player-container');
                if (nativeContainer) nativeContainer.style.display = 'block';

                if (isHls && typeof Hls !== 'undefined') {
                    if (Hls.isSupported()) {
                        this.hls = new Hls();
                        this.hls.loadSource(stream.url);
                        this.hls.attachMedia(nativePlayer);
                        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                            nativePlayer.play().catch(e => console.warn("Auto-play prevented", e));
                        });
                    } else if (nativePlayer.canPlayType('application/vnd.apple.mpegurl')) {
                        nativePlayer.src = stream.url;
                        nativePlayer.play().catch(e => console.warn("Auto-play prevented", e));
                    }
                } else {
                    nativePlayer.src = stream.url;
                    nativePlayer.play().catch(e => console.warn("Auto-play prevented", e));
                }

                // Si es un source directo, le pasamos la URL al botón externo
                const extBtn = document.getElementById('external-player-btn');
                if (extBtn) {
                    extBtn.style.display = 'flex';
                    const isAndroid = /Android/i.test(navigator.userAgent);
                    extBtn.href = isAndroid
                        ? `intent://${stream.url.replace(/^https?:\/\//, '')}#Intent;package=org.videolan.vlc;type=video/*;scheme=https;end`
                        : `vlc://${stream.url}`;
                }

                } else {
                    console.warn("🚫 Fuente de Terceros Bloqueada por Seguridad (Anti-Adware)");
                    const notif = document.getElementById('player-notifications');
                    if (notif) notif.innerHTML = '<p style="color: #E74C3C;">⚠️ Esta fuente no cumple el estándar de seguridad de SelvaFlix (Anti-Anuncios).</p>';
                }
        } else if (stream.infoHash) {
            // FASE 3: Motor VIP 🚀 
            iframe.style.display = 'none';
            iframe.src = '';

            const nativeContainer = document.getElementById('native-player-container');
            const extBtn2 = document.getElementById('external-player-btn');
            nativeContainer.style.display = 'none';
            statusDiv.style.display = 'none';
            if (extBtn2) extBtn2.style.display = 'none';

            // Limpiar player
            nativePlayer.pause();
            nativePlayer.removeAttribute('src');
            nativePlayer.load();

            // 🌴 ANIMACION DE CARGA CON FRASES ROTATIVAS
            loader.style.display = 'flex';
            const loaderLogo = loader.querySelector('.loader-logo');
            const loaderTextEl = loader.querySelector('.loader-text');
            if (loaderLogo) loaderLogo.innerText = '🌴';
            
            const frases = [
                'Buscando en la selva profunda...',
                'Negociando con el caiman VIP...',
                'Decodificando señal satelital...',
                'Convenciendo al piraña...',
                'Abriendo la bóveda de Cloudflare...',
                'Casi listo, preparando la pantalla...',
            ];
            let fraseIdx = 0;
            if (loaderTextEl) loaderTextEl.innerText = frases[0];
            const fraseInterval = setInterval(() => {
                fraseIdx = (fraseIdx + 1) % frases.length;
                if (loaderTextEl) loaderTextEl.innerText = frases[fraseIdx];
            }, 2000);

            this.callMasterWorker(stream.infoHash).then(result => {
                clearInterval(fraseInterval); // Detener animación
                if (loaderLogo) loaderLogo.innerText = 'SELVAFLIX';

                if (result && result.url) {
                    console.log("🚀 URL Liberada:", result.url);
                    
                    // Ocultar loader y start screen
                    if (startScreen) startScreen.style.display = 'none';
                    loader.style.display = 'none';

                    // Mostrar reproductor con URL lista
                    nativePlayer.src = result.url;
                    nativePlayer.style.display = 'block';
                    nativeContainer.style.display = 'block';

                    // ✅ SIN AUTOPLAY: mostrar instrucción clara al usuario
                    const notif = document.getElementById('player-notifications');
                    if (notif) notif.innerHTML = `
                        <div style="background: rgba(46,204,113,0.15); border: 1px solid #2ecc71; border-radius: 10px; padding: 10px; text-align:center;">
                            <div style="font-size: 1.5rem;">▶️</div>
                            <p style="color:#2ecc71; font-weight:bold; margin:4px 0;">¡Película lista!</p>
                            <p style="color:#ccc; font-size:0.75rem;">Toca el video de arriba para empezar.</p>
                        </div>`;

                    // Botón VLC de respaldo
                    const isAndroid = /Android/i.test(navigator.userAgent);
                    const extBtnFinal = document.getElementById('external-player-btn');
                    if (extBtnFinal) {
                        extBtnFinal.href = isAndroid
                            ? `intent://${result.url.replace(/^https?:\/\//, '')}#Intent;package=org.videolan.vlc;type=video/*;scheme=https;end`
                            : `vlc://${result.url}`;
                        extBtnFinal.style.display = 'flex';
                    }
                } else {
                    // Error: volver al start screen con mensaje claro + botón
                    loader.style.display = 'none';
                    if (startScreen) startScreen.style.display = 'flex';
                    const msgEl = document.getElementById('vip-status-msg');
                    if (msgEl) msgEl.innerHTML = `<span style="color:#e74c3c;">⚠️ No se pudo abrir esta fuente.</span>`;
                    const startActions = document.getElementById('start-actions');
                    if (startActions) {
                        startActions.style.display = 'block';
                        startActions.innerHTML = `
                            <button class="play-btn-premium" onclick="SelvaStream.toggleVipMenu()" style="background: linear-gradient(135deg,#e74c3c,#c0392b); margin-top:10px;">
                                📡 Elegir Otra Fuente VIP
                            </button>`;
                    }
                }
            }).catch(() => {
                clearInterval(fraseInterval);
                loader.style.display = 'none';
                if (startScreen) startScreen.style.display = 'flex';
                const msgEl = document.getElementById('vip-status-msg');
                if (msgEl) msgEl.innerHTML = `<span style="color:#e74c3c;">⚠️ Error de red. Revisa tu conexión.</span>`;
                const startActions = document.getElementById('start-actions');
                if (startActions) {
                    startActions.style.display = 'block';
                    startActions.innerHTML = `
                        <button class="play-btn-premium" onclick="SelvaStream.playFirstAvailable()" style="margin-top:10px;">
                            🔄 Reintentar
                        </button>
                        <button class="play-btn-premium" onclick="SelvaStream.toggleVipMenu()" style="background: linear-gradient(135deg,#8e44ad,#6c3483); margin-top:10px; margin-left:8px;">
                            📡 Otras Fuentes VIP
                        </button>`;
                }
            });
        }

    },




    async callMasterWorker(infoHash, attempt = 1) {
        try {
            const magnet = `magnet:?xt=urn:btih:${infoHash}`;
            const role = 'admin'; // Futuro: localStorage.getItem('user_role')

            const url = `${this.MASTER_WORKER_URL}/flix/unrestrict?magnet=${encodeURIComponent(magnet)}&role=${role}`;

            const res = await fetch(url, {
                headers: { 'x-selva-auth': this.AUTH_TOKEN }
            });

            if (!res.ok) throw new Error(`HTTP_${res.status}`);
            const data = await res.json();

            // 🚀 SYSTEMA AUTO-RETRY (Si Real-Debrid sigue descomprimiendo)
            if (data.status === 'waiting' && attempt <= 4) {
                console.log(`[Auto-Retry] Búnker procesando película... (Intento ${attempt}/4)`);
                const progressDiv = document.getElementById('wt-progress');
                if (progressDiv) progressDiv.innerText = `🥥 Extrayendo de la selva profunda... (Intento ${attempt}/4)`;

                // Esperar 2.5 segundos de gracia y preguntar de nuevo al servidor
                await new Promise(resolve => setTimeout(resolve, 2500));
                return this.callMasterWorker(infoHash, attempt + 1);
            }

            return data;
        } catch (error) {
            console.error('[Worker Connection Error]', error);
            return { error: error.message };
        }
    }
};

window.SelvaStream = SelvaStream;
