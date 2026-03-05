/* 
   🦅 SelvaStream Engine v1.0
   Arquitecto: Antigravity
   Misión: Encapsulamiento de reproducción segura y premium.
*/

export const SelvaStream = {
    currentPlayerMovie: null,

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
                        sandbox="allow-forms allow-scripts allow-same-origin allow-popups-to-escape-sandbox allow-presentation"
                        allowfullscreen>
                    </iframe>
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

    /**
     * Rescate de emergencia si el servidor actual bloquea el iframe.
     */
    handlePlayerError() {
        console.warn("⚠️ Servidor bloqueado u hostil detectado. Activando Fallback...");
        const activeBtn = document.querySelector('.server-btn.active');
        const currentServer = activeBtn ? activeBtn.dataset.server : '';

        // Si falló el PRO (5) o S1, saltamos directo al confiable Streamwish (S2)
        if (currentServer === 'latino-5' || currentServer === 'latino-1') {
            const s = document.getElementById('selva-season')?.value || 1;
            const e = document.getElementById('selva-episode')?.value || 1;
            console.log("🔄 Saltando automáticamente al Servidor 2 (Respaldo)");

            // Actualizamos visualmente el botón a "Saturado"
            if (activeBtn) {
                activeBtn.innerText = "⏳ Vuelve en 1h";
                activeBtn.style.background = "rgba(231, 76, 60, 0.4)";
                activeBtn.style.borderColor = "#c0392b";
            }

            this.updateServer('latino-2', s, e);
        }
    },
    /**
     * Abre el reproductor con el contenido seleccionado.
     */
    async open(movie) {
        this.currentPlayerMovie = movie;
        this.init();
        const modal = document.getElementById('player-modal');
        modal.style.display = 'flex';

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
        const server = activeBtn ? activeBtn.dataset.server : 'latino-5';
        this.updateServer(server, s, e);
    },

    loadInitialSource() {
        const movie = this.currentPlayerMovie;
        const iframe = document.getElementById('player-iframe');

        if (movie.tmdbId) {
            // Activar rotación de servidores
            this.updateServer('latino-5');
        } else {
            const cleanUrl = this.sanitizeUrl(movie.embed);
            iframe.src = cleanUrl;
        }
    },

    updateServer(serverKey, season = 1, episode = 1) {
        if (!this.currentPlayerMovie || !this.currentPlayerMovie.tmdbId) return;

        const tmdbId = this.currentPlayerMovie.tmdbId;
        const type = this.currentPlayerMovie.type || 'movie';
        const isSeries = type === 'series' || type === 'tv' || type === 'anime';

        const iframe = document.getElementById('player-iframe');
        const loader = document.getElementById('player-loader');

        loader.style.display = 'flex';
        loader.style.opacity = '1';

        let url = "";
        switch (serverKey) {
            case 'latino-1': url = isSeries ? `https://vidsrc.me/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}&ds_lang=es` : `https://vidsrc.me/embed/movie?tmdb=${tmdbId}&ds_lang=es`; break;
            case 'latino-2': url = isSeries ? `https://vidsrc.to/embed/tv/${tmdbId}/${season}/${episode}` : `https://vidsrc.to/embed/movie/${tmdbId}`; break;
            case 'latino-3': url = isSeries ? `https://vidsrc.xyz/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}&ds_lang=es` : `https://vidsrc.xyz/embed/movie?tmdb=${tmdbId}&ds_lang=es`; break;
            case 'latino-4': url = isSeries ? `https://embed.su/embed/tv/${tmdbId}/${season}/${episode}` : `https://embed.su/embed/movie/${tmdbId}`; break;
            case 'latino-5': url = isSeries ? `https://vidsrc.pro/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}` : `https://vidsrc.pro/embed/movie?tmdb=${tmdbId}`; break;
            case 'latino-6': url = isSeries ? `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}` : `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1`; break;
            case 'english-1': url = isSeries ? `https://vidsrc.xyz/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}` : `https://vidsrc.xyz/embed/movie?tmdb=${tmdbId}`; break;
            case 'english-2': url = isSeries ? `https://www.2embed.cc/embed/${tmdbId}&s=${season}&e=${episode}` : `https://www.2embed.cc/embed/${tmdbId}`; break;
            default: url = `https://vidsrc.xyz/embed/${isSeries ? 'tv' : 'movie'}?tmdb=${tmdbId}`;
        }

        const cleanUrl = this.sanitizeUrl(url);

        // ── Pacto de Carga (Sandbox Dinámico) ──
        const isCompatibleMode = localStorage.getItem(`selva_compat_${serverKey}`) === 'true';
        if (isCompatibleMode) {
            iframe.setAttribute('sandbox', 'allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation');
        } else {
            iframe.setAttribute('sandbox', 'allow-forms allow-scripts allow-same-origin allow-popups-to-escape-sandbox allow-presentation');
        }

        iframe.src = cleanUrl;
        this.updateDownloadBtn(cleanUrl);

        // Actualizar UI de botones
        document.querySelectorAll('.server-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.server === serverKey);
        });
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

    // ── Shield Toggle (Interruptor de Protección) ──
    toggleCompatibleMode() {
        const activeBtn = document.querySelector('.server-btn.active');
        if (!activeBtn) return;
        const serverKey = activeBtn.dataset.server;
        const isCurrentlyCompatible = localStorage.getItem(`selva_compat_${serverKey}`) === 'true';

        if (!isCurrentlyCompatible) {
            // El usuario quiere relajar la seguridad
            const consent = confirm('⚠️ ATENCIÓN:\n\nVas a entrar en Modo Compatible.\nEsto permite que el video cargue, pero el servidor podría lanzarte ventanas de publicidad.\n\nSelvaFlix no podrá bloquear los pop-ups en este modo para este servidor.\n\n¿Estás de acuerdo con asumir el riesgo?');
            if (consent) {
                localStorage.setItem(`selva_compat_${serverKey}`, 'true');
                console.warn(`🔓 Pacto de Carga: Modo Compatible ACTIVADO para ${serverKey}.`);
            } else {
                return; // Acción cancelada por el usuario
            }
        } else {
            // El usuario quiere volver a blindarse
            localStorage.removeItem(`selva_compat_${serverKey}`);
            console.log(`🛡️ Modo Selva: Escudos RESTAURADOS para ${serverKey}.`);
        }

        // Recargar con el nuevo estado (el iframe y el toggle se actualizan)
        const s = document.getElementById('selva-season')?.value || 1;
        const e = document.getElementById('selva-episode')?.value || 1;
        this.updateServer(serverKey, s, e);
        this.renderControls();
    },

    renderControls() {
        const root = document.getElementById('player-controls-root');
        if (!root) return;

        const isSeries = ['series', 'tv', 'anime'].includes(this.currentPlayerMovie.type);

        const activeBtn = document.querySelector('.server-btn.active');
        const currentServer = activeBtn ? activeBtn.dataset.server : 'latino-5';
        const isCompatibleMode = localStorage.getItem(`selva_compat_${currentServer}`) === 'true';

        root.innerHTML = `
            <div class="player-controls">
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
                        <span>🇲🇽/🇪🇸 ESPAÑOL:</span>
                        <button class="server-btn ${currentServer === 'latino-5' ? 'active' : ''}" data-server="latino-5" onclick="SelvaStream.updateServer('latino-5'); SelvaStream.renderControls();">🔥 Pro (VIP)</button>
                        <button class="server-btn ${currentServer === 'latino-1' ? 'active' : ''}" data-server="latino-1" onclick="SelvaStream.updateServer('latino-1'); SelvaStream.renderControls();">S1</button>
                        <button class="server-btn ${currentServer === 'latino-2' ? 'active' : ''}" data-server="latino-2" onclick="SelvaStream.updateServer('latino-2'); SelvaStream.renderControls();">S2</button>
                        <button class="server-btn ${currentServer === 'latino-4' ? 'active' : ''}" data-server="latino-4" onclick="SelvaStream.updateServer('latino-4'); SelvaStream.renderControls();">S4</button>
                        <button class="server-btn ${currentServer === 'latino-6' ? 'active' : ''}" data-server="latino-6" onclick="SelvaStream.updateServer('latino-6'); SelvaStream.renderControls();">S6 (Auto)</button>
                    </div>
                    <div class="server-group" style="margin-top: 10px;">
                        <span style="color: var(--text-muted);">🇺🇸 SUB / EN:</span>
                        <button class="server-btn ${currentServer === 'english-1' ? 'active' : ''}" data-server="english-1" onclick="SelvaStream.updateServer('english-1'); SelvaStream.renderControls();">EN (Def)</button>
                        <button class="server-btn ${currentServer === 'english-2' ? 'active' : ''}" data-server="english-2" onclick="SelvaStream.updateServer('english-2'); SelvaStream.renderControls();">EN (Alt)</button>
                    </div>
                </div>

                <div class="shield-toggle-container">
                    <button class="shield-btn ${isCompatibleMode ? 'shield-warning' : 'shield-protected'}" onclick="SelvaStream.toggleCompatibleMode()">
                        ${isCompatibleMode ? '⚠️ Modo Compatible (Anuncios)' : '🛡️ Modo Selva (Protegido)'}
                    </button>
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
        if (modal) modal.style.display = 'none';
        if (iframe) iframe.src = '';
    }
};

window.SelvaStream = SelvaStream;
