/**
 * 🚀 SelvaMov Export Manager
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
        const PRIORITY = ['earnvids', 'voe', 'streamwish', 'vidhide', 'filemoon', 'doodstream', 'rapidvideo', 'goodstream', 'vimeos', 'hlswish'];
        const sorted = [...links].sort((a, b) => {
            const pa = PRIORITY.indexOf(a.servername);
            const pb = PRIORITY.indexOf(b.servername);
            return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
        });
        return sorted[0];
    },

    // ─── 💰 EARNVIDS INTEGRATION ──────────────────────────────────────────────
    async startEarnvidsUpload({ movieId, sourceUrl, earnvidsKey, onUpdate }) {
        if (!earnvidsKey) throw new Error('Falta la EarnVids API Key (VITE_EARNVIDS_KEY)');
        if (!sourceUrl) throw new Error('No hay URL de origen para subir a EarnVids');
        console.log(`[ExportManager] Iniciando Upload EarnVids para Movie:${movieId} | URL: ${sourceUrl}`);

        // ⚡ Clonación instantánea si el video ya proviene de EarnVids
        const earnMatch = sourceUrl.match(/earnvids\.com\/(?:e\/|embed\/|d\/)?([a-zA-Z0-9]+)/i);
        if (earnMatch && earnMatch[1]) {
            const existingCode = earnMatch[1];
            try {
                if (onUpdate) onUpdate({ phase: this.PHASE_UPLOADING, message: '⚡ Clonando archivo en EarnVids al instante...' });
                const cloneRes = await fetch(`https://earnvidsapi.com/api/file/clone?key=${encodeURIComponent(earnvidsKey)}&file_code=${encodeURIComponent(existingCode)}`);
                const cloneData = await cloneRes.json();
                if (cloneData.status === 200 && cloneData.result?.filecode) {
                    const newCode = cloneData.result.filecode;
                    const embedUrl = `https://earnvids.com/e/${newCode}`;
                    if (onUpdate) onUpdate({ phase: this.PHASE_DONE, url: embedUrl, fileCode: newCode, message: '💰 ¡Clonación instantánea en EarnVids completada!' });
                    return { success: true, url: embedUrl, fileCode: newCode };
                }
            } catch (cloneErr) {
                console.warn('[ExportManager] Falló clon instantáneo de EarnVids, procediendo con upload normal:', cloneErr);
            }
        }

        // Subida remota por URL
        const uploadRes = await fetch(`https://earnvidsapi.com/api/upload/url?key=${encodeURIComponent(earnvidsKey)}&url=${encodeURIComponent(sourceUrl)}`);
        const uploadData = await uploadRes.json();
        if (uploadData.status !== 200 || !uploadData.result?.filecode) {
            throw new Error(`EarnVids rechazó el upload: ${uploadData.msg || uploadData.message || JSON.stringify(uploadData)}`);
        }

        const fileCode = uploadData.result.filecode;
        const initialEmbed = `https://earnvids.com/e/${fileCode}`;
        if (onUpdate) onUpdate({ phase: this.PHASE_UPLOADING, url: initialEmbed, fileCode, message: '⬆️ Remote Upload encolado en EarnVids. Esperando encoding...' });
        return this.startEarnvidsPolling({ movieId, earnvidsKey, fileCode, onUpdate });
    },

    startEarnvidsPolling({ movieId, earnvidsKey, fileCode, onUpdate }) {
        const maxAttempts = 60;
        let attempts = 0;
        console.log(`[ExportManager EarnVids] Polling iniciado para Movie:${movieId} (Code: ${fileCode})`);
        const interval = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(interval);
                if (onUpdate) onUpdate({ phase: this.PHASE_FAILED, message: '❌ EarnVids: Tiempo máximo de espera agotado.' });
                return;
            }
            try {
                // 1. Revisar si ya está listo y reproducible
                const infoRes = await fetch(`https://earnvidsapi.com/api/file/info?key=${encodeURIComponent(earnvidsKey)}&file_code=${encodeURIComponent(fileCode)}`);
                const infoData = await infoRes.json();
                const fileInfo = Array.isArray(infoData.result) ? infoData.result[0] : infoData.result;

                if (fileInfo && (fileInfo.canplay === 1 || fileInfo.canplay === '1')) {
                    clearInterval(interval);
                    const embedUrl = `https://earnvids.com/e/${fileCode}`;
                    if (onUpdate) onUpdate({
                        phase: this.PHASE_DONE,
                        url: embedUrl,
                        fileCode,
                        message: '💰 ¡Video listo en EarnVids! Enlace propio guardado.'
                    });
                    return;
                }

                // 2. Si aún no está listo, consultar la cola de descarga remota
                const queueRes = await fetch(`https://earnvidsapi.com/api/file/url_uploads?key=${encodeURIComponent(earnvidsKey)}`);
                const queueData = await queueRes.json();
                const queueItems = Array.isArray(queueData.result) ? queueData.result : [];
                const currentJob = queueItems.find(j => j.file_code === fileCode);

                if (currentJob) {
                    if (currentJob.status === 'ERROR') {
                        clearInterval(interval);
                        if (onUpdate) onUpdate({ phase: this.PHASE_FAILED, message: '❌ EarnVids: El enlace de origen falló al descargarse.' });
                        return;
                    }
                    const prog = currentJob.progress ? ` (${currentJob.progress}%)` : ` (${attempts * 20}s)`;
                    if (onUpdate) onUpdate({
                        phase: this.PHASE_CONVERTING,
                        message: `⏳ EarnVids ${currentJob.status || 'procesando'}${prog}...`
                    });
                } else {
                    if (onUpdate) onUpdate({
                        phase: this.PHASE_CONVERTING,
                        message: `⏳ EarnVids procesando video... (${attempts * 20}s)`
                    });
                }
            } catch (err) {
                console.error('[ExportManager EarnVids] Error en polling:', err);
            }
        }, 20000);
    },

    // ─── 🔥 VOE.SX INTEGRATION ───────────────────────────────────────────────
    async startVoeUpload({ movieId, sourceUrl, voeKey, onUpdate }) {
        if (!voeKey) throw new Error('Falta la VOE API Key (VITE_VOE_API_KEY)');
        if (!sourceUrl) throw new Error('No hay URL de origen para subir a VOE');
        console.log(`[ExportManager] Iniciando Upload VOE para Movie:${movieId} | URL: ${sourceUrl}`);

        // ⚡ Si el enlace ya es de VOE, clonar al instante (0.5s) sin descargar ni re-codificar
        const voeMatch = sourceUrl.match(/voe\.sx\/(?:e\/)?([a-zA-Z0-9]+)/i);
        if (voeMatch && voeMatch[1]) {
            const existingCode = voeMatch[1];
            try {
                if (onUpdate) onUpdate({ phase: this.PHASE_UPLOADING, message: '⚡ Clonando archivo en tu cuenta de VOE al instante...' });
                const cloneRes = await fetch(`https://voe.sx/api/file/clone?key=${encodeURIComponent(voeKey)}&file_code=${encodeURIComponent(existingCode)}`);
                const cloneData = await cloneRes.json();
                if (cloneData.status === 200 && cloneData.result?.filecode) {
                    const newCode = cloneData.result.filecode;
                    const embedUrl = `https://voe.sx/e/${newCode}`;
                    if (onUpdate) onUpdate({ phase: this.PHASE_DONE, url: embedUrl, fileCode: newCode, message: '🔥 ¡Clonación instantánea en VOE completada!' });
                    return { success: true, url: embedUrl, fileCode: newCode };
                }
            } catch (cloneErr) {
                console.warn('[ExportManager] Falló clon instantáneo VOE, intentando upload por URL:', cloneErr);
            }
        }

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
                if (listData.status !== 200) return;
                const entries = listData.list?.data || (Array.isArray(listData.result) ? listData.result : (listData.result ? Object.values(listData.result) : []));
                if (!entries || entries.length === 0) return;

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
                    if (onUpdate) onUpdate({ phase: this.PHASE_FAILED, message: `❌ VOE: El Remote Upload falló (${entry.status_note || 'error'}).` });
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
