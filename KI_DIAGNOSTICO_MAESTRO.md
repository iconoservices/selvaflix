# 🕵️ PROTOCOLO DE DIAGNÓSTICO MAESTRO (v1.0.0)
Este documento es la "Biblia del Rastreo" para SelvaFlix. Úsalo cuando el reproductor no cargue, los IDs fallen o la selva parezca desierta.

---

### 🔍 Paso 1: La "Pantalla Roja" (Consola de Desarrollador)
La consola es donde el código confiesa sus pecados. 
*   **Acción:** Presiona `F12` (Chrome/Edge) y ve a la pestaña **Console**.
*   **Qué buscar:**
    *   `Uncaught ReferenceError`: Olvidamos definir algo o el orden de los scripts está mal.
    *   `404 Not Found`: Una imagen o un link a un servidor está roto.
    *   `CORS Policy`: El servidor bloqueó la conexión por seguridad (aquí entra el Modo Compatible).
    *   `null is not an object`: Intentamos leer algo que no existe en Firebase.

### 📡 Paso 2: El "Rastreador de Tuberías" (Network)
Aquí vemos si el agua (los datos) fluye por la tubería correcta.
*   **Acción:** Pestaña **Network** -> Clic en el botón del servidor (ej. "Server 1").
*   **Qué buscar:**
    *   Busca la línea que diga `movie.php`, `embed` o el nombre del servidor.
    *   Clica en ella y mira **"Request URL"**.
    *   **Verificación IMDB:** ¿El link tiene `imdb=ttXXXXXXX`? Si dice `imdb=undefined` o está vacío, el problema está en la fase de "Siembra".

### 🗄️ Paso 3: El "Búnker de Datos" (Firebase Console)
La verdad absoluta reside aquí.
*   **Acción:** Entra a la consola de Firebase -> Firestore Database -> Colección `movies`.
*   **Qué buscar:**
    *   Busca la película que falla. 
    *   **Campo `imdbId`:** Debe existir y empezar con `tt`. Si no está, la función de captura de TMDB falló al momento de agregarla.

---

### 🛠️ Checklist de Emergencia (Los Sospechosos de Siempre)
1.  **¿Limpiaste el Búnker?** Pulsa `Control + F5`. El Caché (`sessionStorage`) a veces guarda versiones viejas de los datos y el cambio no se ve hasta que fuerces el refresco.
2.  **¿La API Key de TMDB está viva?** Si el formulario no se llena solo al buscar, es probable que TMDB haya bloqueado la llave o que la función de `external_ids` esté fallando.
3.  **El "Modo Escudo":** Si el video sale en banco o dice "Rechazó la conexión", quita el escudo (Modo Compatible) para liberar el `sandbox`.

---
*Documento custodiado por el Arquitecto y Antigravity. Reservado para operaciones de alto nivel.* 🥥🌴🕵️‍♂️
