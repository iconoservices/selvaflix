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
    // ⚠️ EN DESUSO: worker + token solo los usa callMasterWorker (Real-Debrid),
    // que ya no se usa. Se conservan por si se reactiva Real-Debrid. No borrar.
    MASTER_WORKER_URL: 'https://icono-proxy.jnmcsky.workers.dev', // IconoServices Master Tunnel
    AUTH_TOKEN: import.meta.env.VITE_AUTH_TOKEN || localStorage.getItem('iconoservices_token') || '', // Token cargado desde Vercel (Seguridad)
    
    // 🔑 CREDENCIALES DE HOSTING (PPD)
    STREAMTAPE_LOGIN: import.meta.env.VITE_STREAMTAPE_LOGIN || '', 
    STREAMTAPE_KEY: import.meta.env.VITE_STREAMTAPE_KEY || '',
    DOODSTREAM_KEY: import.meta.env.VITE_DOODSTREAM_KEY || '',

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
        if (document.getElementById('player-back-btn')) return;

        modal.innerHTML = `
            <div class="player-back-arrow" id="player-back-btn" title="Atrás (Esc)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
            </div>

            <!-- Floating Top Controls (Fuentes y Selectores de Serie) -->
            <div id="player-top-controls" class="player-top-controls">
                <div id="player-controls-root"></div>
                <button id="floating-sources-btn" class="sources-btn-modern" onclick="SelvaStream.toggleVipMenu()">
                     📡 FUENTES VIP
                </button>
                <button id="player-expand-btn" class="sources-btn-modern" title="Pantalla completa"
                        onclick="SelvaStream.alternarPantalla()">⛶</button>
            </div>

            <!-- Sliding Fuentes Menu (Drawer) -->
            <div id="side-vip-menu" class="side-vip-menu">
                <div class="vip-menu-header">
                    <span>🚀 FUENTES DISPONIBLES</span>
                    <button onclick="SelvaStream.toggleVipMenu()" style="background:rgba(231,76,60,0.2); border:1px solid #e74c3c; color:white; border-radius:50%; width:30px; height:30px; display:flex; align-items:center; justify-content:center; cursor:pointer;">&times;</button>
                </div>
                <div id="vip-menu-list"></div>
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

                    <!-- Aviso: doble toque/clic sobre el video abre el reproductor
                         de pantalla completa del proveedor. Se muestra unos segundos
                         al abrir en AMBAS vistas (celular y escritorio). -->
                    <div id="fullscreen-hint" style="display:none; position:absolute; bottom:14px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.78); color:#fff; padding:7px 14px; border-radius:20px; font-size:11px; font-weight:700; z-index:120; white-space:nowrap; pointer-events:none; box-shadow:0 2px 10px rgba(0,0,0,0.5); transition:opacity 0.6s ease;"></div>

                    <!-- Start screen is kept hidden and serves only as fallback on severe errors -->
                    <div id="player-start-screen" class="player-start-screen" style="display:none;">
                        <div class="start-bg" id="start-bg"></div>
                        <div class="start-content">
                            <div class="start-info">
                                <h2 id="start-title">CARGANDO...</h2>
                                <div id="vip-status-msg" class="start-subtitle">🔍 Buscando señales VIP...</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.getElementById('player-back-btn')?.addEventListener('click', () => {
            window.closePlayer ? window.closePlayer() : history.back();
        });


        if (!document.getElementById('selva-player-css')) {
            const style = document.createElement('style');
            style.id = 'selva-player-css';
            style.innerHTML = `
                .player-start-screen {
                    position: absolute; top: var(--safe-top); left:0; width:100%; height: calc(100% - var(--safe-top));
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
                    box-shadow: 0 10px 30px rgba(255,102,0,0.4);
                }
                @media (max-width: 600px) {
                    .start-content h2 { font-size: 1.3rem; }
                    .start-play-btn { padding: 12px 30px; font-size: 1rem; }
                }
                .start-play-btn:hover { transform: scale(1.05); box-shadow: 0 0 50px rgba(255,102,0,0.8); }
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
                    padding: 8px 15px; border-radius: 4px; font-weight: 800; font-size: 11px;
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
                .sidebar-ad-space { margin-top: auto; background: rgba(255,102,0,0.1); border: 1px dashed var(--primary); padding: 10px; text-align: center; border-radius: 8px; font-weight: bold; font-size: 10px; color: var(--primary); }

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
                    box-shadow: 0 0 15px rgba(255,102,0,0.2);
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
    handlePlayerError() {},
    /**
     * Abre el reproductor con el contenido seleccionado.
     */
    async open(movie) {
        // Título nuevo = arrancamos otra vez por el mejor servidor, no por el último elegido
        if (this.currentPlayerMovie?.id !== movie?.id) {
            this.preferredProvider = null;
        }
        this.currentPlayerMovie = movie;
        this.init();
        const modal = document.getElementById('player-modal');
        modal.style.display = 'flex';

        // En escritorio, si venimos de la ficha, el player se acopla junto a la
        // información en vez de taparla. Se mueve ANTES de cargar la fuente: mover
        // un iframe en el DOM lo recarga, y así evitamos el doble arranque.
        this.acoplar();

        // Acoplado la página sigue siendo navegable; a pantalla completa no.
        document.body.style.overflow = this.estaAcoplado() ? '' : 'hidden';

        // Aviso de doble toque/clic para pantalla completa (ambas vistas).
        this.mostrarAvisoPantalla();

        // Empujamos /play al historial para que "atrás" cierre el player sin salir del detalle
        const currentHash = window.location.hash.substring(1);
        if (currentHash.startsWith('detail/') && !currentHash.endsWith('/play')) {
            history.pushState(null, '', `#${currentHash}/play`);
        }

        // Check if Admin
        const isAdmin = localStorage.getItem('selva_admin_auth') === 'true';
        const adminPanel = document.getElementById('admin-only-panel');
        const adminAppBtn = document.getElementById('admin-approve-player-btn');
        const adminWaitBtn = document.getElementById('admin-wait-player-btn');
        const manualInput = document.getElementById('admin-manual-link-input');
        
        if (adminPanel) adminPanel.style.display = isAdmin ? 'flex' : 'none';
        if (manualInput) manualInput.value = movie.embed || '';

        if (adminAppBtn) {
            adminAppBtn.style.display = (isAdmin && (movie.status === 'review' || movie.status === 'waiting')) ? 'block' : 'none';
        }
        
        if (adminWaitBtn) {
            adminWaitBtn.style.display = (isAdmin && movie.status !== 'waiting') ? 'block' : 'none';
        }

        // Reset elements
        const iframe = document.getElementById('player-iframe');
        const nativeContainer = document.getElementById('native-player-container');
        const nativePlayer = document.getElementById('native-video-player');
        const loader = document.getElementById('player-loader');
        const startScreen = document.getElementById('player-start-screen');

        if (iframe) { iframe.src = 'about:blank'; iframe.style.display = 'none'; }
        if (nativeContainer) nativeContainer.style.display = 'none';
        if (nativePlayer) nativePlayer.pause();
        if (startScreen) startScreen.style.display = 'none';

        const dynamicSources = document.getElementById('vip-dynamic-container');
        if (dynamicSources) dynamicSources.style.display = 'none';

        this.renderControls();

        // Si es serie, cargar metadatos de TMDB para temporadas
        const isSeries = ['series', 'tv', 'anime'].includes(movie.type);
        if (isSeries && movie.tmdbId) {
            await this.loadSeriesMetadata(movie.tmdbId);
        }

        // ⚡ RUTA RÁPIDA: Si la película tiene embed directo, reproducir YA
        if (movie.embed) {
            console.log("💎 Embed directo detectado — reproducción inmediata");
            if (loader) loader.style.display = 'none';

            const oficial = {
                title: "Servidor Oficial",
                name: "🌐 Source Directo (Cloud)",
                url: this.limpiarEmbed(movie.embed),
                infoHash: null,
                isPublic: true,
                lang: 'propio'
            };

            // ⏪ Restaurado a como estaba en 52c1cb5 (versión que el usuario
            // confirmó "limpia"): las fuentes públicas conocidas van primero y
            // arrancan la reproducción; el enlace propio queda al final como
            // alternativa. El reorden que las ponía después (dec7c62) fue el que
            // introdujo la diferencia de comportamiento reportada.
            const tipo = ['series', 'tv', 'anime'].includes(movie.type) ? 'series' : 'movie';
            const publicas = this.buildPublicStreams(tipo);
            this.lastScrapedStreams = [...publicas, oficial];

            const preferida = publicas.find(s => s.providerName === this.preferredProvider);
            this.handleExternalStream(preferida || publicas[0] || oficial);
            this.renderControls();
            return; // ✅ Reproducción directa — no interrumpir con scraping
        }

        // 🔍 SIN EMBED: Mostrar loader y buscar fuentes
        if (loader) {
            loader.style.display = 'flex';
            loader.innerHTML = `
                <div class="loader-logo">SELVAFLIX</div>
                <div class="loader-text">Buscando señales VIP...</div>
                <div class="spinner-tropical"></div>
            `;
        }

        const id = movie.imdbId || movie.tmdbId;
        const type = movie.type === 'series' ? 'series' : 'movie';
        if (id) {
            // loadDebridAuto decide solo: admin escanea la selva, visitante va directo
            // a las fuentes públicas (MoviesAPI, Embed.su, VidSrc...).
            this.loadDebridAuto(id, type);
        } else {
            // Sin embed y sin id de TMDB/IMDb no hay nada que buscar
            if (loader) loader.style.display = 'none';
            if (startScreen) {
                startScreen.style.display = 'flex';
                const msgEl = document.getElementById('vip-status-msg');
                if (msgEl) msgEl.innerHTML = '<span style="color:#e74c3c;">⚠️ Contenido no disponible en este momento.</span>';
            }
        }
    },
    async loadSeriesMetadata(tmdbId) {
        try {
            const TMDB_API_KEY = import.meta.env.VITE_TMDB_KEY || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
            const TMDB_URL = 'https://api.themoviedb.org/3';

            const resp = await fetch(`${TMDB_URL}/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=es-PE`);
            const details = await resp.json();

            const sSel = document.getElementById('selva-season');
            const eSel = document.getElementById('selva-episode');

            if (details.seasons && sSel && eSel) {
                // Etiquetas cortas a propósito: en móvil el select mide 92px y
                // "Temporada 1" se cortaba a "Tempor…", dejando al usuario sin
                // saber en qué capítulo estaba.
                sSel.innerHTML = details.seasons
                    .filter(s => s.season_number > 0)
                    .map(s => `<option value="${s.season_number}">T${s.season_number}</option>`).join('');

                const updateE = (sNum) => {
                    const s = details.seasons.find(x => x.season_number == sNum);
                    const count = s ? s.episode_count : 24;
                    eSel.innerHTML = Array.from({ length: count }, (_, i) => `<option value="${i + 1}">E${i + 1}</option>`).join('');
                };

                let initialSeason = details.seasons.find(s => s.season_number > 0)?.season_number || 1;
                let initialEpisode = 1;
                
                if (this.currentPlayerMovie && this.currentPlayerMovie.resumeSeason) {
                    initialSeason = this.currentPlayerMovie.resumeSeason;
                    initialEpisode = this.currentPlayerMovie.resumeEpisode || 1;
                }
                
                sSel.value = initialSeason;
                updateE(initialSeason);
                eSel.value = initialEpisode;

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



    updateServer(serverKey, season = 1, episode = 1) {
        const loader = document.getElementById('player-loader');
        if (loader) {
            loader.style.display = 'flex';
            loader.style.opacity = '1';
            loader.innerHTML = `
                <div class="loader-logo">SELVAFLIX</div>
                <div class="loader-text">Explorando la selva...</div>
                <div class="spinner-tropical"></div>
            `;
        }
        
        const nativePlayer = document.getElementById('native-video-player');
        if (nativePlayer) nativePlayer.pause();
        
        // Auto-scan para la nueva temporada/episodio
        this.loadDebridAuto();
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

    renderVipMenuList() {
        const vipMenuList = document.getElementById('vip-menu-list');
        const floatingBtn = document.getElementById('floating-sources-btn');
        
        if (this.lastScrapedStreams.length > 0) {
            if (vipMenuList) {
                const isAdmin = localStorage.getItem('selva_admin_auth') === 'true';
                const movieRef = this.currentPlayerMovie || {};
                const favHashes = movieRef.suggestedVipHashes || (movieRef.suggestedVipHash ? [movieRef.suggestedVipHash] : []);
                
                const filteredStreams = this.lastScrapedStreams.filter(s => {
                    // Excluir Debrid porque ya no se usa
                    const isDebrid = (s.name || '').toLowerCase().includes('[rd+]') || 
                                     (s.name || '').toLowerCase().includes('debrid') || 
                                     (s.title || '').toLowerCase().includes('[rd+]') ||
                                     (s.providerName || '').toLowerCase().includes('debrid');
                    if (isDebrid) return false;

                    const isSuggested = favHashes.includes(s.infoHash) || favHashes.includes(s.url);
                    const isPublicLink = movieRef.embed && (movieRef.embed === s.url || movieRef.embed === s.infoHash);
                    
                    if (isAdmin) return true; // Admin ve todo lo no-debrid
                    return isSuggested || isPublicLink || s.isPublic; 
                });

                // 🔥 FUENTE OFICIAL (BASE DE DATOS):
                if (movieRef.embed) {
                    const cleanEmbed = this.limpiarEmbed(movieRef.embed);

                    if (!filteredStreams.find(s => s.url === cleanEmbed || s.infoHash === cleanEmbed)) {
                        filteredStreams.unshift({
                            title: "[SERVIDOR OFICIAL] Reproductor Selva",
                            name: "🌐 Servidor Directo",
                            url: cleanEmbed,
                            infoHash: cleanEmbed,
                            isPublic: true
                        });
                    }

                    const manualInput = document.getElementById('admin-manual-link-input');
                    if (manualInput && isAdmin) {
                        manualInput.value = cleanEmbed;
                    }
                }

                if (floatingBtn) {
                    floatingBtn.innerHTML = `✅ ${filteredStreams.length} FUENTES VIP ▾`;
                }

                if (filteredStreams.length === 0 && !isAdmin) {
                    vipMenuList.innerHTML = '<div style="padding:20px; text-align:center; opacity:0.6; font-size:13px; font-family:\'Sora\',sans-serif;">⏳ Buscando fuentes en español... Vuelve en un momento.</div>';
                    return;
                }

                vipMenuList.innerHTML = filteredStreams.map((s, index) => {
                    const realIndex = this.lastScrapedStreams.indexOf(s);
                    const qRaw = ((s.title || '') + ' ' + (s.name || '')).toLowerCase();
                    
                    // 📊 DETECCIÓN DE CALIDAD
                    const quality = qRaw.includes('4k') || qRaw.includes('uhd') ? '4K UHD' : (qRaw.includes('1080') ? '1080p FHD' : (qRaw.includes('720') ? '720p HD' : 'HD'));
                    
                    // 🌍 IDIOMAS Y BANDERAS
                    const isLatino = qRaw.includes('latino') || qRaw.includes('latin') || qRaw.includes('cinecalidad') || qRaw.includes('dual');
                    const isCastellano = qRaw.includes('castellano') || qRaw.includes('espana') || qRaw.includes('españa') || qRaw.includes('spanish');
                    const isEnglish = qRaw.includes('english') || qRaw.includes('subbed') || qRaw.includes('subtitulado') || qRaw.includes('subs');
                    
                    let langLabel = 'MULTI';
                    // s.lang viene declarado en las fuentes públicas: no adivinamos por texto
                    if (s.lang === 'latino') langLabel = '🇲🇽 LATINO';
                    else if (s.lang === 'subs') langLabel = '💬 SUBS · audio original';
                    else if (s.lang === 'propio') langLabel = '🔗 ENLACE PROPIO';
                    else if (isLatino) langLabel = '🇲🇽 LATINO';
                    else if (isCastellano) langLabel = '🇪🇸 CASTELLANO';
                    else if (isEnglish) langLabel = '🇺🇸 INGLÉS';

                    // 📦 FORMATO Y PESO
                    const formatMatch = qRaw.match(/\.(mkv|mp4|m3u8|avi|ts)/i);
                    const fileFormat = s.detectedFormat || (formatMatch ? formatMatch[1].toUpperCase() : 'VIDEO');
                    
                    const weightMatch = qRaw.match(/(\d+(\.\d+)?\s*(gb|mb))/i);
                    const weight = s.detectedWeight || (weightMatch ? weightMatch[0].toUpperCase() : '');

                    // ⚙️ MODO ADMIN: Botones para coronar o exportar
                    const isSuggested = favHashes.includes(s.infoHash) || favHashes.includes(s.url);
                    const isPlaying = this.currentPlayingHash && (s.infoHash === this.currentPlayingHash || s.url === this.currentPlayingHash);
                    const isPublicLink = movieRef.embed && (movieRef.embed === s.url || movieRef.embed === s.infoHash);

                    const crownBtn = isAdmin ? `
                        <div style="position:absolute; bottom:12px; left:12px; display:flex; gap:8px; z-index:9999;">
                            <button class="crown-btn" 
                                    onclick="event.stopPropagation(); window.selvaExecuteCrownPromotion('${movieRef.id}', '${s.infoHash || s.url}')" 
                                    style="background:rgba(0,0,0,0.6); border:1.5px solid ${isSuggested ? '#E74C3C' : '#FF6600'}; color:#FF6600; border-radius:50%; width:38px; height:38px; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:1.2rem; box-shadow:0 0 15px ${isSuggested ? 'rgba(231,76,60,0.4)' : 'rgba(255,102,0,0.4)'}; transition: all 0.2s;" 
                                    onmouseover="this.style.transform='scale(1.2)';" onmouseout="this.style.transform='scale(1)';"
                                    title="${isSuggested ? 'Quitar Corona' : 'Coronar esta fuente'}">
                                ${isSuggested ? '🚫' : '👑'}
                            </button>
                            <button class="export-btn" 
                                    onclick="event.stopPropagation(); window.selvaExecuteExportToHosting('${movieRef.id}', ${realIndex}, false)" 
                                    style="background:rgba(0,0,0,0.6); border:1.5px solid #00f2ff; color:#00f2ff; border-radius:50%; width:38px; height:38px; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:1.2rem; box-shadow:0 0 15px rgba(0,242,255,0.4); transition: all 0.2s;" 
                                    onmouseover="this.style.transform='scale(1.2)';" onmouseout="this.style.transform='scale(1)';"
                                    title="Exportar a Hosting (🪄 Manual)">
                                🪄
                            </button>
                            <button class="auto-export-btn" 
                                    onclick="event.stopPropagation(); window.selvaExecuteExportToHosting('${movieRef.id}', ${realIndex}, true)" 
                                    style="background:rgba(0,0,0,0.6); border:1.5px solid #2ecc71; color:#2ecc71; border-radius:50%; width:38px; height:38px; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:1.2rem; box-shadow:0 0 15px rgba(46,204,113,0.4); transition: all 0.2s;" 
                                    onmouseover="this.style.transform='scale(1.2)';" onmouseout="this.style.transform='scale(1)';"
                                    title="Auto-Exportar (⚡ Subir + Guardar)">
                                ⚡
                            </button>
                        </div>
                    ` : '';

                    // Badge dinámico según rol
                    let badgeHtml = '';
                    if (isAdmin) {
                        if (isSuggested) badgeHtml = `<div style="position:absolute; top:-10px; right:-25px; background:#FF6600; color:white; padding:15px 30px; transform:rotate(45deg); font-size:0.55rem; font-weight:900; letter-spacing:1px; z-index:10; pointer-events:none;">👑 SUGERIDA</div>`;
                        else if (isPublicLink) badgeHtml = `<div style="position:absolute; top:-10px; right:-25px; background:#00f2ff; color:black; padding:15px 30px; transform:rotate(45deg); font-size:0.55rem; font-weight:900; letter-spacing:1px; z-index:10; pointer-events:none;">🌐 PÚBLICO</div>`;
                        else if (index === 0) badgeHtml = `<div style="position:absolute; top:-10px; right:-25px; background:#FF6600; color:white; padding:15px 30px; transform:rotate(45deg); font-size:0.5rem; font-weight:900; letter-spacing:1px; z-index:10; pointer-events:none;">EL MEJOR</div>`;
                    } else {
                        if (isSuggested) badgeHtml = `<div style="position:absolute; top:-10px; right:-25px; background:#FF6600; color:white; padding:15px 30px; transform:rotate(45deg); font-size:0.55rem; font-weight:900; letter-spacing:1px; z-index:10; pointer-events:none;">👑 PREMIUM</div>`;
                        else badgeHtml = `<div style="position:absolute; top:-10px; right:-25px; background:#00f2ff; color:black; padding:15px 30px; transform:rotate(45deg); font-size:0.55rem; font-weight:900; letter-spacing:1px; z-index:10; pointer-events:none;">🌐 DISPONIBLE</div>`;
                    }

                    const cardBg = isSuggested ? 'rgba(255,102,0,0.1)' : 'rgba(255,102,0,0.05)';
                    const cardBorder = isSuggested ? '#FF6600' : (isPublicLink ? '#00f2ff' : 'rgba(255,102,0,0.15)');
                    const borderLeft = isSuggested ? '#FF6600' : (isPublicLink ? '#00f2ff' : '#2ECC71');

                    return `
                        <div class="stream-card-vip" onclick='if(event.target.closest("button")) return; SelvaStream.toggleVipMenu(); SelvaStream.handleExternalStream(${realIndex === -1 ? JSON.stringify(s).replace(/'/g, "&apos;") : `SelvaStream.lastScrapedStreams[${realIndex}]`})'  
                                style="background: ${cardBg}; border: 1px solid ${cardBorder}; border-radius: 12px; padding: 15px; cursor: pointer; transition: all 0.2s ease; border-left: 4px solid ${borderLeft}; position: relative; overflow: hidden; text-align:left; margin-bottom:10px;">
                            ${badgeHtml}
                            ${isPlaying ? `<div style="position:absolute; top:12px; right:12px; background:#2ECC71; color:white; padding:4px 8px; border-radius:6px; font-size:0.55rem; font-weight:900; letter-spacing:1px; z-index:5; box-shadow:0 0 10px rgba(46,204,113,0.4);">● REPRODUCIENDO</div>` : ''}
                            ${crownBtn}
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <div style="font-size:0.65rem; font-weight:900; color:#2ECC71; text-transform:uppercase; letter-spacing:1px; display:flex; align-items:center; gap:5px; margin-bottom:2px;">
                                    ${s.providerName || 'SERVIDOR'} • ${langLabel}
                                </div>
                                <div style="color:white; font-size:0.82rem; font-weight:700; line-height:1.3; margin:2px 0; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;">
                                    ${(s.title || '').split('\n')[0]}
                                </div>
                                <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:5px;">
                                    <span style="background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; font-size:0.55rem; color:#fff; font-weight:900;">${quality}</span>
                                    <span style="background:rgba(46,204,113,0.1); padding:2px 6px; border-radius:4px; font-size:0.55rem; color:#2ecc71; font-weight:700; border:1px solid rgba(46,204,113,0.2);">${fileFormat}</span>
                                    ${s.detectedVideoCodec ? `<span style="background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; font-size:0.55rem; color:#fff; font-weight:700;">${s.detectedVideoCodec}</span>` : ''}
                                    ${s.detectedAudioCodec ? `<span style="background:rgba(52,152,219,0.1); padding:2px 6px; border-radius:4px; font-size:0.55rem; color:#3498db; font-weight:700;">🎵 ${s.detectedAudioCodec}</span>` : ''}
                                    ${weight ? `<span style="font-size:0.6rem; color:#bbb; font-weight:500;">⚖️ ${weight}</span>` : ''}
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        } else {
            if (vipMenuList) {
                vipMenuList.innerHTML = '<p style="text-align:center; opacity:0.5; font-size:12px; margin-top:20px; font-family:\'Sora\',sans-serif;">Buscando fuentes disponibles en la selva...</p>';
            }
        }
    },

    renderControls() {
        const root = document.getElementById('player-controls-root');
        if (!root) return;
        
        const isSeries = ['series', 'tv', 'anime'].includes(this.currentPlayerMovie?.type);
        const hasSelectors = !!document.getElementById('selva-season');

        if (isSeries && !hasSelectors) {
            root.innerHTML = `
                <div class="series-selectors" style="display: flex; gap: 8px; margin: 0; padding: 0; background: none; border: none; backdrop-filter: none;">
                    <select id="selva-season" class="selva-custom-select" style="padding: 8px 32px 8px 16px; font-size: 0.75rem; border-radius: 30px; height: 45px; background-color: rgba(15,15,15,0.6); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.15); box-sizing: border-box; margin: 0;"></select>
                    <select id="selva-episode" class="selva-custom-select" style="padding: 8px 32px 8px 16px; font-size: 0.75rem; border-radius: 30px; height: 45px; background-color: rgba(15,15,15,0.6); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.15); box-sizing: border-box; margin: 0;"></select>
                </div>
            `;
        } else if (!isSeries) {
            root.innerHTML = '';
        }

        // Siempre actualizar la lista VIP independientemente de los selectores generales
        this.renderVipMenuList();
    },

    close() {
        const modal = document.getElementById('player-modal');
        const iframe = document.getElementById('player-iframe');
        const nativePlayer = document.getElementById('native-video-player');
        const statusDiv = document.getElementById('webtorrent-status');

        if (modal) modal.style.display = 'none';
        if (iframe) window.setIframeSource('player-iframe', '');

        if (nativePlayer) {
            nativePlayer.pause();
            nativePlayer.removeAttribute('src');
            nativePlayer.load();
        }

        if (statusDiv) statusDiv.style.display = 'none';

        const dynamicSources = document.getElementById('vip-dynamic-container');
        if (dynamicSources) dynamicSources.style.display = 'none';

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

        // Devolver el modal al body para que la próxima apertura parta de cero
        this.desacoplar();

        // 🧹 Limpieza de controles
        const root = document.getElementById('player-controls-root');
        if (root) root.innerHTML = '';
    },

    // ─── Acople del reproductor (escritorio) ─────────────────────────
    estaAcoplado() {
        return document.getElementById('player-modal')?.classList.contains('player-acoplado') || false;
    },

    // Mete el modal dentro de la ficha para que conviva con la información.
    // Solo en escritorio y solo si el detalle está visible.
    acoplar() {
        const modal = document.getElementById('player-modal');
        const muelle = document.getElementById('detail-player-dock');
        const detalle = document.getElementById('detail-view');
        if (!modal || !muelle) return;

        // En móvil también se acopla (arriba, en 16:9, con la info debajo);
        // lo que cambia es la maquetación, que la resuelve el CSS.
        const enFicha = detalle && detalle.style.display !== 'none';
        if (!enFicha) return;

        if (modal.parentElement !== muelle) muelle.appendChild(modal);
        modal.classList.add('player-acoplado');
        document.getElementById('detail-view')?.classList.add('con-player-acoplado');

        // Aunque el hero encoge, si la página venía scrolleada el player puede
        // quedar fuera de vista. Lo traemos para que se vea al instante.
        requestAnimationFrame(() => {
            muelle.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
    },

    // Devuelve el modal al <body>. Solo al cerrar: mover el elemento reinicia el
    // iframe, así que durante la reproducción no se toca el DOM.
    desacoplar() {
        const modal = document.getElementById('player-modal');
        if (!modal) return;
        modal.classList.remove('player-acoplado', 'player-expandido');
        document.getElementById('detail-view')?.classList.remove('con-player-acoplado');
        if (modal.parentElement !== document.body) document.body.appendChild(modal);
    },

    // Agranda y encoge el player SIN tocar el DOM: mover el elemento reiniciaría
    // el iframe y el vídeo volvería a empezar. Aquí solo cambia una clase, así
    // que la reproducción continúa donde iba.
    // Aviso "doble toque = pantalla completa". SOLO en celular: ahí la pantalla
    // completa se hace con doble toque. En escritorio está el botón ⛶, así que
    // no se muestra ningún aviso.
    mostrarAvisoPantalla() {
        const hint = document.getElementById('fullscreen-hint');
        if (!hint) return;
        if (window.innerWidth > 1023) { hint.style.display = 'none'; return; }
        hint.textContent = '👆 Doble toque para pantalla completa';
        hint.style.display = 'block';
        hint.style.opacity = '1';
        clearTimeout(this._hintTimer);
        this._hintTimer = setTimeout(() => {
            hint.style.opacity = '0';
            setTimeout(() => { hint.style.display = 'none'; }, 600);
        }, 4000);
    },

    alternarPantalla() {
        const modal = document.getElementById('player-modal');
        if (!modal) return;

        if (!modal.classList.contains('player-acoplado')) return;

        const expandido = modal.classList.toggle('player-expandido');
        document.body.style.overflow = expandido ? 'hidden' : '';

        // El muelle es sticky con z-index propio, y eso crea un contexto de
        // apilamiento que encierra al player: por alto que sea su z-index nunca
        // superaría a la barra superior. Al expandir lo volvemos estático para
        // que el player compita en el nivel de la página.
        document.getElementById('detail-player-dock')
            ?.classList.toggle('dock-expandido', expandido);

        const btn = document.getElementById('player-expand-btn');
        if (btn) {
            btn.textContent = expandido ? '⤡' : '⛶';
            btn.title = expandido ? 'Volver junto a la ficha' : 'Pantalla completa';
        }

        // Nota: este botón solo existe en escritorio (en celular se oculta por
        // CSS). Aquí solo se agranda/encoge la caja del player con una clase,
        // MISMO mecanismo que ya funcionaba: no se pide requestFullscreen ni se
        // toca el iframe, así la reproducción sigue donde iba y no se dispara
        // la pantalla que provoca los popups. En celular la pantalla completa
        // limpia va por doble toque (reproductor nativo del teléfono).
    },

    // El campo `embed` a veces se guarda como URL y a veces como <iframe ...> pegado
    // entero desde el panel. Normalizarlo en un solo sitio evita que el mismo servidor
    // aparezca dos veces en el menú (el crudo y el limpio no se reconocían iguales).
    limpiarEmbed(embed) {
        if (!embed) return '';
        let url = embed;
        if (url.includes('<iframe')) {
            const m = url.match(/src="([^"]+)"/);
            if (m) url = m[1];
        }
        if (url.includes('streamtape.com/v/')) url = url.replace('/v/', '/e/');
        return url.trim();
    },

    // 🌐 Catálogo único de fuentes públicas.
    // lang: 'latino' = doblaje español latino | 'subs' = audio original (inglés) + subtítulos
    buildPublicStreams(queryType) {
        const movie = this.currentPlayerMovie || {};
        const tmdbId = movie.tmdbId;
        const imdbId = movie.imdbId;
        if (!tmdbId && !imdbId) return [];

        const tid = tmdbId || imdbId;
        const isTv = queryType === 'series';
        const s = isTv ? (document.getElementById('selva-season')?.value || 1) : null;
        const e = isTv ? (document.getElementById('selva-episode')?.value || 1) : null;
        const movieTitle = movie.title || "Película";
        const epTag = isTv ? ` T${s}E${e}` : '';

        // Helper para normalizar slugs al formato de PelisPlus
        const cleanSlug = (text) => {
            if (!text) return "";
            return text.toString().toLowerCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "") // Eliminar acentos
                .replace(/[^a-z0-9\s-]/g, "") // Eliminar caracteres especiales
                .trim()
                .replace(/\s+/g, "-") // Espacios a guiones
                .replace(/-+/g, "-"); // Colapsar guiones múltiples
        };
        const slug = cleanSlug(movieTitle);

        const defs = [];

        // 🇲🇽 FlixLatam es un resolver por IMDb: la página que devuelve corre sobre
        // EMBED69 y trae selector Latino / Castellano / Subtitulado. Va primero.
        if (imdbId) {
            defs.push({ lang: 'latino', name: "🇲🇽 FLIXLATAM · EMBED69", providerName: "FlixLatam",
                url: isTv
                    ? `https://flixlatam.com/vidurl/${imdbId}-${s}x${e < 10 ? '0' + e : e}/`
                    : `https://flixlatam.com/vidurl/${imdbId}/` });
        }

        // 🇲🇽 PelisPlusHD (Excelente alternativa en español latino/castellano)
        if (slug) {
            const pelisplusUrl = isTv
                ? `https://www.pelisplushd.la/serie/${slug}/temporada/${s}/capitulo/${e}`
                : `https://www.pelisplushd.la/pelicula/${slug}-${tmdbId || ''}`;
            defs.push({ lang: 'latino', name: "🇲🇽 PELISPLUS", providerName: "PelisPlus", url: pelisplusUrl });
        }

        // 🇲🇽 DiPelis (Gran catálogo en español latino/castellano).
        // Solo películas: /episodio/{slug}-{s}x{ep}/ devuelve 200 con 0 bytes en todas
        // las variantes probadas (1x01, 1x1, temporada-N-capitulo-N), así que en series
        // solo aportaría una fuente en blanco.
        if (slug && !isTv) {
            defs.push({ lang: 'latino', name: "🇲🇽 DIPELIS", providerName: "DiPelis",
                url: `https://ww2.dipelis.com/pelicula/${slug}/` });
        }

        // 💬 Audio original + subtítulos (estos NO traen doblaje latino garantizado)
        //
        // Verificados 2026-07-22. Retirados por no servir video:
        //   moviesapi.club → NXDOMAIN en varias ISP (incluida la de casa)
        //   vidsrc.xyz     → NXDOMAIN global, dominio muerto
        //   vidsrc.pro     → 301 a embed.su, era un duplicado
        //   embed.su       → falla TCP/TLS
        //   vidsrc.cc      → falla TCP/TLS
        //   vidsrc.to      → 200 pero solo devuelve un cascarón de anuncios (llvpn.com)
        defs.push(
            { lang: 'subs', name: "💬 VIDSRC.ME", providerName: "VidsrcMe",
              url: isTv ? `https://vidsrc.me/embed/tv?tmdb=${tid}&sub_lang=es&s=${s}&e=${e}` : `https://vidsrc.me/embed/movie?tmdb=${tid}&sub_lang=es` },
            { lang: 'subs', name: "💬 MULTIEMBED", providerName: "SuperEmbed",
              url: `https://multiembed.mov/?video_id=${tid}&tmdb=1${isTv ? `&s=${s}&e=${e}` : ''}` },
            { lang: 'subs', name: "💬 VIDLINK.PRO", providerName: "VidLink",
              url: isTv ? `https://vidlink.pro/tv/${tid}/${s}/${e}?primaryColor=ff7a00` : `https://vidlink.pro/movie/${tid}?primaryColor=ff7a00` }
        );

        return defs.map((d, i) => ({
            ...d,
            title: `[${d.lang === 'latino' ? 'ESPAÑOL LATINO' : 'SUBTITULADO'}] 🌐 ${movieTitle}${epTag} - Servidor ${i + 1}`,
            isPublic: true
        }));
    },

    async loadDebridAuto(id, type) {
        this.lastScrapedStreams = [];
        this.renderVipMenuList();

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
        let queryId = id || movie?.imdbId || movie?.tmdbId;
        const queryType = type || (['series', 'tv', 'anime'].includes(movie?.type) ? 'series' : 'movie');

        let season = 1;
        let episode = 1;
        if (queryType === 'series') {
            const sEl = document.getElementById('selva-season');
            const eEl = document.getElementById('selva-episode');
            if (sEl) season = parseInt(sEl.value) || 1;
            if (eEl) episode = parseInt(eEl.value) || 1;
            
            this.currentEpisodeId = `s${season}e${episode}`;
            this.currentEpisodeLabel = `T${season} E${episode}`;
            queryId = `${queryId}:${season}:${episode}`;
        } else {
            this.currentEpisodeId = null;
            this.currentEpisodeLabel = null;
        }

        // 1. Cargar las fuentes públicas disponibles (MoviesAPI Latino, Embed.su, etc.)
        const publicStreams = this.buildPublicStreams(queryType);

        // PRIORIDAD 1: Link Manual de Administrador (Vía Panel Admin)
        if (movie && movie.embed && (movie.embed.startsWith('http') || movie.embed.includes('<iframe'))) {
            const cleanEmbed = this.limpiarEmbed(movie.embed);

            console.log("💎 Usando Link Manual Oficial");
            this.lastScrapedStreams = [{
                url: cleanEmbed,
                name: '🌐 SERVIDOR OFICIAL',
                title: movie.title || 'Servidor Oficial',
                providerName: 'Admin',
                isPublic: true
            }, ...publicStreams];

            this.handleExternalStream(this.lastScrapedStreams[0]);
            this.renderControls();
            return;
        }

        // Los rastreadores de torrents (Torrentio, Comet, Knightcrawler, MediaFusion)
        // se retiraron: el navegador solo puede hablar WebRTC y los torrents públicos
        // tienen peers de BitTorrent normal, así que se quedaban en 0 peers para
        // siempre. Real-Debrid era el puente que los convertía en enlace directo y ya
        // no está contratado. Aportaban ~49 fuentes irreproducibles (varias ni siquiera
        // de la película pedida) y desordenaban las buenas, así que admin y visitante
        // ven ahora exactamente la misma lista.
        if (publicStreams.length > 0) {
            this.lastScrapedStreams = publicStreams;
            // Al cambiar de capítulo respetamos el servidor que el usuario venía viendo
            const elegido = publicStreams.find(s => s.providerName === this.preferredProvider);
            this.handleExternalStream(elegido || publicStreams[0]);
            this.renderControls();
        } else {
            if (loader) loader.style.display = "none";
            if (startScreen) {
                startScreen.style.display = "flex";
                const msgEl = document.getElementById("vip-status-msg");
                if (msgEl) msgEl.innerHTML = '<span style="color:#e74c3c;">⚠️ Contenido no disponible en este momento.</span>';
            }
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
        console.log("💎 Cargando fuente externa:", stream);
        this.currentPlayingHash = stream.infoHash || stream.url;

        // Recordamos el servidor elegido para no perderlo al cambiar de capítulo
        if (stream.isPublic && stream.providerName) {
            this.preferredProvider = stream.providerName;
        }

        const loader = document.getElementById('player-loader');
        const startScreen = document.getElementById('player-start-screen');
        const nativePlayer = document.getElementById('native-video-player');
        const iframe = document.getElementById('player-iframe');
        const statusDiv = document.getElementById('webtorrent-status');

        if (startScreen) startScreen.style.display = 'none';
        
        // 1. MOTOR P2P (Torrents)
        if (stream.infoHash) {
            if (loader) loader.style.display = 'flex';
            this.handleP2PStream(stream);
            return;
        }

        // 2. MOTOR DIRECTO / EMBED (URLs)
        if (stream.url) {
            if (loader) loader.style.display = 'none';
            let finalUrl = stream.url;

            // Limpieza de iframes si vienen crudos
            if (finalUrl.includes('<iframe')) {
                const srcMatch = finalUrl.match(/src="([^"]+)"/);
                if (srcMatch) finalUrl = srcMatch[1];
            }

            const isHls = finalUrl.includes('.m3u8');
            const isDirectVideo = isHls || finalUrl.endsWith('.mp4') || finalUrl.endsWith('.mkv') || stream.name?.includes('[RD+]') || stream.title?.includes('[RD+]');

            if (isDirectVideo) {
                // Modo Video Nativo
                iframe.style.display = 'none';
                if (statusDiv) statusDiv.style.display = 'none';
                
                const nativeContainer = document.getElementById('native-player-container');
                if (nativeContainer) nativeContainer.style.display = 'block';
                nativePlayer.style.display = 'block';

                if (isHls && typeof Hls !== 'undefined') {
                    if (this.hls) this.hls.destroy();
                    if (Hls.isSupported()) {
                        this.hls = new Hls();
                        this.hls.loadSource(finalUrl);
                        this.hls.attachMedia(nativePlayer);
                    } else {
                        nativePlayer.src = finalUrl;
                    }
                } else {
                    nativePlayer.src = finalUrl;
                }
                
                nativePlayer.load();
                if (this.currentPlayerMovie.resumeTime > 0) {
                    nativePlayer.currentTime = this.currentPlayerMovie.resumeTime;
                }
                nativePlayer.play().catch(e => console.warn("Auto-play prevented", e));
                this.wireProgressTracking(nativePlayer);
            } else {
                // Modo Iframe
                nativePlayer.style.display = 'none';
                const nativeContainer = document.getElementById('native-player-container');
                if (nativeContainer) nativeContainer.style.display = 'none';

                if (finalUrl.includes('streamtape.com/v/')) {
                    finalUrl = finalUrl.replace('/v/', '/e/');
                }

                iframe.style.display = 'block';
                window.setIframeSource('player-iframe', finalUrl);
                if (statusDiv) statusDiv.style.display = 'none';
            }
        }
    },

    // --- "Continuar Viendo": solo es posible cuando el video corre en el
    // <video> nativo (HLS/mp4 directo), porque ahí sí controlamos el elemento.
    // Los servidores externos (PelisPlus, VidSrc, etc.) van en iframe de otro
    // origen: el navegador nos bloquea leer su currentTime, así que para esas
    // fuentes no hay forma de guardar progreso.
    wireProgressTracking(video) {
        if (video._selvaProgressWired) return; // un solo listener para toda la vida del <video>
        video._selvaProgressWired = true;

        const guardar = () => {
            if (!video.duration || isNaN(video.duration) || video.currentTime < 1) return;
            if (typeof window.syncPlaybackProgress !== 'function' || !this.currentPlayerMovie) return;
            window.syncPlaybackProgress(this.currentPlayerMovie, video.currentTime, video.duration, this.currentEpisodeId, this.currentEpisodeLabel);
        };

        let lastSync = 0;
        video.addEventListener('timeupdate', () => {
            const now = Date.now();
            if (now - lastSync < 15000) return; // cada 15s, no en cada frame
            lastSync = now;
            guardar();
        });

        // Al pausar o cerrar la pestaña, guardamos la posición exacta aunque
        // no hayan pasado los 15s del intervalo de arriba.
        video.addEventListener('pause', guardar);
        window.addEventListener('beforeunload', guardar);
    },

    injectInPlayerBanner() {
        if (typeof window.getInPlayerAd !== 'function') return;
        const ad = window.getInPlayerAd();
        if (!ad) return;

        this.inPlayerAdShown = true;
        const container = document.getElementById('native-player-container');
        if (!container) return;

        const banner = document.createElement('div');
        banner.id = 'selva-inplayer-ad';
        banner.style.cssText = `
            position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%);
            width: 90%; max-width: 450px; background: rgba(10,10,10,0.95);
            backdrop-filter: blur(15px); border: 1px solid rgba(255,255,255,0.1);
            border-radius: 12px; padding: 12px; display: flex; align-items: center;
            gap: 12px; z-index: 1000; animation: bannerSlideIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            box-shadow: 0 10px 30px rgba(0,0,0,0.5); border-left: 4px solid var(--primary);
        `;

        banner.innerHTML = `
            <style>
                @keyframes bannerSlideIn { from { transform: translate(-50%, 50px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
            </style>
            ${ad.media ? `<img src="${ad.media}" style="width: 50px; height: 50px; object-fit: cover; border-radius: 6px;">` : ''}
            <div style="flex: 1; text-align: left;">
                <p style="color: var(--primary); font-size: 0.6rem; font-weight: 900; text-transform: uppercase; margin: 0; letter-spacing: 1px;">Auncio de Apoyo 🌴</p>
                <p style="color: white; font-size: 0.75rem; font-weight: 600; margin: 2px 0;">${ad.message || "Apóyanos para seguir gratis"}</p>
            </div>
            <div style="display: flex; flex-direction: column; gap: 5px;">
                <button id="close-inplayer-ad" style="background: none; border: none; color: #666; font-size: 1.2rem; cursor: pointer; line-height: 1;">&times;</button>
                ${ad.link ? `<a href="${ad.link}" target="_blank" style="background: var(--primary); color: black; font-size: 0.6rem; font-weight: 900; padding: 5px 10px; border-radius: 4px; text-decoration: none; text-align: center;">ABRIR</a>` : ''}
            </div>
        `;

        container.appendChild(banner);

        document.getElementById('close-inplayer-ad').onclick = (e) => {
            e.stopPropagation();
            banner.style.opacity = '0';
            banner.style.transform = 'translate(-50%, 20px)';
            setTimeout(() => banner.remove(), 400);
        };
        
        // Auto-click link handling if desired
        if (ad.link) {
            banner.style.cursor = 'pointer';
            banner.onclick = () => window.open(ad.link, '_blank');
        }
    },

    // ⚠️ EN DESUSO (2026-07): puente a Real-Debrid vía el worker para des-restringir
    // magnets/torrents a enlace directo. Real-Debrid ya no está contratado y los
    // torrents se retiraron, así que NADIE llega aquí (solo se invocaba cuando una
    // fuente traía `infoHash`, cosa que ya no ocurre). Se conserva por si algún día
    // se vuelve a contratar Real-Debrid; no borrar.
    async callMasterWorker(infoHash, attempt = 1) {
        try {
            const magnet = `magnet:?xt=urn:btih:${infoHash}`;
            const role = 'admin';

            const url = `${this.MASTER_WORKER_URL}/flix/unrestrict?magnet=${encodeURIComponent(magnet)}&role=${role}`;

            const res = await fetch(url, {
                headers: { 'x-selva-auth': this.AUTH_TOKEN }
            });

            if (!res.ok) throw new Error(`HTTP_${res.status}`);
            const data = await res.json();

            // 🚀 SISTEMA P2P / PÚBLICO (Sin esperas de Debrid)
            if (data.status === 'waiting') {
                console.log(`[Búnker] Archivo en proceso o requiere intervención.`);
            }
            return data;
        } catch (error) {
            console.error('[Worker Connection Error]', error);
            return { error: error.message };
        }
    },

    /**
     * Motor P2P Nativo: Reproduce torrents directamente en el navegador.
     */
    handleP2PStream(stream) {
        const infoHash = stream.infoHash;
        // Magnet con trackers públicos para máxima visibilidad P2P
        const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=SelvaFlix_Stream&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Fzer0day.ch%3A1337&tr=udp%3A%2F%2Fopen.demonii.com%3A1337&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Fexodus.desync.com%3A6969&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com`;
        
        const loader = document.getElementById('player-loader');
        const statusDiv = document.getElementById('webtorrent-status');
        const progressEl = document.getElementById('wt-progress');
        const nativePlayer = document.getElementById('native-video-player');
        
        if (statusDiv) statusDiv.style.display = 'block';
        
        try {
            if (!this.torrentClient) this.torrentClient = new WebTorrent();
            
            // Limpiar descargas previas para no saturar memoria
            this.torrentClient.torrents.forEach(t => t.destroy());

            console.log("🕸️ Iniciando enjambre P2P para:", infoHash);

            this.torrentClient.add(magnet, (torrent) => {
                // Buscamos el archivo de video principal
                const file = torrent.files.find(f => 
                    f.name.endsWith('.mp4') || f.name.endsWith('.mkv') || 
                    f.name.endsWith('.webm') || f.name.endsWith('.avi')
                );
                
                torrent.on('download', () => {
                    if (progressEl) {
                        const speed = (torrent.downloadSpeed / 1024 / 1024).toFixed(2);
                        progressEl.innerHTML = `<span style="color:var(--primary);">⬇️ ${speed} MB/s</span> | 👥 ${torrent.numPeers} peers | ${(torrent.progress * 100).toFixed(1)}%`;
                    }
                });

                if (file) {
                    console.log("🎥 Streaming P2P iniciado:", file.name);
                    file.renderTo('#native-video-player', { 
                        autoplay: false,
                        controls: true 
                    }, (err, elem) => {
                        if (err) {
                            console.error("Error renderizando P2P:", err);
                        } else {
                            if (loader) loader.style.display = 'none';
                            const container = document.getElementById('native-player-container');
                            if (container) container.style.display = 'block';
                            nativePlayer.style.display = 'block';
                            
                            // Ajustar tiempo de reanudación si existe
                            if (this.currentPlayerMovie.resumeTime > 0) {
                                nativePlayer.currentTime = this.currentPlayerMovie.resumeTime;
                            }
                        }
                    });
                }
            });

            this.torrentClient.on('error', (err) => {
                console.error("WebTorrent fatal error:", err);
                if (progressEl) progressEl.innerText = "❌ Error en red P2P. Prueba otra fuente.";
            });

        } catch (e) {
            console.error("Falla crítica en motor P2P:", e);
        }
    }
};

window.SelvaStream = SelvaStream;
