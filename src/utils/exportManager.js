/**
 * 🚀 SelvaFlix Export Manager
 * Maneja la lógica de exportación a Streamtape y VOE.sx con persistencia y polling inteligente.
 */

export const ExportManager = {
    PHASE_UPLOADING: 'uploading',
    PHASE_CONVERTING: 'converting',
    PHASE_DONE: 'done',
    PHASE_FAILED: 'failed',

    async extractLinks({ provider, imdbId, tmdbId, type = 'movie', workerUrl, authToken }) {
        const params = new URLSearchParams({ provider });
        if (imdbId) params.set('imdb', imdbId);
        if (tmdbId) params.set('tmdb', tmdbId);
        if (type)   params.set('type', type);
        const res = await fetch(`${workerUrl}/flix/extract-links?${params}`, {
            headers: { 'x-selva-auth': authToken }
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Error extrayendo links');
        return data.links || [];
    },

    pickBestLink(links) {
        if (!links || links.length === 0) return null;
        const PRIORITY = ['voe', 'streamwish', 'vidhide', 'filemoon', 'doodstream', 'rapidvideo', 'goodstream', 'vimeos', 'hlswish'];
        const sorted = [...links].sort((a, b) => {
            const pa = PRIORITY.indexOf(a.servername);
            const pb = PRIORITY.indexOf(b.servername);
            return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
        });
        return sorted[0];
    },

    async startVoeUpload({ movieId, sourceUrl, voeKey, onUpdate }) {
        if (!voeKey) throw new Error('Falta la VOE API Key (VITE_VOE_API_KEY)');
        if (!sourceUrl) throw new Error('No hay URL de origen para subir a VOE');
        console.log(`[ExportManager] Iniciando Remote Upload VOE para Movie:${movieId} | URL: ${sourceUrl}`);
        const uploadRes = await fetch(`https://voe.sx/api/upload/url?key=${encodeURIComponent(voeKey)}&url=${encodeURIComponent(sourceUrl)}`);
        const uploadData = await uploadRes.json();
        if (uploadData.status !== 200) {
            throw new Error(`VOE rechazó el upload: ${uploadData.message || JSON.stringify(uploadData)}`);
        }
        if (onUpdate) onUpdate({ phase: this.PHASE_UPLOADING, message: '⬆️ Remote Upload enviado a VOE.sx. Esperando procesamiento...' });
        return this.startVoePolling({ movieId, voeKey, sourceUrl, onUpdate });
    },

    startVoePolling({ movieId, voeKey, sourceUrl, onUpdate }) {
        const maxAttempts = 60;
        let attempts = 0;
        console.log(`[ExportManager VOE] Iniciando polling para Movie:${movieId}`);
        const interval = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(interval);
                if (onUpdate) onUpdate({ phase: this.PHASE_FAILED, message: '❌ VOE: Tiempo máximo de espera agotado.' });
                return;
            }
            try {
                const listRes = await fetch(`https://voe.sx/api/upload/url/list?key=${encodeURIComponent(voeKey)}`);
                const listData = await listRes.json();
                if (listData.status !== 200 || !listData.result) return;
                const entries = Array.isArray(listData.result) ? listData.result : Object.values(listData.result);
                const entry = entries.find(e => e.source_url === sourceUrl || e.url === sourceUrl)
                    || entries.find(e => e.status === 1 || e.status === 2)
                    || entries[0];
                if (!entry) return;
                if (entry.status === 3) {
                    clearInterval(interval);
                    const fileCode = entry.file_code || entry.filecode;
                    const embedUrl = fileCode ? `https://voe.sx/e/${fileCode}` : null;
                    if (onUpdate) onUpdate({ phase: this.PHASE_DONE, url: embedUrl, fileCode, message: '🔥 ¡Subida a VOE completada! Enlace propio guardado.' });
                } else if (entry.status === 4) {
                    clearInterval(interval);
                    if (onUpdate) onUpdate({ phase: this.PHASE_FAILED, message: '❌ VOE: El Remote Upload falló.' });
                } else {
                    const statusLabel = entry.status === 1 ? 'en cola' : 'descargando';
                    if (onUpdate) onUpdate({ phase: this.PHASE_UPLOADING, message: `⏳ VOE ${statusLabel}... (${attempts * 30}s)` });
                }
            } catch (err) {
                console.error('[ExportManager VOE] Error en polling:', err);
            }
        }, 30000);
    },

    async startPolling({ movieId, ticketId, fileId, phase, stLogin, stKey, onUpdate }) {
        let currentPhase = phase || this.PHASE_UPLOADING;
        let currentFileId = fileId || null;
        let attempts = 0;
        const maxAttempts = 40;
        console.log(`[ExportManager] Iniciando vigilancia para Movie:${movieId} en fase ${currentPhase}`);
        const interval = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(interval);
                return;
            }
            try {
                if (currentPhase === this.PHASE_UPLOADING) {
                    const statusUrl = `https://api.streamtape.com/remotedl/status?login=${stLogin}&key=${stKey}&id=${ticketId}`;
                    const res = await fetch(statusUrl);
                    const data = await res.json();
                    if (data.status === 200 && data.result && data.result[ticketId]) {
                        const info = data.result[ticketId];
                        if (info.status === 'finished' && info.url) {
                            const match = info.url.match(/streamtape\.com\/[ev]\/([a-zA-Z0-9]+)/);
                            if (match && match[1]) {
                                currentFileId = match[1];
                                currentPhase = this.PHASE_CONVERTING;
                                const cleanUrl = `https://streamtape.com/e/${currentFileId}/`;
                                if (onUpdate) onUpdate({ phase: currentPhase, url: cleanUrl, fileId: currentFileId, message: "📤 Descarga completada. Iniciando conversión (Paso 2/2)..." });
                            } else {
                                currentPhase = this.PHASE_DONE;
                            }
                        } else if (info.status === 'failed') {
                            currentPhase = this.PHASE_FAILED;
                            if (onUpdate) onUpdate({ phase: currentPhase, message: "❌ La subida a Streamtape falló." });
                            clearInterval(interval);
                        }
                    }
                }
                if (currentPhase === this.PHASE_CONVERTING && currentFileId) {
                    const infoUrl = `https://api.streamtape.com/file/info?login=${stLogin}&key=${stKey}&file=${currentFileId}`;
                    const res = await fetch(infoUrl);
                    const data = await res.json();
                    if (data.status === 200 && data.result && data.result[currentFileId]) {
                        if (data.result[currentFileId].converted !== false) currentPhase = this.PHASE_DONE;
                    } else {
                        currentPhase = this.PHASE_DONE;
                    }
                }
                if (currentPhase === this.PHASE_DONE) {
                    if (onUpdate) onUpdate({ phase: currentPhase, message: "🔥 ¡MAGIA! La película está 100% lista." });
                    clearInterval(interval);
                }
            } catch (err) {
                console.error("[ExportManager] Error en polling:", err);
            }
        }, 45000);
    }
};
