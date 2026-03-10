export const TMDB_API_KEY = '15d2ea6d0dc1d476efbca3eba2b9bbfb';
export const TMDB_URL = 'https://api.themoviedb.org/3';
export const TMDB_IMG_URL = 'https://image.tmdb.org/t/p/w500';

export async function fetchFromTMDB(endpoint, params = {}) {
    const url = new URL(`${TMDB_URL}${endpoint}`);
    url.searchParams.append('api_key', TMDB_API_KEY);
    url.searchParams.append('language', 'es-MX');
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

    try {
        const response = await fetch(url);
        return await response.json();
    } catch (error) {
        console.error(`Error en TMDB (${endpoint}):`, error);
        return null;
    }
}
