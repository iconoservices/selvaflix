/**
 * 🚀 SelvaFlix Export Manager
 * Maneja la lógica de exportación a Streamtape con persistencia y polling inteligente.
 */

export const ExportManager = {
    // Phase tracking
    PHASE_UPLOADING: 'uploading',
    PHASE_CONVERTING: 'converting',
    PHASE_DONE: 'done',
    PHASE_FAILED: 'failed',

    /**
     * Inicia o reanuda un polling de exportación
     * @param {Object} options 
     */
    async startPolling({ movieId, ticketId, fileId, phase, stLogin, stKey, onUpdate }) {
        let currentPhase = phase || this.PHASE_UPLOADING;
        let currentFileId = fileId || null;
        let attempts = 0;
        const maxAttempts = 40; // ~30 mins total

        console.log(`[ExportManager] Iniciando vigilancia para Movie:${movieId} en fase ${currentPhase}`);

        const interval = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                console.warn(`[ExportManager] Tiempo máximo de espera agotado para ${movieId}`);
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
                            // Asegurarnos de guardar el link limpio (formato /v/ o /e/)
                            // Si por casualidad la API devuelve algo raro, lo normalizamos
                            let cleanUrl = info.url;
                            const match = info.url.match(/streamtape\.com\/[ev]\/([a-zA-Z0-9]+)/);
                            if (match && match[1]) {
                                currentFileId = match[1];
                                currentPhase = this.PHASE_CONVERTING;
                                cleanUrl = `https://streamtape.com/e/${currentFileId}/`; // Usar /e/ para link de inserción (embed)
                                
                                // Notificar fase 2
                                if (onUpdate) onUpdate({ 
                                    phase: currentPhase, 
                                    url: cleanUrl, 
                                    fileId: currentFileId,
                                    message: "📤 Descarga completada. Iniciando conversión (Paso 2/2)..." 
                                });
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
                        const fInfo = data.result[currentFileId];
                        if (fInfo.converted !== false) {
                            currentPhase = this.PHASE_DONE;
                        }
                    } else {
                        // Si falla la info, asumimos listo para no bloquear eternamente
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
        }, 45000); // 45 segundos entre chequeos
    }
};
