# 🗺️ El Mapa del Tesoro: SelvaFlix GPS

Este archivo es el mapa maestro para navegar por las entrañas de **SelvaFlix**. Aquí entenderás cómo está construida la selva y qué función cumple cada "árbol" (archivo).

---

## 🏗️ Arquitectura del Sistema
**SelvaFlix** es una **SPA (Single Page Application)** construida con Vanilla JS y alimentada por el motor de **Vite**. No usamos frameworks pesados para que la app vuele, incluso con señal débil en la selva.

### 📁 Carpetas Clave
- `src/`: El corazón palpitante. Aquí vive la lógica, el estilo y la conexión con el mundo exterior.
- `public/`: Los activos estáticos. Aquí viven los iconos, el manifiesto de la PWA y el Service Worker.
- `.agents/`: Los secretos del Arquitecto. Aquí guardamos los planes y flujos de trabajo.

---

## 🌲 Los Árboles Maestros (Estructura de Archivos)

### 📄 index.html
Es la **Puerta de Entrada**. 
- **Decisión Técnica**: Usamos una sola página que intercambia "vistas" usando el `#hash` de la URL.
- **UX Radar**: Configurado con meta-tags para "Home Screen" de iOS y Android.

### 📄 src/main.js
El **Cerebro Central**.
- Controla el enrutamiento, la búsqueda en TMDB y la sincronización en tiempo real con Firebase.
- **Perla de Sabiduría**: Actúa como el *Guía de la Expedición*, decidiendo qué contenido mostrar y cómo reaccionar a los clics.

### 📄 src/style.css
La **Piel de la Selva**.
- **Estética**: Glassmorphism (capas transparentes y difuminadas) y variables CSS para colores tropicales.
- **UX Radar**: Diseño 100% Responsivo. Las `hero-cards` se adaptan para no romper el layout en pantallas pequeñas.

### 📄 public/sw.js
El **Conserje Invisible** (Service Worker).
- **Estrategia**: *Network-First*. Siempre intenta buscar la fruta fresca (datos nuevos), pero si la red cae, te sirve lo que guardó en su mochila (caché).

---

## 🔑 Decisiones Técnicas Críticas

1. **Firebase Sync**: Usamos `onSnapshot` para que, si el administrador añade una película desde su PC, aparezca en el móvil del usuario al instante, sin recargar.
2. **PWA Asimétrica**: No atosigamos al usuario. El banner de instalación solo aparece tras demostrar "interés real" (lógica de 5s o 50% de scroll).
3. **Multi-Servidor**: Si un enlace de video muere, la app ofrece 6 alternativas para que el cine nunca se detenga.

---

## 🛠️ Herramientas de Mantenimiento
- `VERSION.txt`: Nuestro reloj de evolución.
- `CHANGELOG.md`: Nuestra memoria histórica.
- `MAP.md`: Este GPS.

---
*Ultima actualización: 2026-03-04 - Rebranding SelvaFlix v1.4*
