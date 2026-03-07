# 🏛️ PLAN MAESTRO: INFRAESTRUCTURA SELVA v5.0 (El Embudo)
Este documento guarda la estrategia definitiva de arquitectura de streaming para SelvaFlix, garantizando que el usuario siempre tenga un video que reproducir, escalando desde la calidad pura hasta el respaldo seguro.

---

## 🌊 FASE 1: La Realeza (Red P2P / WebTorrent)
**Botones 1 y 2 (Prioridad Absoluta)**
*   **Tecnología:** Protocolo BitTorrent a través del navegador (WebRTC / WebTorrent).
*   **Fuentes Principales:** `Torrentio` (Cinecalidad, MejorTorrent) y `Comet`.
*   **Proceso:** SelvaFlix obtiene el *Magnet Link* de la API y lo descarga en tiempo real trozo a trozo conectándose a otros usuarios (Seeders) en el mundo, inyectando el video en una etiqueta `<video>` nativa.
*   **Ventajas:** Calidad original (4K/1080p), Cero Anuncios, Resistencia infinita (si hay seeders, el servidor no puede caer porque no existe un servidor central).
*   **Limitante:** Requiere buen internet y que la peli sea popular (tenga seeders).

## 🛡️ FASE 2: La Tropa de Choque (Scrapers Embed)
**Botones 3, 4 y sucesivos (El Respaldo Rápido)**
*   **Tecnología:** Mini-Scraped Nativo de SelvaFlix (Inyección de iFrames).
*   **Fuentes Principales:** Páginas estables definidas por el Arquitecto (ej. PelisPlus, Cuevana, etc.).
*   **Proceso:** Si la Fase 1 falla o el usuario la rechaza, SelvaFlix rastrea el código HTML de estas páginas en la sombra, extrae el reproductor oculto (`iframe`) y lo muestra en pantalla.
*   **Ventajas:** Carga inmediata garantizada. Ideal para películas antiguas o sin seeders.
*   **Limitante:** Contienen la publicidad original del servidor (requiere Modo Escudo/Brave) y dependen de que el servidor no borre el archivo.

---

## 💎 FASE 3 (Futuro): El Servidor VIP (Debrid)
**La Vía de Monetización Premium**
*   **Tecnología:** Puente HTTP a través de un servicio Debrid (Ej. Real-Debrid por ~4€/mes).
*   **Proceso:** SelvaFlix envía el Magnet Link al servidor Debrid. El servidor lo descarga a velocidad GigaBit y nos devuelve un enlace `.mp4` directo y limpio.
*   **Negocio:** Esta opción requiere que el Arquitecto pague el servidor. Es la puerta perfecta para crear un **"SelvaFlix Premium"** donde los usuarios paguen una suscripción para tener 4K instantáneo y sin depender de WebTorrent.
*   **Viabilidad:** Totalmente escalable y fácil de integrar cuando llegue el momento.

---
*Documento custodiado por Antigravity y el Arquitecto. Prohibida su distribución.* 🥥🌴✨
