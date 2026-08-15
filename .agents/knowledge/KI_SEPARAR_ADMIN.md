# 🧠 KI: Cómo separar el admin de `main.js` sin romper el sitio (2026-08-15)

`src/main.js` tiene ~10.900 líneas y buena parte solo corre en el panel admin. La idea
de sacarlo a un módulo de carga diferida es correcta, pero **el camino obvio para
decidir qué mover está minado**. Este documento guarda por qué, y la evidencia real
medida en vivo, para no tener que repetir el trabajo.

---

## ⚠️ Por qué el análisis estático NO sirve acá

El primer intento fue leer `index.html`, ver qué funciones se referencian dentro de
`<section id="admin-view">` y mover esas. Dio una lista de 57 "solo admin".
**La lista estaba mal y moverla habría roto producción.** Tres ejemplos reales:

| Función | El análisis dijo | La realidad |
|---|---|---|
| `handleCardClick` | solo admin | Dibuja **las tarjetas de películas de la portada** (12 usos en `main.js`) |
| `showToast` | solo admin | Vive en `src/ui/toasts.js`, usada **174 veces** |
| `open` | solo admin | Era `window.open()`, un builtin del navegador |

**La causa de raíz**: la mayor parte de la interfaz se genera en tiempo de ejecución
desde plantillas de JS (`innerHTML = items.map(... onclick="window.X()" ...)`). Esos
handlers **no existen en `index.html`**, así que ningún grep sobre el HTML los ve.

Segunda trampa: **los encabezados de sección de `main.js` no coinciden con la frontera
admin/público**. Dentro de la sección "Discovery & Seeding Tool" (1.655 líneas, que
parece 100% admin) viven `handleLogout` y `toggleUserMenu`, que son del sitio público.
Cortar esa sección en bloque deja a los visitantes sin cerrar sesión.

---

## ✅ El método que sí funciona: medir en vivo

Envolver cada función de `window` con un contador, usar el sitio de verdad, y comparar.
Se instrumenta pegando esto **al final de `src/main.js`** (temporal, no commitear):

```js
(() => {
  const ifr = document.createElement('iframe');
  ifr.style.display = 'none';
  document.documentElement.appendChild(ifr);
  const nativas = new Set(Object.keys(ifr.contentWindow)); // separa lo tuyo de lo del navegador
  ifr.remove();
  window.__llamadas = new Set();
  for (const n of Object.keys(window).filter(k =>
        !nativas.has(k) && !k.startsWith('__') && typeof window[k] === 'function')) {
    const orig = window[n];
    window[n] = function (...a) { window.__llamadas.add(n); return orig.apply(this, a); };
  }
})();
```

Importante: tiene que ir **en el código fuente**, no inyectado desde la consola. Si se
inyecta después de cargar la página, se pierden las ~14 funciones que corren al arranque.

Luego: navegar como visitante → guardar `[...window.__llamadas]` → activar admin
(`localStorage.selva_admin_auth = 'true'`, ir a `#admin`) → recorrer las pestañas →
restar. **Al terminar, restaurar `main.js`.**

---

## 📊 Evidencia medida (sesión del 2026-08-15)

### Públicas confirmadas — NUNCA mover (37)

Corren al cargar la web o al navegar como visitante normal:

```
closeMobileSearch, closePlayer, closePremiumModal, closeSupportChat,
ensureFreePlanExists, goToHome, goToMyList, handleCardClick, hideSplashScreen,
injectCampaignScripts, injectGlobalAdScripts, loadAdConfig, loadFreeTrialConfig,
loadMyList, loadPlansConfig, markWatchingEpisode, maybeShowPremiumPromo,
normalizeText, openMobileSearch, openMovieDetail, openPlayer, openPremiumModal,
openSupportChat, recordAdView, renderAdCampaignList, renderFreeTrialBanner,
renderPlansList, renderPremiumPlansGrid, setFilter, setGenre, setIframeSource,
shareApp, showToast, toggleUserMenu, trackUserGeo, triggerLandingAd,
watchSupportUnread
```

> 👀 `renderPlansList` y `renderAdCampaignList` estaban acá al medir: sonaban a admin
> pero las ejecutaba todo visitante. **Ya se arregló** (commit `99efbcb`): se separó
> "cargar datos" de "dibujar el panel", así que ahora son solo-admin de verdad y se
> pueden mover. Ver la nota en cada una dentro de `main.js`.

