/**
 * 🥥 ICONOSERVICES MASTER-WORKER v1.6 - "Edición Búnker & Contrabando"
 * Soluciona el error de descarga activando un puente binario.
 */

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, x-selva-auth, Range',
            'Access-Control-Expose-Headers': 'Content-Length, Content-Range'
        };

        if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

        const authToken = request.headers.get('x-selva-auth') || url.searchParams.get('key');
        if (authToken !== env.AUTH_TOKEN) {
            return new Response(JSON.stringify({ error: 'Acceso Denegado' }), { status: 403, headers: corsHeaders });
        }

        try {
            // --- 🎥 RUTA: SELVAFLIX (Debrid Logic) ---
            if (url.pathname === '/flix/unrestrict') {
                const addResp = await fetch('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', { method: 'POST', headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` }, body: new URLSearchParams({ magnet: url.searchParams.get('magnet') }) });
                const addData = await addResp.json();
                await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${addData.id}`, { method: 'POST', headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` }, body: new URLSearchParams({ files: 'all' }) });
                const infoResp = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${addData.id}`, { headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` } });
                const infoData = await infoResp.json();
                if (!infoData.links || infoData.links.length === 0) return new Response(JSON.stringify({ error: 'Procesando...' }), { headers: corsHeaders });
                const finalResp = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', { method: 'POST', headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` }, body: new URLSearchParams({ link: infoData.links[0] }) });
                const finalData = await finalResp.json();
                return new Response(JSON.stringify({ url: finalData.download, title: finalData.filename, type: 'direct' }), { headers: corsHeaders });
            }

            // --- 🛡️ RUTA: BÚNKER (Túnel de Descarga) ---
            // Esta ruta permite que el navegador descargue el binario sin errores de CORS.
            if (url.pathname === '/beat/bunker') {
                const targetUrl = url.searchParams.get('url');
                if (!targetUrl) return new Response("URL Requerida", { status: 400 });

                const fileRes = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
                const { readable, writable } = new TransformStream();
                fileRes.body.pipeTo(writable);

                return new Response(readable, {
                    headers: {
                        ...corsHeaders,
                        'Content-Type': fileRes.headers.get('Content-Type') || 'audio/mpeg',
                        'Content-Disposition': `attachment; filename="selvabeat_track.mp3"`,
                        'Cache-Control': 'public, max-age=31536000'
                    }
                });
            }

            // --- 🎵 YOUTUBE SCRAPER (Titanium v1.5) ---
            const fetchYouTubeDirect = async (query, isTrending = false) => {
                const targetUrl = isTrending
                    ? `https://www.youtube.com/feed/trending?gl=PE&bp=4gINGgt5dG1hX2NoYXJ0cw%3D%3D`
                    : `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`;

                const res = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "es-PE,es" } });
                const html = await res.text();
                const match = html.match(/var ytInitialData = ({.*?});<\/script>/);
                if (!match) return [];
                const data = JSON.parse(match[1]);
                let contents;

                if (isTrending) {
                    const sections = data.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents;
                    contents = [];
                    sections.forEach(s => {
                        const items = s.itemSectionRenderer?.contents[0]?.shelfRenderer?.content?.expandedShelfContentsRenderer?.items;
                        if (items) items.forEach(i => { if (i.videoRenderer) contents.push(i.videoRenderer); });
                    });
                } else {
                    contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.filter(c => c.videoRenderer).map(c => c.videoRenderer);
                }

                return contents.map(v => ({
                    id: v.videoId,
                    videoId: v.videoId,
                    title: v.title?.runs?.[0]?.text || "Sin Título",
                    uploaderName: v.ownerText?.runs?.[0]?.text || "Desconocido",
                    duration: 0,
                    thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`
                }));
            };

            if (url.pathname === '/beat/stream') {
                const videoId = url.searchParams.get('v');
                if (env.RD_API_KEY) {
                    try {
                        const rdRes = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', { method: 'POST', headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` }, body: new URLSearchParams({ link: `https://www.youtube.com/watch?v=${videoId}` }) });
                        const rdData = await rdRes.json();
                        if (rdData.download) return new Response(JSON.stringify({ url: rdData.download, method: 'Debrid Premium' }), { headers: corsHeaders });
                    } catch (e) { }
                }
                const cobaltResp = await fetch('https://api.cobalt.tools/api/json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}`, downloadMode: 'audio', audioFormat: 'mp3' }) });
                return new Response(JSON.stringify(await cobaltResp.json()), { headers: corsHeaders });
            }

            if (url.pathname === '/beat/search') return new Response(JSON.stringify(await fetchYouTubeDirect(url.searchParams.get('q'))), { headers: corsHeaders });
            if (url.pathname === '/beat/trending') return new Response(JSON.stringify(await fetchYouTubeDirect(null, true)), { headers: corsHeaders });
            if (url.pathname === '/img') return fetch(`https://i.ytimg.com/vi/${url.searchParams.get('v')}/mqdefault.jpg`, { headers: { "User-Agent": "Mozilla/5.0" } });

            return new Response(JSON.stringify({ status: 'IconoSVC Bunker Ready', v: '1.6' }), { headers: corsHeaders });

        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
        }
    }
};
