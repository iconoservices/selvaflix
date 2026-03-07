/* 
   🦅 SelvaStream Engine v1.0
   Arquitecto: Antigravity
   Misión: Encapsulamiento de reproducción segura y premium.
*/

export const SelvaStream = {
    currentPlayerMovie: null,
    torrentClient: null,

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
                    <video id="native-video-player" style="display:none; width: 100%; height: 100%; background: #000;" controls></video>
                    
                    <div id="webtorrent-status" style="display:none; position:absolute; bottom:20px; left:20px; background:rgba(0,0,0,0.8); padding:10px; border-radius:8px; color:#fff; font-size:12px; z-index:100; border: 1px solid var(--primary);">
                        <div style="color:var(--primary); font-weight:bold; margin-bottom:5px;">🕸️ Conectando a la red P2P...</div>
                        <div id="wt-progress">Buscando semillas...</div>
                    </div>
                </div>
                <div class="guide-sidebar">
                    <h3>📌 Tip de Supervivencia</h3>
                    <p>¿Aparece "No se puede cargar"? <b>¡El motor se auto-reparará!</b></p>
                    <ol>
                        <li>Si el servidor actual está lleno...</li>
                        <li>SelvaFlix buscará otra ruta.</li>
                        <li>Solo relájate y disfruta del paisaje.</li>
                    </ol>
                    <p style="font-size: 0.7rem; color: var(--primary); margin-top: 15px;">🛡️ Recomendamos usar Brave Browser.</p>
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
        document.getElementById('close-player').onclick = () => this.close();

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
        document.body.style.overflow = 'hidden'; // Bloqueo de scroll

        // Reset players visibility
        const iframe = document.getElementById('player-iframe');
        const nativePlayer = document.getElementById('native-video-player');
        const statusDiv = document.getElementById('webtorrent-status');
        if (iframe) iframe.style.display = 'block';
        if (nativePlayer) {
            nativePlayer.style.display = 'none';
            nativePlayer.pause();
        }
        if (statusDiv) statusDiv.style.display = 'none';

        // Reset loader
        const loader = document.getElementById('player-loader');
        loader.style.display = 'flex';
        loader.style.opacity = '1';

        this.renderControls();

        // Si es serie, cargar metadatos de TMDB para temporadas
        const isSeries = ['series', 'tv', 'anime'].includes(movie.type);
        if (isSeries && movie.tmdbId) {
            await this.loadSeriesMetadata(movie.tmdbId);
        }

        this.loadInitialSource();
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
        const movie = this.currentPlayerMovie;
        const iframe = document.getElementById('player-iframe');

        if (movie.tmdbId) {
            // Prioridad Inteligente (v4.5.3)
            const pref = localStorage.getItem('selva_pref_lang') || 'latino';
            if (pref === 'english') {
                this.updateServer('english-1');
            } else {
                this.updateServer('latino-1'); // S1 es muy estable en Latino con parámetros
            }
        } else {
            const cleanUrl = this.sanitizeUrl(movie.embed);
            iframe.src = cleanUrl;
        }
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
        const nativePlayer = document.getElementById('native-video-player');
        const statusDiv = document.getElementById('webtorrent-status');
        const loader = document.getElementById('player-loader');

        if (iframe) iframe.style.display = 'block';
        if (nativePlayer) {
            nativePlayer.style.display = 'none';
            nativePlayer.pause();
        }
        if (statusDiv) statusDiv.style.display = 'none';

        loader.style.display = 'flex';
        loader.style.opacity = '1';

        // Preferencia Rey (Aumenta probabilidad de audio correcto)
        const pref = localStorage.getItem('selva_pref_lang') || 'latino';
        const langParam = pref === 'latino' ? '&ds_lang=es' : '';

        let url = "";
        switch (serverKey) {
            case 'latino-1': url = isSeries ? `https://multiembed.mov/direct/tv.php?${hasImdb ? `imdb=${idValue}` : `tmdb=${idValue}`}&s=${season}&e=${episode}${langParam}` : `https://multiembed.mov/direct/movie.php?${hasImdb ? `imdb=${idValue}` : `tmdb=${idValue}`}${langParam}`; break;
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

    renderControls() {
        const root = document.getElementById('player-controls-root');
        if (!root) return;

        const isSeries = ['series', 'tv', 'anime'].includes(this.currentPlayerMovie.type);

        const activeBtn = document.querySelector('.server-btn.active');
        const currentServer = activeBtn ? activeBtn.dataset.server : 'latino-1';
        const isShieldOn = localStorage.getItem(`selva_shield_${currentServer}`) === 'true';
        const protection = this.getProtectionData();

        // Preferencia de Idioma (v4.5.3)
        const pref = localStorage.getItem('selva_pref_lang') || 'latino';

        root.innerHTML = `
            <div class="player-controls">
                <div class="pref-selector" style="display:flex; justify-content:center; gap:10px; margin-bottom:15px; background: rgba(255,122,0,0.05); padding:10px; border-radius:12px; border:1px solid rgba(255,122,0,0.15);">
                    <button class="pref-btn ${pref === 'latino' ? 'active' : ''}" onclick="SelvaStream.setPreference('latino')" style="flex:1; background:${pref === 'latino' ? 'var(--primary)' : 'rgba(255,255,255,0.05)'}; border:none; color:${pref === 'latino' ? 'black' : 'white'}; padding:8px; border-radius:8px; font-weight:bold; cursor:pointer;">🇲🇽 LATINO</button>
                    <button class="pref-btn ${pref === 'english' ? 'active' : ''}" onclick="SelvaStream.setPreference('english')" style="flex:1; background:${pref === 'english' ? 'var(--primary)' : 'rgba(255,255,255,0.05)'}; border:none; color:${pref === 'english' ? 'black' : 'white'}; padding:8px; border-radius:8px; font-weight:bold; cursor:pointer;">🇺🇸 SUB/ENGLISH</button>
                </div>

                ${isSeries ? `
                    <div class="series-navigator">
                        <select id="selva-season" class="selva-select">
                            <option value="1">Temporada 1</option>
                        </select>
                        <select id="selva-episode" class="selva-select">
                            <option value="1">Capítulo 1</option>
                        </select>
                    </div>
                ` : ''}
                
                <div class="server-switcher">
                    <div class="server-group">
                        <span>${pref === 'latino' ? '🇲🇽 PRIORIDAD LATINO:' : '🌐 SERVIDORES:'}</span>
                        <button class="server-btn ${currentServer === 'latino-1' ? 'active' : ''}" data-server="latino-1" onclick="SelvaStream.updateServer('latino-1'); SelvaStream.renderControls();">S1 (VIP)</button>
                        <button class="server-btn ${currentServer === 'latino-5' ? 'active' : ''}" data-server="latino-5" onclick="SelvaStream.updateServer('latino-5'); SelvaStream.renderControls();">S5</button>
                        <button class="server-btn ${currentServer === 'latino-2' ? 'active' : ''}" data-server="latino-2" onclick="SelvaStream.updateServer('latino-2'); SelvaStream.renderControls();">S2</button>
                        <button class="server-btn ${currentServer === 'latino-4' ? 'active' : ''}" data-server="latino-4" onclick="SelvaStream.updateServer('latino-4'); SelvaStream.renderControls();">S4</button>
                        <button class="server-btn ${currentServer === 'latino-6' ? 'active' : ''}" data-server="latino-6" onclick="SelvaStream.updateServer('latino-6'); SelvaStream.renderControls();">S6</button>
                    </div>
                </div>

                <div class="shield-toggle-container">
                    <button class="shield-btn ${isShieldOn ? 'shield-protected' : 'shield-warning'}" onclick="SelvaStream.toggleShield()">
                        ${isShieldOn ? '🛡️ Escudo al 100% (Modo Seguro)' : '🛡️ Escudo Desactivado (Compatible)'}
                    </button>
                </div>

                <div class="addon-discovery-section" style="margin-top: 20px; text-align: center;">
                    <button class="addon-search-btn" onclick="SelvaStream.fetchExternalStreams()" style="background: var(--primary); color: black; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">
                        🔍 Buscar Fuentes Externas (Sin Anuncios / 4K)
                    </button>
                    <div id="external-streams-list" class="external-streams-container" style="display:none; margin-top: 15px; text-align: left;"></div>
                </div>

                <div class="protection-center">
                    <h4>🛡️ Centro de Protección Selva</h4>
                    <p>${protection.desc}</p>
                    <a href="${protection.link}" target="_blank" class="protection-link">
                        ${protection.icon} ${protection.name}
                    </a>
                </div>

                <a id="selva-download-btn" href="#" target="_blank" class="selva-download-btn" style="display:none;">
                    ⬇️ Descargar
                </a>
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

        if (this.torrentClient) {
            try {
                this.torrentClient.destroy();
            } catch (e) { }
            this.torrentClient = null;
        }

        document.body.style.overflow = ''; // Restaurar scroll
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

            const responses = await Promise.allSettled(urls.map(u => fetch(u).then(r => r.json())));

            let allStreams = [];
            responses.forEach((res, i) => {
                if (res.status === 'fulfilled' && res.value && res.value.streams) {
                    const provider = i === 0 ? "Torrentio" : "Comet";
                    res.value.streams.forEach(s => s.providerName = provider);
                    allStreams = allStreams.concat(res.value.streams);
                }
            });

            if (allStreams.length === 0) {
                container.innerHTML = `<p style="font-size:0.75rem; color:#aaa; text-align:center;">Ningún satélite encontró la Cocona. 🌴🌵<br><small>Intenta con servidores tradicionales.</small></p>`;
                return;
            }

            const streams = allStreams.sort((a, b) => {
                const keywords = ['latino', 'spanish', 'esp', 'multi', 'dual', 'español'];
                const aMatch = keywords.some(k => a.title.toLowerCase().includes(k));
                const bMatch = keywords.some(k => b.title.toLowerCase().includes(k));
                if (aMatch && !bMatch) return -1;
                if (!aMatch && bMatch) return 1;
                return 0;
            });

            container.innerHTML = `
                <p style="font-size:0.6rem; color:var(--primary); margin-bottom:10px; font-weight:bold;">📡 RESULTADOS ENCONTRADOS (P2P/DIRECTO):</p>
                ${streams.map((s, i) => {
                const titleParts = s.title.split('\n');
                const title = titleParts[0];
                const meta = titleParts.slice(1).join(' | ');

                const keywords = ['latino', 'spanish', 'esp', 'multi', 'dual', 'español'];
                const isLatino = keywords.some(k => s.title.toLowerCase().includes(k)) || title.toLowerCase().includes('cinecalidad');
                const isCinecalidad = title.toLowerCase().includes('cinecalidad') || (s.title && s.title.toLowerCase().includes('cinecalidad'));

                const isDebrid = title.includes('[RD+]') || (s.name && s.name.includes('[RD+]')) || (s.title && s.title.includes('[RD+]'));
                let badge = isLatino ? '<span style="background:var(--primary); color:black; padding:2px 4px; border-radius:4px; font-size:0.55rem; margin-left:5px;">⭐ LATINO / MULTI</span>' : '';
                if (isCinecalidad) badge += '<span style="background:#00d2ff; color:black; padding:2px 4px; border-radius:4px; font-size:0.55rem; margin-left:5px;">💎 LATINO PURO</span>';
                if (isDebrid) badge += '<span style="background:#2ecc71; color:black; padding:2px 4px; border-radius:4px; font-size:0.55rem; margin-left:5px;">🚀 DEBRID VIP (Carga Instantánea)</span>';

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
        const iframe = document.getElementById('player-iframe');
        const nativePlayer = document.getElementById('native-video-player');
        const statusDiv = document.getElementById('webtorrent-status');
        const loader = document.getElementById('player-loader');

        if (this.torrentClient) {
            this.torrentClient.destroy();
            this.torrentClient = null;
        }

        if (stream.url && !stream.infoHash) {
            // Es un link directo. Puede ser un Iframe o un Video MP4 de Real-Debrid
            const isDirectVideo = stream.url.endsWith('.mp4') || stream.url.endsWith('.mkv') || stream.name?.includes('[RD+]') || stream.title?.includes('[RD+]');

            if (isDirectVideo) {
                // Motor VIP de Real Debrid (Reproductor Nativo con URL directa)
                iframe.style.display = 'none';
                iframe.src = '';
                statusDiv.style.display = 'none';
                loader.style.display = 'none';

                nativePlayer.style.display = 'block';
                nativePlayer.src = stream.url;
                nativePlayer.play();
            } else {
                // Posiblemente un Iframe externo
                nativePlayer.style.display = 'none';
                statusDiv.style.display = 'none';
                nativePlayer.pause();
                iframe.style.display = 'block';
                iframe.src = stream.url;
                loader.style.display = 'flex';
            }
        } else if (stream.infoHash && window.WebTorrent) {
            // Descarga P2P Tradicional (Sin Debrid)
            iframe.style.display = 'none';
            iframe.src = '';

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
            alert("No se pudo abrir. Verifique que WebTorrent esté cargado.");
        }
    }
};

window.SelvaStream = SelvaStream;