### Solo admin confirmadas — seguras de mover (30)

Se llamaron al entrar a `#admin` y recorrer sus pestañas, nunca como visitante:

```
_applyMetricsRangeFromState, _computeMetricsRangeForPreset, _computeTimeBuckets,
_loadFcmSubsCount, _updateMetricsRangeLabel, applyMetricsFilters, closeCleanupModal,
closeMassSeedModal, closeUploadDrawer, filterInventoryByCategory, initMetricsSelectors,
loadAdminMessages, loadMetrics, loadMoreInventory, loadPremiumCount, loadRecommendedMix,
loadRegisteredUsers, loadReports, loadVisitorInsights, openCleanupModal,
openMassSeedModal, openUploadDrawer, previewCleanup, renderDayChart, renderGeoChart,
setDayChartMode, setMetricsPreset, shiftMetricsRange, stopMiniPlayer, switchAdminTab
```

Casi todas son de **Analíticas** (`loadMetrics`, `renderDayChart`, `renderGeoChart`,
`_computeTimeBuckets`…), que además arrastra Chart.js. Es el mejor primer bloque a
extraer.

### Segunda pasada — auditoría más a fondo (misma fecha)

Se repitió la medición apretando muchos más botones en ambos lados:

| | 1ª pasada | 2ª pasada |
|---|---|---|
| Públicas confirmadas | 37 | **56** |
| Solo admin (no vistas en público) | 30 | **61** |
| Sin clasificar | 165 | **91** |

**Las 19 públicas nuevas** que aparecieron al usar perfiles, ajustes, PIN, Mi Lista y
compartir: `applyProfile`, `closeAuthModal`, `closePinModal`, `closeWarningOverlay`,
`dismissPremiumPromo`, `focusNextPin` (¡no!, ver abajo), `loadContinueWatching`,
`loadProfiles`, `openAvatarPicker`, `renderProfiles`, `selectProfile`, `setYear`,
`showAddProfile`, `showInstaller`, `showProfileSelector`, `showSettings`,
`syncPlaybackProgress`, `toggleManageProfiles`, `toggleMyListModal`,
`updateSettingsAccountInfo`.

### ⚠️ El "solo admin" es una respuesta más débil que el "público"

Ojo con la asimetría, es lo más importante de todo esto:

- **"Se vio en público" es prueba fuerte** → esa función se queda, punto.
- **"No se vio en público" NO prueba que sea de admin** → solo prueba que no se apretó
  ese botón en esa sesión.

Ejemplo real de la 2ª pasada: `requestPlanInterest` quedó listada como "solo admin",
pero es el botón **"Quiero este plan"** que aprieta el usuario en la ventanita de
Premium. Cayó ahí solo porque en la sesión pública no se hizo clic.

**Regla práctica**: antes de mover algo de la lista "solo admin", leer su nombre y
preguntarse "¿esto lo puede tocar un visitante?". Si hay la menor duda, no moverla o
medirla de nuevo apretando ese botón puntual.

### Las 91 sin clasificar

Casi todas son acciones destructivas o de escritura que a propósito NO se ejecutaron en
la auditoría (`nukeDatabase`, `deleteMovie`, `bulkDeleteMovies`, `grantPremium`,
`massSeedMovies`, `savePlansConfig`, `sendAdminReply`, `uploadBannerArt`…). Por el
nombre casi todas son de admin, pero **no están verificadas**. Hay excepciones claras
que son públicas: `toggleMyList`, `handleLogout`, `validatePinEntry`, `forgotPin`,
`detailShareMovie`, `reportBrokenLink`, `selectProfile`.

---

## 🎯 Recomendación

El premio es modesto: el bundle es ~820 kB (249 kB comprimido) y separar el admin
ahorraría quizá ~120 kB comprimidos. Para comparar, sacar WebTorrent en esta misma
fecha ahorró **0.9 MB por visita**, unas 8 veces más y sin riesgo.

Así que: hacerlo solo si se hace bien, empezando por el bloque de **Analíticas**, y
midiendo antes cada tanda. Nunca mover una función sin haberla visto en la lista de
"solo admin confirmadas".
