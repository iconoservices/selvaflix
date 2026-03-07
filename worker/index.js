/**
 * 🥥 ICONOSERVICES MASTER-WORKER v1.2 - "Soberanía Turbo"
 * El Cerebro Unificado para SelvaFlix y SelvaBeat.
 * Mejoras: Búsqueda robusta, Redundancia de Piped y Soporte de Imágenes.
 */

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, x-selva-auth',
            'Content-Type': 'application/json'
        };

        if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

        // --- 1. SEGURIDAD ---
        // Permitimos acceso vía Header (Apps) o vía URL (Imágenes/Links directos)
        const authToken = request.headers.get('x-selva-auth') || url.searchParams.get('key');
        if (authToken !== env.AUTH_TOKEN) {
            return new Response(JSON.stringify({ error: 'Acceso Denegado a la Selva' }), {
                status: 403,
                headers: corsHeaders
            });
        }

        try {
            // --- 🎥 RUTA: SELVAFLIX (Video VIP) ---
            if (url.pathname === '/flix/unrestrict') {
                const magnet = url.searchParams.get('magnet');
                if (!magnet) throw new Error('Falta magnet link');

                const addResp = await fetch('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` },
                    body: new URLSearchParams({ magnet })
                });
                const addData = await addResp.json();

                await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${addData.id}`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` },
                    body: new URLSearchParams({ files: 'all' })
                });

                const infoResp = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${addData.id}`, {
                    headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` }
                });
                const infoData = await infoResp.json();

                if (!infoData.links || infoData.links.length === 0) {
                    return new Response(JSON.stringify({ error: 'Procesando en Real-Debrid... Reintenta' }), { headers: corsHeaders });
                }

                const finalResp = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` },
                    body: new URLSearchParams({ link: infoData.links[0] })
                });
                const finalData = await finalResp.json();

                return new Response(JSON.stringify({
                    url: finalData.download,
                    title: finalData.filename,
                    type: 'direct'
                }), { headers: corsHeaders });
            }

            // --- 🎵 RUTAS: SELVABEAT (Música) ---

            // A. Stream de Audio (Modo Turbo Cobalt)
            if (url.pathname === '/beat/stream') {
                const videoId = url.searchParams.get('v');
                const cobaltResp = await fetch('https://api.cobalt.tools/api/json', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({
                        url: `https://www.youtube.com/watch?v=${videoId}`,
                        downloadMode: 'audio',
                        audioFormat: 'mp3'
                    })
                });
                const data = await cobaltResp.json();
                return new Response(JSON.stringify(data), { headers: corsHeaders });
            }

            // --- FLOTA DE SERVIDORES PIPED (Alta Disponibilidad) ---
            const PIPED_INSTANCES = [
                'https://pipedapi.official.center',
                'https://pipedapi.kavin.rocks',
                'https://pipedapi.lunar.icu'
            ];

            const fetchFromFlotilla = async (path) => {
                for (let instance of PIPED_INSTANCES) {
                    try {
                        // Creamos un AbortController para poner un límite de tiempo a cada servidor
                        const controller = new AbortController();
                        const id = setTimeout(() => controller.abort(), 3500); // 3.5 segundos máximo por servidor

                        const res = await fetch(`${instance}${path}`, { signal: controller.signal });
                        clearTimeout(id);

                        if (res.ok) {
                            const data = await res.json();
                            return data.items || data || [];
                        }
                    } catch (e) {
                        console.log(`[Radar] Instancia caída: ${instance}`); // Sigue buscando el siguiente
                    }
                }
                return []; // Si toda la flota cae, devuelve vacío en lugar de explotar
            };

            // B. Búsqueda (Motor de Alta Disponibilidad)
            if (url.pathname === '/beat/search') {
                const q = url.searchParams.get('q');
                const path = `/search?q=${encodeURIComponent(q)}&filter=music_videos`;
                const items = await fetchFromFlotilla(path);
                return new Response(JSON.stringify(items), { headers: corsHeaders });
            }

            // C. Tendencias Musicales
            if (url.pathname === '/beat/trending') {
                const region = url.searchParams.get('region') || 'MX';
                const path = `/trending?region=${region}`;
                const items = await fetchFromFlotilla(path);
                return new Response(JSON.stringify(items), { headers: corsHeaders });
            }

            // D. Proxy de Imágenes (Para que SelvaBeat no tenga errores 404/403)
            if (url.pathname === '/img') {
                const videoId = url.searchParams.get('v');
                // Redirigimos a la miniatura de alta calidad de YouTube
                const imgUrl = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
                return fetch(imgUrl);
            }

            return new Response(JSON.stringify({ status: 'IconoServices Master Online', v: '1.2' }), { headers: corsHeaders });

        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: corsHeaders
            });
        }
    }
};
