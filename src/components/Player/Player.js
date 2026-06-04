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
        if (document.getElementById('admin-player-toolbar')) return;

        modal.innerHTML = `
            <div class="player-back-arrow" id="player-back-btn" title="Atrás (Esc)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
            </div>

            <div id="admin-player-toolbar" class="admin-player-toolbar" style="display:none; position: absolute; top: 10px; left: 60px; z-index: 1000;">
                <!-- Botones flotantes opcionales o vacíos, ahora se integrarán en sidebar -->
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
                            <h3 style="color: var(--primary); font-size: 0.6rem; letter-spacing: 1px; margin-bottom: 10px; opacity: 0.8;">🚨 SOPORTE</h3>
                            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; margin-bottom: 15px;">
                                <button id="report-broken-btn" style="background: rgba(231,76,60,0.1); border: 1px solid rgba(231,76,60,0.2); color: #E74C3C; padding: 10px; border-radius: 8px; font-size: 0.65rem; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px;">🚩 REPORTAR</button>
                                <button id="share-selva-btn" style="background: rgba(46,204,113,0.1); border: 1px solid rgba(46,204,113,0.2); color: #2ecc71; padding: 10px; border-radius: 8px; font-size: 0.65rem; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px;">🔗 COMPARTIR</button>
                            </div>
                            
                            <div id="admin-only-panel" style="display:none; flex-direction:column; gap:8px; border-top:1px solid rgba(255,255,255,0.08); padding-top:15px; margin-top: 5px;">
                                <h3 style="color: #00f2ff; font-size: 0.6rem; letter-spacing: 1px; margin-bottom: 5px; opacity: 0.8;">🛠️ ADMINISTRACIÓN</h3>
                                
                                <div id="admin-reviewer-actions" style="display:flex; flex-direction:column; gap:6px; margin-bottom:10px;">
                                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px;">
                                        <button id="admin-approve-player-btn" style="background:#2ecc71; color:black; border:none; padding:8px; border-radius:6px; cursor:pointer; font-weight:900; font-size: 0.6rem;">✅ APROBAR</button>
                                        <button id="admin-wait-player-btn" style="background:#f1c40f; color:black; border:none; padding:8px; border-radius:6px; cursor:pointer; font-weight:900; font-size: 0.6rem;">⏳ ESPERA</button>
                                    </div>
                                    <button id="admin-delete-player-btn" style="width:100%; background:#e74c3c; color:white; border:none; padding:8px; border-radius:6px; cursor:pointer; font-weight:900; font-size: 0.6rem;">🗑️ BORRAR</button>
                                </div>

                                <button id="admin-vip-config-btn" style="width:100%; background: linear-gradient(45deg, #FFD700, #FFA500); color: black; border:none; padding:10px; border-radius:10px; cursor:pointer; font-weight:900; font-size: 0.7rem; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 15px rgba(255,215,0,0.3); margin-bottom: 5px;">
                                    <span>👑 CONFIGURAR VIP</span>
                                </button>

                                <div class="admin-manual-link-box" style="background: rgba(0,242,255,0.05); border: 1px solid rgba(0,242,255,0.1); padding: 8px; border-radius: 8px; margin-bottom: 10px;">
                                    <label style="color: #00f2ff; font-size: 0.55rem; font-weight: 800; display: block; margin-bottom: 5px;">👑 LINK MAESTRO (PRIORIDAD)</label>
                                    <input type="text" id="admin-manual-link-input" placeholder="Pegar URL aquí..." style="width: 100%; background: #000; border: 1px solid #333; color: white; border-radius: 4px; padding: 6px; font-size: 0.65rem; outline: none; margin-bottom: 6px;">
                                    <button id="admin-set-priority-btn" style="width: 100%; background: #00f2ff; color: #000; border: none; padding: 6px; border-radius: 4px; font-size: 0.6rem; font-weight: 900; cursor: pointer;">FIJAR PRIORIDAD</button>
                                </div>

                                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; margin-top:5px;">
                                    <button id="admin-download-btn" style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 10px; border-radius: 8px; font-size: 0.65rem; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px;">⬇️ DESCARGA</button>
                                    <button id="admin-copy-video-link-btn" style="background: rgba(0,242,255,0.05); border: 1px solid rgba(0,242,255,0.1); color: #00f2ff; padding: 10px; border-radius: 8px; font-size: 0.65rem; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px;">📋 COPIAR VIDEO</button>
                                </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <!-- Controles y Servidores -->
            <div id="player-controls-root"></div>
        `;

        // Eventos básicos eliminados: La X ya no existe, popstate manda.

        document.getElementById('admin-delete-player-btn')?.addEventListener('click', () => {
            if (window.deleteMovie && SelvaStream.currentPlayerMovie) {
                const id = SelvaStream.currentPlayerMovie.id;
                let hasNext = window.playNextReview ? window.playNextReview(id) : false;
                window.deleteMovie(id);
                if (!hasNext) history.back();
            }
        });

        document.getElementById('admin-approve-player-btn')?.addEventListener('click', () => {
            if (window.approveMovie && SelvaStream.currentPlayerMovie) {
                const id = SelvaStream.currentPlayerMovie.id;
                let hasNext = window.playNextReview ? window.playNextReview(id) : false;
                window.approveMovie(id);
                if (!hasNext) history.back();
            }
        });
        
        document.getElementById('admin-wait-player-btn')?.addEventListener('click', () => {
            if (window.moveToWaiting && SelvaStream.currentPlayerMovie) {
                const id = SelvaStream.currentPlayerMovie.id;
                let hasNext = window.playNextReview ? window.playNextReview(id) : false;
                window.moveToWaiting(id);
                if (!hasNext) history.back();
            }
        });

        document.getElementById('admin-vip-config-btn')?.addEventListener('click', async () => {
            if (!SelvaStream.currentPlayerMovie) return;
            const movie = SelvaStream.currentPlayerMovie;
            const isCurrentlyVip = movie.isVIP || false;
            
            const action = confirm(`Estado Actual: ${isCurrentlyVip ? "👑 VIP" : "🐾 LIBRE"}\n\n¿Quieres cambiar el estado VIP de "${movie.title}"?`);
            
            if (action) {
                const newVipStatus = !isCurrentlyVip;
                let releaseDate = movie.releaseDate || null;

                if (newVipStatus) {
                    const dateStr = prompt("¿Deseas poner una fecha de estreno? (Formato: AAAA-MM-DD HH:MM)\nDejar vacío para VIP permanente.", "");
                    if (dateStr) {
                        const parsed = new Date(dateStr);
                        if (!isNaN(parsed.getTime())) {
                            releaseDate = parsed.getTime();
                        } else {
                            alert("Fecha no válida. No se guardará la fecha.");
                        }
                    } else {
                        releaseDate = null;
                    }
                }

                try {
                    const { getFirestore, doc, updateDoc } = await import("firebase/firestore");
                    const db = getFirestore();
                    const movieRef = doc(db, "movies", movie.id);
                    
                    const updateData = { 
                        isVIP: newVipStatus, 
                        releaseDate: releaseDate,
                        updatedAt: Date.now()
                    };
                    
                    await updateDoc(movieRef, updateData);
                    
                    // Sincronizar localmente
                    movie.isVIP = newVipStatus;
                    movie.releaseDate = releaseDate;
                    
                    if (window.showToast) {
                        window.showToast(`✅ VIP ${newVipStatus ? 'ACTIVADO' : 'DESACTIVADO'} para "${movie.title}"`, "success");
                    }
                    
                    // Opcional: Refrescar la UI de la home si es necesario
                    sessionStorage.removeItem('selvaflix_full_database');
                    sessionStorage.removeItem('selvaflix_cache_timestamp');

                } catch (e) {
                    console.error("Error actualizando VIP:", e);
                    if (window.showToast) window.showToast("Error al guardar cambios VIP.", "error");
                }
            }
        });

        document.getElementById('player-back-btn')?.addEventListener('click', () => {
            history.back();
        });

        // --- Admin Functions for Sidebar ---
        document.getElementById('admin-set-priority-btn')?.addEventListener('click', async () => {
            const input = document.getElementById('admin-manual-link-input');
            let link = input.value.trim();
            if (!SelvaStream.currentPlayerMovie || !link) return;

            // 🧹 LIMPIEZA ATÓMICA: Extraer URL si pegan el iframe completo
            if (link.includes('<iframe')) {
                const srcMatch = link.match(/src="([^"]+)"/);
                if (srcMatch) link = srcMatch[1];
            }

            // 🎥 NORMALIZACIÓN: Forzar formato embed /e/ para Streamtape
            if (link.includes('streamtape.com/v/')) {
                link = link.replace('/v/', '/e/');
            }
            
            try {
                const { getFirestore, doc, updateDoc } = await import("firebase/firestore");
                const db = getFirestore();
                const movieRef = doc(db, "movies", SelvaStream.currentPlayerMovie.id);
                await updateDoc(movieRef, { embed: link });
                SelvaStream.currentPlayerMovie.embed = link; // Sync local
                if (window.showToast) window.showToast("👑 Link Maestro fijado con éxito.", "success");
                // Recargar el reproductor con la nueva fuente
                SelvaStream.loadDebridAuto();
            } catch (e) {
                console.error("Error fijando link:", e);
                if (window.showToast) window.showToast("Error al fijar prioridad.", "error");
            }
        });

        document.getElementById('admin-download-btn')?.addEventListener('click', () => {
            const iframe = document.getElementById('player-iframe');
            const nativeVideo = document.getElementById('native-video-player');
            let currentUrl = (iframe && iframe.style.display !== 'none') ? iframe.src : (nativeVideo?.src || '');
            
            if (currentUrl && currentUrl !== 'about:blank') {
                window.open(currentUrl, '_blank');
            } else {
                if (window.showToast) window.showToast("No hay una fuente activa para descargar. 🕵️‍♂️", "warning");
            }
        });

        const copyAppLink = () => {
            const url = window.location.href;
            navigator.clipboard.writeText(url).then(() => {
                if (window.showToast) window.showToast("🚀 Link de SelvaFlix copiado al portapapeles.", "success");
            }).catch(err => {
                console.error('Error al copiar link:', err);
                if (window.showToast) window.showToast("Error al copiar el link 🐒", "error");
            });
        };

        const copyVideoLink = () => {
            const iframe = document.getElementById('player-iframe');
            const nativeVideo = document.getElementById('native-video-player');
            let currentUrl = (iframe && iframe.style.display !== 'none') ? iframe.src : (nativeVideo?.src || '');
            
            if (currentUrl && currentUrl !== 'about:blank') {
                navigator.clipboard.writeText(currentUrl).then(() => {
                    if (window.showToast) window.showToast("📋 Enlace DIRECTO del video copiado.", "success");
                }).catch(err => {
                    console.error('Error al copiar video:', err);
                    if (window.showToast) window.showToast("Error al copiar el video 🐒", "error");
                });
            } else {
                if (window.showToast) window.showToast("No hay una fuente activa para copiar. 🕵️‍♂️", "warning");
            }
        };

        document.getElementById('share-selva-btn')?.addEventListener('click', copyAppLink);
        document.getElementById('admin-copy-video-link-btn')?.addEventListener('click', copyVideoLink);

        document.getElementById('report-broken-btn')?.addEventListener('click', () => {
            if (window.reportBrokenLink && SelvaStream.currentPlayerMovie) {
                window.reportBrokenLink(SelvaStream.currentPlayerMovie.id, SelvaStream.currentPlayerMovie.title);
            }
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
        this.currentPlayerMovie = movie;
        this.init();
        const modal = document.getElementById('player-modal');
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';

        // Check if Admin
        const isAdmin = localStorage.getItem('selva_admin_auth') === 'true';
        const adminPanel = document.getElementById('admin-only-panel');
        const adminAppBtn = document.getElementById('admin-approve-player-btn');
        const adminWaitBtn = document.getElementById('admin-wait-player-btn');
        const manualInput = document.getElementById('admin-manual-link-input');
        
        if (adminPanel) adminPanel.style.display = isAdmin ? 'flex' : 'none';
        if (manualInput) manualInput.value = movie.embed || '';

        if (adminAppBtn) {
            // Solo mostrar Aprobar si está en review o waiting
            adminAppBtn.style.display = (isAdmin && (movie.status === 'review' || movie.status === 'waiting')) ? 'block' : 'none';
        }
        
        if (adminWaitBtn) {
            // Solo mostrar "En Espera" si NO está ya en espera
            adminWaitBtn.style.display = (isAdmin && movie.status !== 'waiting') ? 'block' : 'none';
        }

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

        // ✅ AUTO-SCAN: Solo el Admin invoca los scrapers para "cosechar" links
        const isAdminForScan = localStorage.getItem('selva_admin_auth') === 'true';
        const id = movie.imdbId || movie.tmdbId;
        const type = movie.type === 'series' ? 'series' : 'movie';
        if (id && isAdminForScan) this.loadDebridAuto(id, type);
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
                sSel.innerHTML = details.seasons
                    .filter(s => s.season_number > 0)
                    .map(s => `<option value="${s.season_number}">${s.name || `Temp ${s.season_number}`}</option>`).join('');

                const updateE = (sNum) => {
                    const s = details.seasons.find(x => x.season_number == sNum);
                    const count = s ? s.episode_count : 24;
                    eSel.innerHTML = Array.from({ length: count }, (_, i) => `<option value="${i + 1}">Capítulo ${i + 1}</option>`).join('');
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

    // Rellena el menú lateral VIP sin tocar el resto del DOM
    renderVipMenuList() {
        const vipMenuList = document.getElementById('vip-menu-list');
        const floatingBtn = document.getElementById('floating-sources-btn');
        
        if (this.lastScrapedStreams.length > 0) {
            if (floatingBtn) {
                floatingBtn.innerHTML = `✅ ${this.lastScrapedStreams.length} FUENTES VIP ▾`;
            }
            if (vipMenuList) {
                // 🕵️ FILTRADO DE FUENTES: 
                // Admin ve TODO. Usuario normal solo ve Coronadas (👑) o Públicas (🌐).
                const isAdmin = localStorage.getItem('selva_admin_auth') === 'true';
                const movieRef = this.currentPlayerMovie || {};
                const favHashes = movieRef.suggestedVipHashes || (movieRef.suggestedVipHash ? [movieRef.suggestedVipHash] : []);
                
                const filteredStreams = this.lastScrapedStreams.filter(s => {
                    const isSuggested = favHashes.includes(s.infoHash) || favHashes.includes(s.url);
                    const isPublicLink = movieRef.embed && (movieRef.embed === s.url || movieRef.embed === s.infoHash);
                    
                    if (isAdmin) return true; // Admin ve TODO (Cosecha libre de links)
                    return isSuggested || isPublicLink; // Usuario normal NO ve las públicas (Sin anuncios)
                });

                // 🔥 FUENTE OFICIAL (BASE DE DATOS):
                // Si la peli tiene un embed guardado pero no está en los resultados del scraper, lo inyectamos manualmente.
                // Esto asegura que "Por Verificar" y las pelis exportadas siempre funcionen.
                if (movieRef.embed) {
                    // Limpieza de iframes (basado en feedback del usuario que recibe tags completos)
                    let cleanEmbed = movieRef.embed;
                    if (movieRef.embed.includes('<iframe')) {
                        const srcMatch = movieRef.embed.match(/src="([^"]+)"/);
                        if (srcMatch) cleanEmbed = srcMatch[1];
                    }

                    // Asegurarnos de que el link sea para el reproductor (e) y no para la página web (v)
                    if (cleanEmbed.includes('streamtape.com/v/')) {
                        cleanEmbed = cleanEmbed.replace('/v/', '/e/');
                    }

                    if (!filteredStreams.find(s => s.url === cleanEmbed || s.infoHash === cleanEmbed)) {
                        filteredStreams.unshift({
                            title: "[SERVIDOR OFICIAL] Reproductor Selva",
                            name: "🌐 Source Directo (Cloud)",
                            url: cleanEmbed,
                            infoHash: cleanEmbed,
                            isPublic: true
                        });
                    }

                    // 🕵️ Sincronizar campo de texto del Admin con el link limpio
                    const manualInput = document.getElementById('admin-manual-link-input');
                    if (manualInput && isAdmin) {
                        manualInput.value = cleanEmbed;
                    }
                }

                if (filteredStreams.length === 0 && !isAdmin) {
                    vipMenuList.innerHTML = '<div style="padding:20px; text-align:center; opacity:0.6;">⏳ Procesando señales VIP... Vuelve en un momento.</div>';
                    return;
                }

                vipMenuList.innerHTML = filteredStreams.map((s, index) => {
                    // Re-calcular index real para el onclick si es Admin
                    const realIndex = this.lastScrapedStreams.indexOf(s);
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
                    const isAdmin = localStorage.getItem('selva_admin_auth') === 'true';
                    const movieRef = this.currentPlayerMovie || {};
                    const hashes = movieRef.suggestedVipHashes || (movieRef.suggestedVipHash ? [movieRef.suggestedVipHash] : []);
                    const isSuggested = hashes.includes(s.infoHash) || hashes.includes(s.url);
                    const isPlaying = this.currentPlayingHash && (s.infoHash === this.currentPlayingHash || s.url === this.currentPlayingHash);
                    
                    // 🌐 Badge: ¿Es este el link que ven los usuarios?
                    const isPublicLink = movieRef.embed && (movieRef.embed === s.url || movieRef.embed === s.infoHash);

                    // Escape de comillas para evitar romper el atributo onclick
                    const safeTitle = (s.title || '').replace(/'/g, "").replace(/"/g, ""); // Limpieza total para el confirm
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
                        // Usuario normal: Ve sugeridas y también fuentes públicas/oficiales
                        if (isSuggested) badgeHtml = `<div style="position:absolute; top:-10px; right:-25px; background:#FF6600; color:white; padding:15px 30px; transform:rotate(45deg); font-size:0.55rem; font-weight:900; letter-spacing:1px; z-index:10; pointer-events:none;">👑 PREMIUM</div>`;
                        else badgeHtml = `<div style="position:absolute; top:-10px; right:-25px; background:#00f2ff; color:black; padding:15px 30px; transform:rotate(45deg); font-size:0.55rem; font-weight:900; letter-spacing:1px; z-index:10; pointer-events:none;">🌐 DISPONIBLE</div>`;
                    }

                    return `
                        <div class="stream-card-vip" onclick='if(event.target.closest("button")) return; SelvaStream.toggleVipMenu(); SelvaStream.handleExternalStream(${realIndex === -1 ? JSON.stringify(s).replace(/'/g, "&apos;") : `SelvaStream.lastScrapedStreams[${realIndex}]`})'  
                                style="background: ${isSuggested ? 'rgba(255,102,0,0.1)' : 'rgba(255,102,0,0.05)'}; border: 1px solid ${isSuggested ? '#FF6600' : (isPublicLink ? '#00f2ff' : 'rgba(255,102,0,0.15)')}; border-radius: 12px; padding: 15px; cursor: pointer; transition: all 0.2s ease; border-left: 4px solid ${isSuggested ? '#FF6600' : (isPublicLink ? '#00f2ff' : (isDebrid ? '#FF6600' : '#2ECC71'))}; position: relative; overflow: hidden; text-align:left; margin-bottom:10px;">
                            ${badgeHtml}
                            ${isPlaying ? `<div style="position:absolute; top:12px; right:12px; background:#2ECC71; color:white; padding:4px 8px; border-radius:6px; font-size:0.55rem; font-weight:900; letter-spacing:1px; z-index:5; box-shadow:0 0 10px rgba(46,204,113,0.4);">● REPRODUCIENDO</div>` : ''}
                            ${crownBtn}
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <div style="font-size:0.65rem; font-weight:900; color:${isDebrid ? '#FF6600' : '#2ECC71'}; text-transform:uppercase; letter-spacing:1px; display:flex; align-items:center; gap:5px; margin-bottom:2px;">
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
                                    ${isDebrid ? '<span style="color:#FF6600; font-size:0.55rem; font-weight:900; border:1px solid #FF6600; padding:1px 4px; border-radius:3px;">REAL-DEBRID</span>' : ''}
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
        
        // 🚀 MEJORA: Solo renderizar el HTML si NO existe ya. 
        // Esto evita borrar selectores ya poblados por TMDb.
        const isSeries = ['series', 'tv', 'anime'].includes(this.currentPlayerMovie?.type);
        const hasSelectors = !!document.getElementById('selva-season');

        if (isSeries && !hasSelectors) {
            root.innerHTML = `
                <div class="player-controls" style="margin-top: 20px;">
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
        
        // 🧹 Limpieza de controles
        const root = document.getElementById('player-controls-root');
        if (root) root.innerHTML = '';
    },

    async loadDebridAuto(id, type) {
        // 🧹 LIMPIEZA DE ESTADO: Evitar fuentes de la película anterior
        this.lastScrapedStreams = [];
        this.renderVipMenuList();

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
        let queryId = id || movie?.imdbId || movie?.tmdbId;
        const queryType = type || (['series', 'tv', 'anime'].includes(movie?.type) ? 'series' : 'movie');

        // Si es serie, recolectamos temporada y episodio actual
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
        if (loaderText) loaderText.innerText = '🚀 Escaneando Selva Global...';

        try {
            const providers = "cinecalidad,mejortorrent,wolfmax4k,yts,1337x,torrent9,limetorrents,eztv,rarbg";
            const tConfig = `providers=${providers}|sort=seeders|qualityfilter=scr,cam`;

            const urls = [
                { url: `https://torrentio.strem.fun/${tConfig}/stream/${queryType}/${queryId}.json`, name: "T-IO" },
                { url: `https://comet.strem.fun/stream/${queryType}/${queryId}.json`, name: "COMET" },
                { url: `https://knightcrawler.elfhosted.com/stream/${queryType}/${queryId}.json`, name: "KNIGHT" },
                { url: `https://mediafusion.elfhosted.com/stream/${queryType}/${queryId}.json`, name: "M-FUSION" }
            ];

            // 🌐 FUENTES ABIERTAS (No necesitan Real-Debrid)
            const tmdbId = movie?.tmdbId;
            const imdbId = movie?.imdbId;
            const publicStreams = [];

            if (tmdbId || imdbId) {
                const id = tmdbId || imdbId;
                const isTv = queryType === 'series';
                const s = isTv ? (document.getElementById('selva-season')?.value || 1) : null;
                const e = isTv ? (document.getElementById('selva-episode')?.value || 1) : null;

                const movieTitle = movie ?.title || "Película";
                // Vidsrc.me (Muy estable)
                const vidsrcMe = isTv ? `https://vidsrc.me/embed/tv?tmdb=${tmdbId}&sub_lang=es&s=${s}&e=${e}` : `https://vidsrc.me/embed/movie?tmdb=${tmdbId}&sub_lang=es`;
                publicStreams.push({ title: `[GRATIS] 🌐 ${movieTitle} - Fuente Pública 1`, name: "🌐 GLOBAL", url: vidsrcMe, providerName: "Free-1", isPublic: true });

                // Vidsrc.to (Directo)
                const vidsrcTo = isTv ? `https://vidsrc.to/embed/tv/${tmdbId}/${s}/${e}` : `https://vidsrc.to/embed/movie/${tmdbId}`;
                publicStreams.push({ title: `[GRATIS] 🌐 ${movieTitle} - Fuente Pública 2`, name: "🌐 GLOBAL", url: vidsrcTo, providerName: "Free-2", isPublic: true });

                // SuperEmbed
                const superEmbed = `https://multiembed.mov/?video_id=${id}&tmdb=1${isTv ? `&s=${s}&e=${e}` : ''}`;
                publicStreams.push({ title: `[GRATIS] 🌐 ${movieTitle} - Multi-Servidor 3`, name: "🌐 MULTI", url: superEmbed, providerName: "Free-3", isPublic: true });

                // 2Embed.cc (Respaldo)
                const twoEmbed = isTv ? `https://www.2embed.cc/embedtv/${tmdbId}&s=${s}&e=${e}` : `https://www.2embed.cc/embed/${tmdbId}`;
                publicStreams.push({ title: `[GRATIS] 🌐 ${movieTitle} - Fuente 4 (2Embed)`, name: "🌐 BACKUP", url: twoEmbed, providerName: "Free-4", isPublic: true });
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 9500); // Un pelín más para los nuevos motores

            const responses = await Promise.allSettled(urls.map(u =>
                fetch(u.url, { signal: controller.signal }).then(r => r.json())
            ));
            clearTimeout(timeoutId);

            let allStreams = [];
            responses.forEach((res, i) => {
                if (res.status === 'fulfilled' && res.value && res.value.streams) {
                    res.value.streams.forEach(s => s.providerName = urls[i].name);
                    allStreams = allStreams.concat(res.value.streams);
                }
            });

            // Añadir las fuentes públicas al inicio o final
            allStreams = [...publicStreams, ...allStreams];

            // --- 🕵️‍♂️ PRE-PROCESAMIENTO Y SCORING INTELIGENTE ---
            let streams = [];
            allStreams.forEach(s => {
                const qRaw = ((s.title || '') + ' ' + (s.name || '')).toLowerCase();
                const url = (s.url || '').toLowerCase();

                // 0. Filtro Básico "No admitidos"
                if (qRaw.includes('dublado') || qRaw.includes('legendado') || qRaw.includes('português') || qRaw.includes('pt-br') || qRaw.includes('hindi') || qRaw.includes('tamil')) return;
                
                const isDirect = url.includes('.m3u8') || url.includes('.mp4') || url.includes('.mkv') || url.includes('.webm') || qRaw.includes('[rd+]');
                if (!s.infoHash && !isDirect && !s.isPublic) return; // Filtro de seguridad VIP (Aceptamos Públicas)

                // 1. Detección Profunda de Formato
                let extMatch = qRaw.match(/\.(mkv|mp4|m3u8|avi|ts|webm)/i);
                if (!extMatch) extMatch = url.match(/\.(mkv|mp4|m3u8|avi|ts|webm)/i);
                s.detectedFormat = extMatch ? extMatch[1].toUpperCase() : 'VIDEO';

                // 2. Cálculo de Peso
                const weightMatch = qRaw.match(/(\d+(\.\d+)?)\s*(gb|mb)/i);
                s.weightGB = 0;
                if (weightMatch) {
                    let val = parseFloat(weightMatch[1]);
                    if (weightMatch[3].toLowerCase() === 'mb') val = val / 1024;
                    s.weightGB = val;
                }

                // 3. Detección de Idioma y Codecs
                const kwLat = ['latino', 'spanish', 'esp', 'español', 'castellano', 'cinecalidad', 'mx', 'pe', 'cl', 'ar', 'spa', 'dual', 'vose', 'cast', 'lat'];
                const isLat = kwLat.some(k => qRaw.includes(k));
                const isMulti = qRaw.includes('multi') || qRaw.includes('dual');
                const kwEurope = ['french', 'truefrench', 'ita', 'italian', 'ger', 'german', 'rus'];
                const isNuisance = kwEurope.some(k => qRaw.includes(k));
                const isEng = qRaw.includes('english') || qRaw.includes('en-us') || qRaw.includes('en-uk');

                if (qRaw.includes('264') || qRaw.includes('avc')) s.detectedVideoCodec = 'H264';
                else if (qRaw.includes('265') || qRaw.includes('hevc')) s.detectedVideoCodec = 'HEVC';
                
                if (qRaw.includes('aac') || qRaw.includes('mp3')) s.detectedAudioCodec = 'AAC';
                else if (qRaw.includes('ac3') || qRaw.includes('dts') || qRaw.includes('dd5')) s.detectedAudioCodec = 'AC3';

                // 4. Sistema de Puntaje (Score) - ALGORITMO SELVAVIP 3.0 (Español-Fiel)
                let score = 0;
                
                // --- PRIORIDAD 1: META-MATCH (Búsqueda por Títulos/Director) ---
                const movieTitles = [
                    this.currentPlayerMovie.title,
                    this.currentPlayerMovie.original_title,
                    this.currentPlayerMovie.director,
                    ...(this.currentPlayerMovie.alternative_titles || [])
                ].filter(Boolean).map(t => window.normalizeText(t));

                const normStreamTitle = window.normalizeText(s.title + ' ' + (s.name || ''));
                const hasTitleMatch = movieTitles.some(t => normStreamTitle.includes(t));
                if (hasTitleMatch) score += 2000;

                // --- PRIORIDAD 2: IDIOMA ---
                if (isLat) {
                    score += 5000; // El español siempre arriba
                } else if (isNuisance) {
                    score -= 3000; // Purga de idiomas no deseados
                } else if (isMulti) {
                    score += 800;  // Multi es buen respaldo
                } else if (isEng && !isMulti) {
                    score -= 500;  // Inglés puro al fondo
                }

                // --- PRIORIDAD 3: COMPATIBILIDAD iOS ---
                const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
                
                if (s.detectedFormat === 'MP4' || s.detectedFormat === 'M3U8') {
                    score += 1500; // MP4 es el rey de la compatibilidad
                } else if (s.detectedFormat === 'MKV' && isIOS) {
                    score -= 1000; // MKV en iOS = Problemas
                } else if (s.detectedFormat === 'VIDEO') {
                    score += 300;  // Fallback decente
                }

                if (isIOS && s.detectedAudioCodec === 'AC3') {
                    score -= 1000; // AC3 en iOS = Mudo (Bajar prioridad)
                }

                // --- PRIORIDAD 4: PESO Y CALIDAD ---
                if (s.weightGB > 0) {
                    if (s.weightGB < 3.0) score += 500;      // Ligero/Rápido
                    else if (s.weightGB <= 8.0) score += 200; // Alta calidad
                    else if (s.weightGB > 20.0) score -= 800; // Demasiado pesado
                }

                if (qRaw.includes('1080')) score += 200;
                else if (qRaw.includes('720')) score += 100;

                // 5. El Dedo de Dios (Prioridad Manual desde Firebase)
                const movieRef = this.currentPlayerMovie || {};
                const favHashes = movieRef.suggestedVipHashes || (movieRef.suggestedVipHash ? [movieRef.suggestedVipHash] : []);
                if (favHashes.includes(s.infoHash) || favHashes.includes(s.url)) {
                    score += 20000; 
                }

                if (s.isPublic) score += 1000000; // Prioridad Máxima SelvaFlix (Gratis)
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
            if (msgEl) msgEl.textContent = `✅ ${streams.length} fuentes encontradas. Elige una opción:`;

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
        console.log("💎 Cargando fuente externa:", stream);
        this.currentPlayingHash = stream.infoHash || stream.url;

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
