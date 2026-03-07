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
    AUTH_TOKEN: import.meta.env.VITE_AUTH_TOKEN || localStorage.getItem('iconoservices_token') || 'MASTER_TOKEN_REQUIRED', // Token oculto seguro

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
            <div class="video-layout">
                <div class="video-container">
                    <div id="player-loader" class="loader-overlay">
                        <div class="loader-logo">SELVAFLIX</div>
                        <div class="loader-text">Explorando la selva...</div>
                        <div class="spinner-tropical"></div>
                    </div>
                    <iframe id="player-iframe" src="" 
                        allow="autoplay; fullscreen; picture-in-picture; encrypted-media; gyroscope; accelerometer; clipboard-write"
                        allowfullscreen>
                    </iframe>
                    <!-- Reproductor P2P/Nativo (Fase 1) -->
                    <div id="native-player-container" style="display:none; width: 100%; height: 100%; position: relative;">
                        <video id="native-video-player" style="width: 100%; height: 100%; background: #000;" controls></video>
                        <a id="external-player-btn" href="#" style="position:absolute; top:20px; right:20px; background:rgba(255,122,0,0.9); padding:10px 15px; border-radius:8px; color:black; font-weight:bold; font-size:12px; text-decoration:none; z-index:100; display:flex; align-items:center; gap:5px; box-shadow: 0 4px 6px rgba(0,0,0,0.5);">
                            🎧 ¿Sin Audio? Abrir en VLC
                        </a>
                    </div>
                    
                    <div id="webtorrent-status" style="display:none; position:absolute; bottom:20px; left:20px; background:rgba(0,0,0,0.8); padding:10px; border-radius:8px; color:#fff; font-size:12px; z-index:100; border: 1px solid var(--primary);">
                        <div style="color:var(--primary); font-weight:bold; margin-bottom:5px;">🕸️ Conectando a la red P2P...</div>
                        <div id="wt-progress">Buscando semillas...</div>
                    </div>

                    <!-- Pantalla de Inicio (Fase 4) -->
                    <div id="player-start-screen" class="player-start-screen" style="display:none;">
                        <div class="start-bg" id="start-bg"></div>
                        <div class="start-content">
                            <h2 id="start-title">CARGANDO...</h2>
                            <button id="start-play-btn" class="start-play-btn">
                                <span class="play-icon">▶</span> REPRODUCIR VIP
                            </button>
                            <p class="start-subtitle">Conexión Directa Real-Debrid P2P</p>
                        </div>
                    </div>

                    <!-- Botón de Fuentes Flotante (Fase 4.1) -->
                    <button id="floating-sources-btn" class="floating-sources-btn" onclick="SelvaStream.toggleVipMenu()">
                         📡 OTRAS FUENTES VIP
                    </button>
                    <div id="side-vip-menu" class="side-vip-menu">
                        <div class="vip-menu-header">
                            <span>🚀 FUENTES VIP</span>
                            <button onclick="SelvaStream.toggleVipMenu()">&times;</button>
                        </div>
                        <div id="vip-menu-list"></div>
                    </div>
                </div>
                <div class="guide-sidebar compact-sidebar">
                    <h3>📌 NOTIFICACIONES</h3>
                    <div id="player-notifications" class="player-notifications">
                        <p>¿No carga? Prueba otro servidor o usa uBlock/Brave.</p>
                    </div>
                    <div class="sidebar-ad-space">
                        <!-- Espacio para Ads o Info -->
                        <span>🔥 SelvaFlix VIP</span>
                    </div>
                </div>
            </div>
            <!-- Controles y Servidores (Se llenan dinámicamente) -->
            <div id="player-controls-root"></div>
            <div class="ad-notice">
                <span id="adblock-text">🛡️ <b>¿Publicidad Intrusiva?</b> Para disfrutar la selva en paz usa </span>
                <a href="https://brave.com/" target="_blank" style="color: var(--primary);">Brave Browser</a>.
            </div>

            <!-- 🧪 Custom Safety Notice (v4.0) -->
            <div id="selva-safety-modal" class="safety-notice-modal">
                <div class="notice-card">
                    <span class="notice-icon">🛡️</span>
                    <h3>Activar Escudo Total</h3>
                    <p>Vas a blindar el reproductor al 100%. Esto bloqueará la publicidad, pero <b>podría evitar que algunos videos carguen</b> adecuadamente.<br><br>¿Deseas activar la protección máxima?</p>
                    <div class="notice-actions">
                        <button class="notice-btn btn-cancel" onclick="SelvaStream.closeSafetyModal()">Cancelar</button>
                        <button class="notice-btn btn-confirm" onclick="SelvaStream.confirmShieldActivation()">Activar Blindaje</button>
                    </div>
                </div>
            </div>
        `;

        // Eventos básicos
        document.getElementById('close-player')?.addEventListener('click', () => this.close());
        document.getElementById('start-play-btn')?.addEventListener('click', () => {
            const id = this.currentPlayerMovie.imdbId || this.currentPlayerMovie.tmdbId;
            const type = this.currentPlayerMovie.type === 'series' ? 'series' : 'movie';
            this.loadDebridAuto(id, type);
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
                .start-content h2 { font-size: 2.2rem; text-shadow: 0 4px 15px rgba(0,0,0,0.9); margin-bottom: 25px; font-weight: 800; }
                .start-play-btn {
                    background: var(--primary); color: black; border: none;
                    padding: 18px 50px; border-radius: 60px; font-size: 1.3rem;
                    font-weight: 900; cursor: pointer; display: flex; align-items: center; gap: 12px;
                    transition: all 0.3s;
                    box-shadow: 0 10px 30px rgba(255,122,0,0.5);
                }
                .start-play-btn:hover { transform: scale(1.05); box-shadow: 0 0 50px rgba(255,122,0,0.8); }
                .play-icon { font-size: 1.5rem; }
                .start-subtitle { margin-top: 15px; font-size: 0.9rem; opacity: 0.7; letter-spacing: 2px; }

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
                    z-index: 300; transition: right 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                    border-left: 1px solid #333; padding: 20px; overflow-y: auto;
                }
                .side-vip-menu.active { right: 0; }
                .vip-menu-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; color: var(--primary); font-weight: 800; border-bottom: 1px solid #333; padding-bottom: 10px; }
                .vip-menu-header button { background: none; border: none; color: white; font-size: 24px; cursor: pointer; }

                .compact-sidebar { width: 180px !important; font-size: 11px; }
                .sidebar-ad-space { margin-top: auto; background: rgba(255,122,0,0.1); border: 1px dashed var(--primary); padding: 10px; text-align: center; border-radius: 8px; font-weight: bold; font-size: 10px; color: var(--primary); }

                @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
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
                    if (iframeWindow && iframeWindow.document && iframeWindow.document.body.innerHTML.length < 50) {
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
        if (statusDiv) statusDiv.style.display = 'none';
        if (loader) loader.style.display = 'none';

        // Mostrar Start Screen
        if (startScreen) {
            startScreen.style.display = 'flex';
            document.getElementById('start-title').innerText = movie.title || movie.name;
            const bg = document.getElementById('start-bg');
            const poster = movie.poster_path || movie.img || '';
            const finalImg = poster.startsWith('http') ? poster : `https://image.tmdb.org/t/p/original${poster}`;
            if (bg) bg.style.backgroundImage = `url(${finalImg})`;
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
        if (!this.currentPlayerMovie || !this.currentPlayerMovie.tmdbId) return;

        const tmdbId = this.currentPlayerMovie.tmdbId;
        const imdbId = this.currentPlayerMovie.imdbId;
        const idValue = imdbId || tmdbId;
        const hasImdb = !!imdbId;

        const type = this.currentPlayerMovie.type || 'movie';
        const isSeries = type === 'series' || type === 'tv' || type === 'anime';

        const iframe = document.getElementById('player-iframe');
        const nativeContainer = document.getElementById('native-player-container');
        const nativePlayer = document.getElementById('native-video-player');
        const statusDiv = document.getElementById('webtorrent-status');
        const loader = document.getElementById('player-loader');

        if (iframe) iframe.style.display = 'block';
        if (nativeContainer) nativeContainer.style.display = 'none';
        if (nativePlayer) {
            nativePlayer.pause();
        }
        if (statusDiv) statusDiv.style.display = 'none';

        const startScreen = document.getElementById('player-start-screen');
        if (startScreen) startScreen.style.display = 'none';

        loader.style.display = 'flex';
        loader.style.opacity = '1';

        // Preferencia Rey (Aumenta probabilidad de audio correcto)
        const pref = localStorage.getItem('selva_pref_lang') || 'latino';
        const langParam = pref === 'latino' ? '&ds_lang=es' : '';

        let url = "";
        switch (serverKey) {
            case 'latino-1': url = isSeries ? `https://vidsrc.me/embed/tv?${hasImdb ? `imdb=${idValue}` : `tmdb=${idValue}`}&season=${season}&episode=${episode}${langParam}` : `https://vidsrc.me/embed/movie?${hasImdb ? `imdb=${idValue}` : `tmdb=${idValue}`}${langParam}`; break;
            case 'latino-2': url = isSeries ? `https://vidsrc.to/embed/tv/${idValue}/${season}/${episode}` : `https://vidsrc.to/embed/movie/${idValue}`; break;
            case 'latino-3': url = isSeries ? `https://vidsrc.xyz/embed/tv?${hasImdb ? `imdb=${idValue}` : `tmdb=${idValue}`}&season=${season}&episode=${episode}${langParam}` : `https://vidsrc.xyz/embed/movie?${hasImdb ? `imdb=${idValue}` : `tmdb=${idValue}`}${langParam}`; break;
            case 'latino-4': url = isSeries ? `https://embed.su/embed/tv/${idValue}/${season}/${episode}` : `https://embed.su/embed/movie/${idValue}`; break;
            case 'latino-5': url = isSeries ? `https://vidsrc.pro/embed/tv?${hasImdb ? `imdb=${idValue}` : `tmdb=${idValue}`}&season=${season}&episode=${episode}${langParam.replace('ds_lang', 'lang')}` : `https://vidsrc.pro/embed/movie?${hasImdb ? `imdb=${idValue}` : `tmdb=${idValue}`}${langParam.replace('ds_lang', 'lang')}`; break;
            case 'latino-6': url = isSeries ? `https://multiembed.mov/?video_id=${idValue}${hasImdb ? '&imdb=1' : '&tmdb=1'}&s=${season}&e=${episode}` : `https://multiembed.mov/?video_id=${idValue}${hasImdb ? '&imdb=1' : '&tmdb=1'}`; break;
            case 'english-1': url = isSeries ? `https://vidsrc.xyz/embed/tv?${hasImdb ? `imdb=${idValue}` : `tmdb=${idValue}`}&season=${season}&episode=${episode}` : `https://vidsrc.xyz/embed/movie?${hasImdb ? `imdb=${idValue}` : `tmdb=${idValue}`}`; break;
            case 'english-2': url = isSeries ? `https://www.2embed.cc/embed/${idValue}&s=${season}&e=${episode}` : `https://www.2embed.cc/embed/${idValue}`; break;
            default: url = `https://vidsrc.xyz/embed/${isSeries ? 'tv' : 'movie'}?${hasImdb ? `imdb=${idValue}` : `tmdb=${idValue}`}${langParam}`;
        }

        const cleanUrl = this.sanitizeUrl(url);

        // ── Lógica Inversa v4.3 (Operación Limpieza: Remoción Total de Sandbox en Compatible) ──
        const isShieldOn = localStorage.getItem(`selva_shield_${serverKey}`) === 'true';
        if (isShieldOn) {
            iframe.setAttribute('sandbox', 'allow-forms allow-scripts allow-same-origin allow-popups-to-escape-sandbox allow-presentation');
        } else {
            iframe.removeAttribute('sandbox');
        }

        iframe.src = cleanUrl;
        this.updateDownloadBtn(cleanUrl);

        document.querySelectorAll('.server-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.server === serverKey);
        });
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

    // ── Shield Toggle v4.0 (Custom UI) ──
    toggleShield() {
        const activeBtn = document.querySelector('.server-btn.active');
        if (!activeBtn) return;
        const serverKey = activeBtn.dataset.server;
        const isShieldOn = localStorage.getItem(`selva_shield_${serverKey}`) === 'true';

        if (!isShieldOn) {
            const modal = document.getElementById('selva-safety-modal');
            modal.classList.add('active');
        } else {
            localStorage.removeItem(`selva_shield_${serverKey}`);
            this.refreshState(serverKey);
        }
    },

    confirmShieldActivation() {
        const activeBtn = document.querySelector('.server-btn.active');
        if (!activeBtn) return;
        const serverKey = activeBtn.dataset.server;

        localStorage.setItem(`selva_shield_${serverKey}`, 'true');
        this.closeSafetyModal();
        this.refreshState(serverKey);
    },

    closeSafetyModal() {
        const modal = document.getElementById('selva-safety-modal');
        modal.classList.remove('active');
    },

    refreshState(serverKey) {
        const s = document.getElementById('selva-season')?.value || 1;
        const e = document.getElementById('selva-episode')?.value || 1;
        this.updateServer(serverKey, s, e);
        this.renderControls();
    },

    // ── Centro de Seguridad y Recomendaciones ──
    getProtectionData() {
        const ua = navigator.userAgent;
        if (/Android/i.test(ua)) {
            return {
                name: 'Descargar Brave (Recomendado)',
                link: 'https://play.google.com/store/apps/details?id=com.brave.browser',
                icon: '📱',
                desc: 'Protege tu Android bloqueando pop-ups de raíz.'
            };
        } else if (/iPhone|iPad|iPod/i.test(ua)) {
            return {
                name: 'Instalar AdGuard iOS',
                link: 'https://apps.apple.com/app/adguard-adblock-privacy/id1047223162',
                icon: '🛡️',
                desc: 'La mejor defensa para Safari contra publicidad móvil.'
            };
        } else {
            return {
                name: 'uBlock Origin (Lo mejor en PC)',
                link: 'https://ublockorigin.com/',
                icon: '💻',
                desc: 'La extensión más potente y ligera para tu navegador.'
            };
        }
    },

    toggleVipMenu() {
        const menu = document.getElementById('side-vip-menu');
        if (menu) menu.classList.toggle('active');
        this.renderControls();
    },

    renderControls() {
        const root = document.getElementById('player-controls-root');
        if (!root) return;

        const pref = localStorage.getItem('selva_pref_lang') || 'latino';

        // Actualizar el Listado del Menú Lateral VIP
        const vipMenuList = document.getElementById('vip-menu-list');
        if (vipMenuList) {
            if (this.lastScrapedStreams.length > 0) {
                vipMenuList.innerHTML = this.lastScrapedStreams.map(s => {
                    const text = (s.title + ' ' + s.name).toLowerCase();
                    const isLatino = text.includes('latino') || text.includes('spanish') || text.includes('cinecalidad');
                    return `
                        <div class="stream-item" onclick='SelvaStream.toggleVipMenu(); SelvaStream.handleExternalStream(${JSON.stringify(s).replace(/'/g, "&apos;")})' style="background:rgba(255,255,255,0.05); padding:12px; border-radius:10px; border:1px solid #333; cursor:pointer; margin-bottom:10px;">
                            <div style="font-size:10px; font-weight:bold; color:#2ecc71; display:flex; justify-content:space-between;">
                                <span>${s.providerName} VIP</span>
                                ${isLatino ? '<span class="latino-badge">LATINO</span>' : ''}
                            </div>
                            <div style="font-size:11px; margin-top:5px; opacity:0.8; height:32px; overflow:hidden; line-height:1.2;">${s.title}</div>
                        </div>
                    `;
                }).join('');
            } else {
                vipMenuList.innerHTML = '<p style="text-align:center; opacity:0.5; font-size:12px; margin-top:20px;">Pulsa "REPRODUCIR VIP" para buscar fuentes.</p>';
            }
        }

        root.innerHTML = `
            <div class="player-controls">
                <!-- Selector de Idioma Global -->
                <div class="pref-selector" style="display:flex; justify-content:center; gap:10px; margin-bottom:20px; background: rgba(255,122,0,0.05); padding:12px; border-radius:15px; border:1px solid rgba(255,122,0,0.15); box-shadow: 0 4px 15px rgba(0,0,0,0.3);">
                    <button class="pref-btn ${pref === 'latino' ? 'active' : ''}" onclick="SelvaStream.setPreference('latino')" style="flex:1; background:${pref === 'latino' ? 'var(--primary)' : 'rgba(255,255,255,0.05)'}; border:none; color:${pref === 'latino' ? 'black' : 'white'}; padding:12px; border-radius:10px; font-weight:800; cursor:pointer; transition: all 0.3s; font-size: 13px;">🇲🇽 LATINO (VIP)</button>
                    <button class="pref-btn ${pref === 'english' ? 'active' : ''}" onclick="SelvaStream.setPreference('english')" style="flex:1; background:${pref === 'english' ? 'var(--primary)' : 'rgba(255,255,255,0.05)'}; border:none; color:${pref === 'english' ? 'black' : 'white'}; padding:12px; border-radius:10px; font-weight:800; cursor:pointer; transition: all 0.3s; font-size: 13px;">🇺🇸 SUB/ENG</button>
                </div>

                <!-- Panel de Servidores con Publicidad -->
                <div class="server-switcher" style="padding:20px; background:rgba(255,255,255,0.03); border-radius:15px; border:1px solid #222; position:relative;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                        <span style="font-size:13px; font-weight:900; color:#FF7A00; letter-spacing:0.5px;">🌐 OPCIONES CON PUBLICIDAD (Clásicos)</span>
                        <div style="font-size:11px; background:#C0392B; color:white; padding:2px 8px; border-radius:4px; font-weight:800;">AVISO</div>
                    </div>
                    
                    <p style="font-size:11px; color:#888; margin-bottom:15px; line-height:1.4;">Si prefieres los servidores tradicionales, aquí los tienes. Ten en cuenta que pueden abrir pestañas externas.</p>

                    <div class="server-group" style="display:flex; gap:12px; flex-wrap:wrap;">
                        <button class="server-btn" onclick="SelvaStream.updateServer('latino-1')" style="flex:1; min-width:100px;">SERVIDOR 1</button>
                        <button class="server-btn" onclick="SelvaStream.updateServer('latino-2')" style="flex:1; min-width:100px;">SERVIDOR 2</button>
                        <button class="server-btn" onclick="SelvaStream.updateServer('latino-4')" style="flex:1; min-width:100px;">SERVIDOR 4</button>
                        <button class="server-btn" onclick="SelvaStream.updateServer('latino-6')" style="flex:1; min-width:100px;">SERVIDOR 6</button>
                    </div>
                </div>

                 <div style="margin-top:20px; text-align:center;">
                    <button onclick="SelvaStream.fetchExternalStreams()" style="background:none; border:none; color:var(--text-muted); font-size:12px; font-weight:bold; cursor:pointer; text-decoration:underline; opacity:0.6;">🔄 Recargar base de datos P2P</button>
                </div>
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

        const startScreen = document.getElementById('player-start-screen');
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
            const providers = "cinecalidad,mejortorrent,wolfmax4k,yts,eztv,rarbg,1337x,torrent9,limetorrents";
            const tConfig = `providers=${providers}|sort=seeders|qualityfilter=scr,cam`;

            const urls = [
                `https://torrentio.strem.fun/${tConfig}/stream/${type}/${id}.json`,
                `https://comet.strem.fun/stream/${type}/${id}.json`
            ];

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);

            const responses = await Promise.allSettled(urls.map(u =>
                fetch(u, { signal: controller.signal }).then(r => r.json())
            ));
            clearTimeout(timeoutId);

            let allStreams = [];
            responses.forEach((res, i) => {
                if (res.status === 'fulfilled' && res.value && res.value.streams) {
                    res.value.streams.forEach(s => s.providerName = i === 0 ? "Torrentio" : "Comet");
                    allStreams = allStreams.concat(res.value.streams);
                }
            });

            let validStreams = allStreams.filter(s => {
                const text = (s.title || '').toLowerCase() + ' ' + (s.name || '').toLowerCase();
                if (text.includes('dublado') || text.includes('legendado') || text.includes('pt-br') || text.includes('português')) return false;
                return true;
            });

            if (validStreams.length === 0) throw new Error("No se encontraron enlaces VIP P2P");

            const streams = validStreams.sort((a, b) => {
                const textA = ((a.title || '') + ' ' + (a.name || '')).toLowerCase();
                const textB = ((b.title || '') + ' ' + (b.name || '')).toLowerCase();

                const keywordsLat = ['latino', 'spanish', 'esp', 'español', 'cinecalidad'];
                const aLat = keywordsLat.some(k => textA.includes(k));
                const bLat = keywordsLat.some(k => textB.includes(k));

                // Penalizar si requiere VLC o es multi-idioma
                const keywordsBadAudio = ['ac3', 'eac3', 'dts', 'multi', 'dual'];
                const aBad = keywordsBadAudio.some(k => textA.includes(k));
                const bBad = keywordsBadAudio.some(k => textB.includes(k));

                // 1. Priorizar Latino
                if (aLat && !bLat) return -1;
                if (!aLat && bLat) return 1;

                // 2. Priorizar No-BadAudio (Puro AAC / Nativos para el navegador)
                if (!aBad && bBad) return -1;
                if (aBad && !bBad) return 1;

                // 3. Priorizar Cinecalidad (por sus codificaciones ligeras y doblajes nativos)
                if (textA.includes('cinecalidad') && !textB.includes('cinecalidad')) return -1;
                if (!textA.includes('cinecalidad') && textB.includes('cinecalidad')) return 1;

                return 0;
            });

            // 1. Guardar todos los streams para la sidebar de "Más Fuentes"
            this.lastScrapedStreams = streams;
            this.renderControls(); // Actualizar con la lista de fuentes

            // 2. Auto-Play del mejor
            this.handleExternalStream(streams[0]);

        } catch (e) {
            console.log("Auto-Debrid S1 falló, redirigiendo a respaldo S2...", e);
            if (loaderText) loaderText.innerText = 'Explorando la selva...';
            this.updateServer('latino-2');
        }
    },

    async fetchExternalStreams() {
        if (!this.currentPlayerMovie || (!this.currentPlayerMovie.imdbId && !this.currentPlayerMovie.tmdbId)) return;

        const container = document.getElementById('external-streams-list');
        if (!container) return;

        container.innerHTML = `<div class="addon-loader">🛰️ Rastreando satélites...</div>`;
        container.style.display = 'block';

        const id = this.currentPlayerMovie.imdbId || this.currentPlayerMovie.tmdbId;
        const type = this.currentPlayerMovie.type === 'series' ? 'series' : 'movie';

        try {
            // Fase 3: Buscamos links sin Token de RD por ahora para que no devuelva 403 CORS.
            // Extraeremos la data P2P y después vemos si inyectamos RD localmente.
            const providers = "cinecalidad,mejortorrent,wolfmax4k,yts,eztv,rarbg,1337x,torrent9,limetorrents";
            const tConfig = `providers=${providers}|sort=seeders|qualityfilter=scr,cam`;

            const urls = [
                `https://torrentio.strem.fun/${tConfig}/stream/${type}/${id}.json`,
                `https://comet.strem.fun/stream/${type}/${id}.json`
            ];

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 seg max por intentos fallidos

            const responses = await Promise.allSettled(urls.map(u =>
                fetch(u, { signal: controller.signal })
                    .then(r => r.json())
            ));

            clearTimeout(timeoutId);

            let allStreams = [];
            responses.forEach((res, i) => {
                if (res.status === 'fulfilled' && res.value && res.value.streams) {
                    const provider = i === 0 ? "Torrentio" : "Comet";
                    res.value.streams.forEach(s => s.providerName = provider);
                    allStreams = allStreams.concat(res.value.streams);
                }
            });

            let validStreams = allStreams.filter(s => {
                const text = (s.title || '').toLowerCase() + ' ' + (s.name || '').toLowerCase();
                // Excluir streams brasileños/portugueses que suelen colarse
                if (text.includes('dublado') || text.includes('legendado') || text.includes('pt-br') || text.includes('português')) {
                    return false;
                }
                return true;
            });

            if (validStreams.length === 0) {
                container.innerHTML = `<p style="font-size:0.75rem; color:#aaa; text-align:center;">Ningún satélite encontró la Cocona. 🌴🌵<br><small>Intenta con servidores tradicionales.</small></p>`;
                return;
            }

            const streams = validStreams.sort((a, b) => {
                const textA = ((a.title || '') + ' ' + (a.name || '')).toLowerCase();
                const textB = ((b.title || '') + ' ' + (b.name || '')).toLowerCase();

                const keywordsLat = ['latino', 'spanish', 'esp', 'español', 'cinecalidad'];
                const aLat = keywordsLat.some(k => textA.includes(k));
                const bLat = keywordsLat.some(k => textB.includes(k));

                // Penalizar si requiere VLC o es multi-idioma para que queden abajo en la lista
                const keywordsBadAudio = ['ac3', 'eac3', 'dts', 'multi', 'dual'];
                const aBad = keywordsBadAudio.some(k => textA.includes(k));
                const bBad = keywordsBadAudio.some(k => textB.includes(k));

                if (aLat && !bLat) return -1;
                if (!aLat && bLat) return 1;

                if (!aBad && bBad) return -1;
                if (aBad && !bBad) return 1;

                if (textA.includes('cinecalidad') && !textB.includes('cinecalidad')) return -1;
                if (!textA.includes('cinecalidad') && textB.includes('cinecalidad')) return 1;

                return b.seeders - a.seeders; // Si ambos empatan, priorizar los de más tamaño o seeders
            });

            container.innerHTML = `
                <p style="font-size:0.6rem; color:var(--primary); margin-bottom:10px; font-weight:bold;">📡 RESULTADOS ENCONTRADOS (P2P/DIRECTO):</p>
                ${streams.map((s, i) => {
                const titleParts = s.title.split('\n');
                const title = titleParts[0];
                const meta = titleParts.slice(1).join(' | ');

                const lowerTitle = title.toLowerCase();
                const lowerMeta = meta.toLowerCase();

                const keywordsLatino = ['latino', 'spanish', 'esp', 'español'];
                const isLatino = keywordsLatino.some(k => lowerTitle.includes(k) || lowerMeta.includes(k)) || lowerTitle.includes('cinecalidad');
                const isCinecalidad = lowerTitle.includes('cinecalidad') || (s.title && s.title.toLowerCase().includes('cinecalidad'));
                const isDebrid = lowerTitle.includes('[rd+]') || (s.name && s.name.toLowerCase().includes('[rd+]')) || (lowerMeta.includes('[rd+]'));
                const isMulti = lowerTitle.includes('multi') || lowerTitle.includes('dual') || lowerMeta.includes('multi') || lowerMeta.includes('dual');
                const isAc3 = lowerTitle.includes('ac3') || lowerTitle.includes('dts') || lowerTitle.includes('eac3') || lowerMeta.includes('ac3') || lowerMeta.includes('dts');

                let badge = isLatino ? '<span style="background:var(--primary); color:black; padding:2px 4px; border-radius:4px; font-size:0.55rem; margin-left:5px;">⭐ LATINO / ESP</span>' : '';
                if (isCinecalidad) badge += '<span style="background:#00d2ff; color:black; padding:2px 4px; border-radius:4px; font-size:0.55rem; margin-left:5px;">💎 LATINO PURO</span>';
                if (isDebrid) badge += '<span style="background:#2ecc71; color:black; padding:2px 4px; border-radius:4px; font-size:0.55rem; margin-left:5px;">🚀 DEBRID VIP</span>';
                if (isMulti) badge += '<span style="background:#9b59b6; color:white; padding:2px 4px; border-radius:4px; font-size:0.55rem; margin-left:5px;">🌐 MULTI (Cambiar en VLC)</span>';
                if (isAc3) badge += '<span style="background:#e74c3c; color:white; padding:2px 4px; border-radius:4px; font-size:0.55rem; margin-left:5px;">⚠️ AUD AC3 (Usar VLC)</span>';

                return `
                        <div class="stream-item" onclick="SelvaStream.handleExternalStream(${JSON.stringify(s).replace(/"/g, '&quot;')})" style="padding: 10px; margin-bottom: 5px; cursor: pointer; border-radius: 5px; border-left: 4px solid #555; background: rgba(255,255,255,0.05); ${isLatino ? 'border-left-color: var(--primary); background: rgba(255,122,0,0.08);' : ''} ${isDebrid ? 'border-left-color:#2ecc71; background: rgba(46,204,113,0.1);' : ''}">
                            <div class="stream-name" style="font-size: 0.8rem; font-weight: bold;">${s.providerName || 'Fuente'} ${badge}</div>
                            <div class="stream-title" style="font-size: 0.9rem; margin-top: 3px;">${title}</div>
                            <div class="stream-meta" style="font-size: 0.7rem; color: #aaa; margin-top: 3px;">${meta}</div>
                        </div>
                    `;
            }).join('')}
            `;
        } catch (e) {
            console.error('Error fetching external streams', e);
            container.innerHTML = `<p>Error al conectar con los satélites externos.</p>`;
        }
    },

    handleExternalStream(stream) {
        console.log("Cargando fuente externa:", stream);

        // Mapeo Heurístico (Analytics Local): Recordamos qué proveedor usamos
        localStorage.setItem(`last_source_${this.currentPlayerMovie.id}`, stream.providerName || 'Unknown');

        const iframe = document.getElementById('player-iframe');
        const nativePlayer = document.getElementById('native-video-player');
        const statusDiv = document.getElementById('webtorrent-status');
        const loader = document.getElementById('player-loader');

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
                const startScreen = document.getElementById('player-start-screen');
                if (startScreen) startScreen.style.display = 'none';

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
                        this.hls.on(Hls.Events.MANIFEST_PARSED, () => nativePlayer.play());
                    } else if (nativePlayer.canPlayType('application/vnd.apple.mpegurl')) {
                        nativePlayer.src = stream.url;
                        nativePlayer.play();
                    }
                } else {
                    nativePlayer.src = stream.url;
                    nativePlayer.play();
                }

                // Si es un source directo, le pasamos la URL al botón externo
                const extBtn = document.getElementById('external-player-btn');
                extBtn.style.display = 'flex';

                const isAndroid = /Android/i.test(navigator.userAgent);
                extBtn.href = isAndroid
                    ? `intent://${stream.url.replace(/^https?:\/\//, '')}#Intent;package=org.videolan.vlc;type=video/*;scheme=https;end`
                    : `vlc://${stream.url}`;

            } else {
                // Posiblemente un Iframe externo
                const startScreen = document.getElementById('player-start-screen');
                if (startScreen) startScreen.style.display = 'none';

                const nativeContainer = document.getElementById('native-player-container');
                if (nativeContainer) nativeContainer.style.display = 'none';
                statusDiv.style.display = 'none';
                nativePlayer.pause();
                iframe.style.display = 'block';
                iframe.src = stream.url;
                loader.style.display = 'flex';
            }
        } else if (stream.infoHash) {
            // FASE 3: Motor VIP 🚀 (Debrid API directa o Local P2P)
            iframe.style.display = 'none';
            iframe.src = '';
            loader.style.display = 'none';

            const nativeContainer = document.getElementById('native-player-container');
            const extBtn = document.getElementById('external-player-btn');
            nativeContainer.style.display = 'block';
            statusDiv.style.display = 'block';
            extBtn.style.display = 'none'; // Ocultar hasta tener link

            // Clean Native Player
            nativePlayer.pause();
            nativePlayer.removeAttribute('src');
            nativePlayer.load();

            if (true) { // Usamos el Master Worker si está configurado
                document.getElementById('webtorrent-status').querySelector('div:first-child').innerText = '🚀 Invocando Puente VIP Soberano...';
                document.getElementById('wt-progress').innerText = `Procesando en Cloudflare...`;

                this.callMasterWorker(stream.infoHash).then(result => {
                    if (result && result.url) {
                        nativePlayer.src = result.url;
                        nativePlayer.play().catch(e => console.warn("Auto-play prevented", e));

                        // Preparar botón de VLC/Externo
                        const isAndroid = /Android/i.test(navigator.userAgent);
                        const vlcUrl = isAndroid
                            ? `intent://${result.url.replace(/^https?:\/\//, '')}#Intent;package=org.videolan.vlc;type=video/*;scheme=https;end`
                            : `vlc://${result.url}`;

                        extBtn.href = vlcUrl;
                        extBtn.style.display = 'flex';

                        setTimeout(() => { document.getElementById('webtorrent-status').style.display = 'none'; }, 2000);
                    } else {
                        document.getElementById('wt-progress').innerText = result?.error || 'Error en el Búnker';
                    }
                });
            } else if (window.WebTorrent) {
                // Descarga P2P Tradicional (Sin Debrid)
                this.torrentClient = new window.WebTorrent();

                nativePlayer.style.display = 'block';
                statusDiv.style.display = 'block';

                this.torrentClient = new window.WebTorrent();

                let magnetURI = stream.url || `magnet:?xt=urn:btih:${stream.infoHash}`;

                document.getElementById('wt-progress').innerText = `Resolviendo Torrent...`;

                this.torrentClient.add(magnetURI, (torrent) => {
                    const file = torrent.files.find(function (file) {
                        return file.name.endsWith('.mp4') || file.name.endsWith('.mkv') || file.name.endsWith('.webm');
                    });

                    if (file) {
                        file.renderTo(nativePlayer);
                        torrent.on('download', (bytes) => {
                            const progress = Math.max(0, Math.min(100, (torrent.progress * 100))).toFixed(1);
                            const speed = (torrent.downloadSpeed / 1024 / 1024).toFixed(2);
                            document.getElementById('wt-progress').innerText =
                                `Velocidad: ${speed} MB/s | Descargado: ${progress}%`;
                        });
                    } else {
                        document.getElementById('wt-progress').innerText = `Error: No se encontró el archivo MP4/MKV`;
                    }
                });

                this.torrentClient.on('error', (err) => {
                    console.error('[WebTorrent Error]', err);
                    document.getElementById('wt-progress').innerText = `Error P2P: ${err.message}`;
                });
            } else {
                alert("No se pudo abrir. Verifique la conexión.");
            }
        }
    },

    async callMasterWorker(infoHash) {
        try {
            const magnet = `magnet:?xt=urn:btih:${infoHash}`;
            const role = 'admin'; // Futuro: localStorage.getItem('user_role')

            const url = `${this.MASTER_WORKER_URL}/flix/unrestrict?magnet=${encodeURIComponent(magnet)}&role=${role}`;

            const res = await fetch(url, {
                headers: { 'x-selva-auth': this.AUTH_TOKEN }
            });

            if (!res.ok) throw new Error(`HTTP_${res.status}`);
            return await res.json();
        } catch (error) {
            console.error('[Worker Connection Error]', error);
            return { error: error.message };
        }
    }
};

window.SelvaStream = SelvaStream;
