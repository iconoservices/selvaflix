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
            // --- 🎥 RUTA: SELVAFLIX (Intelligent Debrid Logic) ---
            // ⚠️ EN DESUSO (2026-07): Real-Debrid ya no se usa (ni contratado). La app
            // ya no llama /flix/unrestrict. Se conserva por si se reactiva RD. No borrar.
            if (url.pathname === '/flix/unrestrict') {
                const magnet = url.searchParams.get('magnet');
                // 1. Añadir Magnet
                const addResp = await fetch('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', { method: 'POST', headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` }, body: new URLSearchParams({ magnet }) });
                const addData = await addResp.json();

                // 2. Obtener info para seleccionar el archivo correcto
                const infoResp = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${addData.id}`, { headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` } });
                const infoData = await infoResp.json();

                // 3. Filtro Anti-MKV: Prioridad absoluta a MP4, luego al más pesado
                const videoFiles = infoData.files.filter(f => f.path.match(/\.(mp4|mkv|avi|mov)$/i));
                const mainFile = videoFiles.sort((a, b) => {
                    const isAMp4 = a.path.toLowerCase().endsWith('.mp4');
                    const isBMp4 = b.path.toLowerCase().endsWith('.mp4');
                    if (isAMp4 && !isBMp4) return -1;
                    if (!isAMp4 && isBMp4) return 1;
                    return b.bytes - a.bytes;
                })[0];

                if (!mainFile) return new Response(JSON.stringify({ error: 'No se encontró video' }), { headers: corsHeaders });

                await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${addData.id}`, { method: 'POST', headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` }, body: new URLSearchParams({ files: mainFile.id }) });

                // 4. Esperar y obtener el link final de descarga
                const updatedInfo = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${addData.id}`, { headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` } }).then(r => r.json());

                if (!updatedInfo.links || updatedInfo.links.length === 0) return new Response(JSON.stringify({ status: 'waiting', msg: 'Descargando en servidor...' }), { headers: corsHeaders });

                const finalResp = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', { method: 'POST', headers: { 'Authorization': `Bearer ${env.RD_API_KEY}` }, body: new URLSearchParams({ link: updatedInfo.links[0] }) });
                const finalData = await finalResp.json();

                return new Response(JSON.stringify({
                    url: finalData.download,
                    title: finalData.filename,
                    size: (mainFile.bytes / (1024 ** 3)).toFixed(2) + ' GB',
                    type: 'direct'
                }), { headers: corsHeaders });
            }

            // --- 🎬 RUTA: DIPELIS (Extractor de link directo) ---
            // DiPelis no es un embed listo para reproducir: su página completa
            // (menú "Opción 1/2/3", header, etc.) es lo que se ve si se pega
            // esa URL directo en un iframe, y en celular ni siquiera carga el
            // video sin un toque manual adentro. Pero el link real del video
            // ya está en texto plano en un <script> de esa misma página, sin
            // cifrado ni proof-of-work (a diferencia de FlixLatam) — solo hay
            // que pedir el HTML server-side (el navegador no puede por CORS)
            // y sacarlo con una regex.
            if (url.pathname === '/flix/dipelis') {
                const slug = url.searchParams.get('slug');
                if (!slug) return new Response(JSON.stringify({ error: 'Falta el parametro slug' }), { status: 400, headers: corsHeaders });

                const pageRes = await fetch(`https://ww2.dipelis.com/pelicula/${slug}/`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                        'Accept-Language': 'es-ES,es;q=0.9'
                    }
                });

                if (!pageRes.ok) return new Response(JSON.stringify({ error: 'DiPelis no respondio', status: pageRes.status }), { status: 502, headers: corsHeaders });

                const html = await pageRes.text();
                const match = html.match(/const\s+videosPorIdioma\s*=\s*(\{.*?\});/s);
                if (!match) return new Response(JSON.stringify({ error: 'No se encontro el titulo en DiPelis' }), { status: 404, headers: corsHeaders });

                let videos;
                try {
                    videos = JSON.parse(match[1]);
                } catch (e) {
                    return new Response(JSON.stringify({ error: 'DiPelis cambio su formato' }), { status: 500, headers: corsHeaders });
                }

                // Latino primero, y si no hay, lo que haya (española o subtitulada)
                const link = videos.lat?.[0] || videos.esp?.[0] || videos.sub?.[0];
                if (!link) return new Response(JSON.stringify({ error: 'DiPelis no tiene servidores para este titulo' }), { status: 404, headers: corsHeaders });

                return new Response(JSON.stringify({ url: link }), { headers: corsHeaders });
            }

            // --- 🔎 RUTA: CHECK (¿esta fuente tiene este titulo?) ---
            // FlixLatam, PelisPlus y RepelisHD no mandan CORS, asi que el
            // navegador no puede chequearlos directo (Vimeus si tiene CORS,
            // ese chequeo va del lado del cliente sin pasar por aca).
            if (url.pathname === '/flix/check') {
                const provider = url.searchParams.get('provider');
                const imdb = url.searchParams.get('imdb');
                const tmdb = url.searchParams.get('tmdb');
                const slug = url.searchParams.get('slug');
                const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

                try {
                    if (provider === 'flixlatam') {
                        if (!imdb) return new Response(JSON.stringify({ error: 'falta imdb' }), { status: 400, headers: corsHeaders });
                        const r = await fetch(`https://flixlatam.com/vidurl/${imdb}/`, { headers: { 'User-Agent': UA } });
                        const text = await r.text();
                        return new Response(JSON.stringify({ available: r.ok && !text.includes('No folders found') }), { headers: corsHeaders });
                    }
                    if (provider === 'pelisplus') {
                        if (!slug) return new Response(JSON.stringify({ error: 'falta slug' }), { status: 400, headers: corsHeaders });
                        const r = await fetch(`https://www.pelisplushd.la/pelicula/${slug}-${tmdb || ''}`, { headers: { 'User-Agent': UA } });
                        const text = await r.text();
                        return new Response(JSON.stringify({ available: r.ok && !/<title>404 Not found/i.test(text) }), { headers: corsHeaders });
                    }
                    if (provider === 'repelishd') {
                        if (!imdb) return new Response(JSON.stringify({ error: 'falta imdb' }), { status: 400, headers: corsHeaders });
                        const r = await fetch(`https://verhdlink.cam/movie/${imdb}`, { headers: { 'User-Agent': UA } });
                        const text = await r.text();
                        // Sin el titulo, el <title> queda "Movie " sin el imdb pegado atras
                        return new Response(JSON.stringify({ available: r.ok && text.includes(imdb) }), { headers: corsHeaders });
                    }
                    return new Response(JSON.stringify({ error: 'provider desconocido: ' + provider }), { status: 400, headers: corsHeaders });
                } catch (e) {
                    return new Response(JSON.stringify({ available: false, error: e.message }), { headers: corsHeaders });
                }
            }

            // --- 📚 RUTA: CATALOGO DE VIMEUS (para sembrar SelvaFlix) ---
            // La API Key de Vimeus (ak_..., distinta del view_key que va en los
            // embeds) es server-only segun su propia doc ("nunca en el
            // cliente"), asi que este proxy existe solo para que el admin
            // pueda traer el catalogo completo (peliculas/series/animes que
            // Vimeus YA tiene confirmadas) y sembrar SelvaFlix con eso, en vez
            // de cargar titulos a mano y descubrir despues si tienen fuente.
            if (url.pathname === '/flix/vimeus-catalog') {
                const tipo = url.searchParams.get('type'); // movies | series | animes | episodes
                const page = url.searchParams.get('page') || '1';
                const tmdbId = url.searchParams.get('tmdb_id');
                const validos = ['movies', 'series', 'animes', 'episodes'];
                if (!validos.includes(tipo)) return new Response(JSON.stringify({ error: 'type invalido' }), { status: 400, headers: corsHeaders });

                let target = `https://vimeus.com/api/listing/${tipo}?page=${page}`;
                if (tipo === 'episodes' && tmdbId) target += `&tmdb_id=${tmdbId}`;

                const r = await fetch(target, { headers: { 'X-API-Key': env.VIMEUS_API_KEY } });
                const data = await r.json();
                return new Response(JSON.stringify(data), { status: r.status, headers: corsHeaders });
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
