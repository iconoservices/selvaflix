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
            // ═══════════════════════════════════════════════════════════════
            //  RUTAS /flix/*  →  las usa SelvaFlix
            //  (más abajo están las /beat/* y /img, que son de OTRA app —
            //   ojo al tocarlas, no dependen de SelvaFlix)
            // ═══════════════════════════════════════════════════════════════
            //
            // 📌 2026-08-15: se eliminó /flix/unrestrict, el puente a Real-Debrid.
            // Real-Debrid ya no está contratado y SelvaFlix dejó de llamarlo (ninguna
            // fuente genera `infoHash`). Queda en el historial de git por si acaso.
            //
            // ⚠️ NO borres el secreto RD_API_KEY de Cloudflare: /beat/stream (la otra
            // app) todavía lo usa, y está escrito para funcionar igual si la clave no
            // responde (cae a Cobalt), así que su fallo sería silencioso.

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
                    // PelisMart es un dominio espejo del mismo backend que FlixLatam
                    // (mismo /vidurl/, mismo EMBED69 detras, mismo error "No folders
                    // found" con HTTP 200 cuando no tiene el titulo) — mismo chequeo.
                    if (provider === 'pelismart') {
                        if (!imdb) return new Response(JSON.stringify({ error: 'falta imdb' }), { status: 400, headers: corsHeaders });
                        const r = await fetch(`https://pelismart.mov/vidurl/${imdb}/`, { headers: { 'User-Agent': UA } });
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

            // --- 🔗 RUTA: EXTRACT-LINKS (Extrae los links reales detrás de los iframes) ---
            // Resuelve el POW de FlixLatam/PelisMart server-side y desencripta los links AES.
            // Para Vimeus, parsea el JSON del embed directamente (sin POW, solo CORS lo blockeaba).
            // Para RepelisHD, extrae los data-link="..." del HTML.
            // Devuelve lista de { servername, link } — el cliente elige el mejor (VOE primero).
            if (url.pathname === '/flix/extract-links') {
                const provider = url.searchParams.get('provider');
                const imdb = url.searchParams.get('imdb');
                const tmdb = url.searchParams.get('tmdb');
                const type = url.searchParams.get('type') || 'movie'; // movie | serie | anime
                const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

                try {
                    // ── FlixLatam (y PelisMart) ──────────────────────────────────────────────
                    if (provider === 'flixlatam' || provider === 'pelismart') {
                        if (!imdb) return new Response(JSON.stringify({ error: 'falta imdb' }), { status: 400, headers: corsHeaders });
                        const baseUrl = provider === 'pelismart'
                            ? `https://pelismart.mov/vidurl/${imdb}/`
                            : `https://flixlatam.com/vidurl/${imdb}/`;
                        const pageRes = await fetch(baseUrl, { headers: { 'User-Agent': UA } });
                        if (!pageRes.ok) return new Response(JSON.stringify({ error: `${provider} no respondio`, status: pageRes.status }), { status: 502, headers: corsHeaders });
                        const html = await pageRes.text();
                        if (html.includes('No folders found')) return new Response(JSON.stringify({ error: 'titulo no disponible en ' + provider }), { status: 404, headers: corsHeaders });

                        // Extraer variables del HTML
                        const challengeM = html.match(/const\s+POW_CHALLENGE\s*=\s*'([^']+)'/);
                        const difficultyM = html.match(/const\s+POW_DIFFICULTY\s*=\s*(\d+)/);
                        const saltM = html.match(/const\s+POW_SALT\s*=\s*'([^']+)'/);
                        const dataLinkM = html.match(/let\s+dataLink\s*=\s*(\[[\s\S]*?\]);/);

                        if (!challengeM || !difficultyM || !saltM || !dataLinkM) {
                            return new Response(JSON.stringify({ error: provider + ' cambio su formato (no se encontraron variables POW o dataLink)' }), { status: 500, headers: corsHeaders });
                        }

                        const challenge = challengeM[1];
                        const difficulty = parseInt(difficultyM[1], 10);
                        const salt = saltM[1];
                        const dataLink = JSON.parse(dataLinkM[1]);

                        // Resolver POW: SHA-256(challenge + nonce).startsWith('0'.repeat(difficulty))
                        // La dificultad es 3 = prefijo "000", se resuelve en ~5-50ms
                        const enc = new TextEncoder();
                        const prefix = '0'.repeat(difficulty);
                        let nonce = 0;
                        let aesKeyBytes = null;
                        while (true) {
                            const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(challenge + nonce));
                            const hex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
                            if (hex.startsWith(prefix)) {
                                aesKeyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(challenge + nonce + salt)));
                                break;
                            }
                            nonce++;
                            if (nonce > 2000000) return new Response(JSON.stringify({ error: 'POW timeout — dificultad demasiado alta' }), { status: 500, headers: corsHeaders });
                        }

                        // Importar key AES-256-CBC
                        const cryptoKey = await crypto.subtle.importKey('raw', aesKeyBytes.slice(0, 32), { name: 'AES-CBC' }, false, ['decrypt']);

                        // Descifrar cada embed.link (AES-CBC, IV en los primeros 16 bytes del base64)
                        const decryptLink = async (encB64) => {
                            try {
                                const raw = Uint8Array.from(atob(encB64), c => c.charCodeAt(0));
                                const iv = raw.slice(0, 16);
                                const ct = raw.slice(16);
                                const pt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, ct);
                                return new TextDecoder().decode(pt);
                            } catch { return null; }
                        };

                        // Acumular links desencriptados de todos los "files" (idiomas)
                        const SERVER_PRIORITY = ['voe', 'streamwish', 'vidhide', 'filemoon', 'doodstream', 'rapidvideo'];
                        const results = [];
                        for (const file of dataLink) {
                            const label = file.video_language || file.label || 'N/A';
                            const embeds = [...(file.sortedEmbeds || []), ...(file.downloadEmbeds || [])];
                            for (const embed of embeds) {
                                if (!embed.link) continue;
                                const decrypted = await decryptLink(embed.link);
                                if (decrypted) results.push({ servername: embed.servername, link: decrypted, lang: label });
                            }
                        }

                        // Ordenar por prioridad de servidor
                        results.sort((a, b) => {
                            const pa = SERVER_PRIORITY.indexOf(a.servername);
                            const pb = SERVER_PRIORITY.indexOf(b.servername);
                            return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
                        });

                        return new Response(JSON.stringify({ links: results, nonce }), { headers: corsHeaders });
                    }

                    // ── Vimeus ───────────────────────────────────────────────────────────────
                    if (provider === 'vimeus') {
                        const viewKey = env.VIMEUS_VIEW_KEY || 'bVQEGHe-bF4PjDWQ5xbzE2SPoBnj3ofRi2pj0VXPYzk';
                        const idParam = tmdb ? `tmdb=${tmdb}` : (imdb ? `imdb=${imdb}` : null);
                        if (!idParam) return new Response(JSON.stringify({ error: 'falta tmdb o imdb' }), { status: 400, headers: corsHeaders });
                        const vimeusType = type === 'anime' ? 'anime' : (type === 'serie' || type === 'series' ? 'serie' : 'movie');
                        const vimeusUrl = `https://vimeus.com/e/${vimeusType}?${idParam}&view_key=${viewKey}`;
                        const vRes = await fetch(vimeusUrl, { headers: { 'User-Agent': UA } });
                        const vHtml = await vRes.text();
                        const dataM = vHtml.match(/<script type="text\/json" id="data">([\s\S]*?)<\/script>/);
                        if (!dataM) return new Response(JSON.stringify({ error: 'Vimeus no devolvio JSON de data' }), { status: 404, headers: corsHeaders });
                        const data = JSON.parse(dataM[1]);
                        if (!data.embeds || data.embeds.length === 0) return new Response(JSON.stringify({ error: 'Vimeus no tiene embeds para este titulo' }), { status: 404, headers: corsHeaders });

                        // Filtrar por latino y priorizar VOE
                        const SERVER_PRIORITY = ['voe', 'goodstream', 'vimeos', 'hlswish', 'filemoon', 'jawcloud', 'fembed'];
                        const embeds = data.embeds.filter(e => e.lang === 'Latino');
                        embeds.sort((a, b) => {
                            const getDomain = u => { try { return new URL(u).hostname.replace('www.','').split('.')[0]; } catch { return u; } };
                            const pa = SERVER_PRIORITY.indexOf(getDomain(a.url));
                            const pb = SERVER_PRIORITY.indexOf(getDomain(b.url));
                            return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
                        });
                        const links = embeds.map(e => {
                            const domain = (() => { try { return new URL(e.url).hostname.replace('www.','').split('.')[0]; } catch { return 'unknown'; } })();
                            return { servername: domain, link: e.url, lang: e.lang, quality: e.quality };
                        });
                        return new Response(JSON.stringify({ links, title: data.title }), { headers: corsHeaders });
                    }

                    // ── RepelisHD ────────────────────────────────────────────────────────────
                    if (provider === 'repelishd') {
                        if (!imdb) return new Response(JSON.stringify({ error: 'falta imdb' }), { status: 400, headers: corsHeaders });
                        const rRes = await fetch(`https://verhdlink.cam/movie/${imdb}`, { headers: { 'User-Agent': UA } });
                        if (!rRes.ok) return new Response(JSON.stringify({ error: 'RepelisHD no respondio', status: rRes.status }), { status: 502, headers: corsHeaders });
                        const rHtml = await rRes.text();
                        if (!rHtml.includes(imdb)) return new Response(JSON.stringify({ error: 'titulo no disponible en RepelisHD' }), { status: 404, headers: corsHeaders });

                        const dataLinkRegex = /data-link="([^"]+)"/g;
                        const links = [];
                        let m;
                        while ((m = dataLinkRegex.exec(rHtml)) !== null) {
                            let link = m[1];
                            if (link.startsWith('//')) link = 'https:' + link;
                            const domain = (() => { try { return new URL(link).hostname.replace('www.','').split('.')[0]; } catch { return 'unknown'; } })();
                            links.push({ servername: domain, link });
                        }
                        if (links.length === 0) return new Response(JSON.stringify({ error: 'RepelisHD no tiene links para este titulo' }), { status: 404, headers: corsHeaders });
                        return new Response(JSON.stringify({ links }), { headers: corsHeaders });
                    }

                    return new Response(JSON.stringify({ error: 'provider desconocido: ' + provider + '. Válidos: flixlatam, pelismart, vimeus, repelishd' }), { status: 400, headers: corsHeaders });

                } catch (e) {
                    return new Response(JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) }), { status: 500, headers: corsHeaders });
                }
            }


            // --- 🔎 RUTA: CHECK-EMBED (¿el link de video detrás de un embed sigue vivo?) ---
            // Vimeus puede decir que un episodio "tiene embed" (su JSON no viene
            // vacío) pero el host de video de terceros al que apunta (fembed,
            // streamtape, etc.) puede llevar años caído. Caso confirmado: Friends
            // T1E1 apunta a fembed.com, que hoy devuelve HTTP 200 pero con una
            // pagina "Redirecting..." que en realidad es puro detector de adblock
            // para forzar publicidad -- no hay reproductor de video ahi. Sin esto,
            // el chequeo de "tiene embed" da un falso positivo.
            if (url.pathname === '/flix/check-embed') {
                const embedUrl = url.searchParams.get('url');
                if (!embedUrl) return new Response(JSON.stringify({ error: 'falta url' }), { status: 400, headers: corsHeaders });
                const UA2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
                try {
                    const r = await fetch(embedUrl, { headers: { 'User-Agent': UA2 } });
                    const text = await r.text();
                    const esPaginaDeAnuncios = /<title>\s*Redirecting\.\.\.\s*<\/title>/i.test(text)
                        && /ad-overlay|prebid-wrapper|dfp-ad-container/i.test(text);
                    return new Response(JSON.stringify({ muerto: !r.ok || esPaginaDeAnuncios }), { headers: corsHeaders });
                } catch (e) {
                    // Si el chequeo en si falla (host lento, etc.), no se penaliza
                    // al titulo por un hipo nuestro -- se asume vivo.
                    return new Response(JSON.stringify({ muerto: false, error: e.message }), { headers: corsHeaders });
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

                if (!env.VIMEUS_API_KEY) {
                    return new Response(JSON.stringify({ error: 'Falta la variable VIMEUS_API_KEY en el worker (Settings -> Variables and Secrets)' }), { status: 500, headers: corsHeaders });
                }

                const r = await fetch(target, { headers: { 'X-API-Key': env.VIMEUS_API_KEY } });
                const rawText = await r.text();
                // Diagnostico: si Vimeus devuelve vacio o algo que no es JSON,
                // se ve el motivo en vez de "Unexpected end of JSON input" a ciegas.
                let data;
                try {
                    data = JSON.parse(rawText);
                } catch (e) {
                    return new Response(JSON.stringify({ error: 'Vimeus no devolvio JSON', status: r.status, bodyPreview: rawText.slice(0, 300) }), { status: 502, headers: corsHeaders });
                }
                return new Response(JSON.stringify(data), { status: r.status, headers: corsHeaders });
            }

            // ═══════════════════════════════════════════════════════════════
            //  RUTAS /beat/* y /img  →  NO son de SelvaFlix (otra app, YouTube).
            //  Este worker está compartido: borrar algo de acá rompe ese
            //  proyecto, no este. Verificar antes de tocar.
            // ═══════════════════════════════════════════════════════════════

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
