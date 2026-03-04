# 🌴 Bitácora de Desarrollo - SelvaFlix

Este documento es el registro oficial de cambios, errores solucionados y decisiones de arquitectura tomadas durante el desarrollo de SelvaFlix.

---

## [1.3] - 2026-03-04
### 🚀 Implementación PWA Inteligente
- **Resumen**: Conversión del sitio en una App instalable con lógica de "cortejo" no intrusiva.
- **Cambios**:
  - `src/main.js`: Implementación de lógica asimétrica para el banner de instalación (visita 1, 2, 3 y alternancia).
  - `public/sw.js`: Creación del Service Worker con estrategia **Network-First** (prioriza datos frescos, usa caché como backup).
  - `index.html`: Adición de meta-tags para iOS y contenedores para el Banner Universal y la Guía de iOS.
  - `src/style.css`: Estilos para banners, guías y animación de pulso en el botón de instalación.
- **Bugs & Soluciones**:
  - *Error*: El navegador a veces ignora la instalación si no hay evento del usuario.
  - *Solución*: Se captura `beforeinstallprompt` y se usa un botón real en el Banner y Navbar para activarlo.
  - *Error iOS*: Safari no soporta la API de instalación automática.
  - *Solución*: Se detecta iPhone/iPad y se muestra una guía visual manual ("Compartir" -> "Agregar a inicio").

## [1.2] - 2026-03-04
### 🎨 Optimización Móvil y Firebase Centralizado
- **Resumen**: Mejora visual en celulares y seguridad en la base de datos.
- **Cambios**:
  - `public/manifest.json`: Cambiados iconos externos (TMDb) por locales (`/icon_192.png`, `/icon_512.png`) para evitar errores 404.
  - `src/envValidator.js`: Nuevo módulo que lanza error si faltan variables `NEXT_PUBLIC_`.
  - `src/firebase.js`: Centralización de la configuración de Firebase para evitar repetición de código.
  - `src/style.css`: Fixes de responsive (hero-cards fluidas, `overflow-x: hidden`).
- **Bugs & Soluciones**:
  - *Error*: Pantalla blanca en celulares por desbordamiento horizontal masivo.
  - *Solución*: Se ajustaron anchos fijos de 500px a `max-width: 100%`.

## [1.1] - 2026-03-02
### 🎥 Ajustes de Vídeo y Navegación
- **Resumen**: Restauración del Bottom Nav y cambio de servidores de vídeo.
- **Cambios**:
  - `src/main.js`: Reemplazo de servidores inestables por **Vidsrc** (audio latino automático).
  - `src/style.css`: Restauración de la barra de categorías en móviles (scroll horizontal).

## [1.0] - Fecha Inicial
### 🌴 Nacimiento de SelvaFlix
- **Resumen**: Estructura base con Vite, Firebase y diseño inspirado en el cine y la naturaleza.
- **Arquitectura**:
  - `index.html`: Punto de entrada único (SPA - Single Page Application).
  - `src/main.js`: Lógica principal, manejador de rutas (hash) y conexión Real-time con Firebase.
  - `src/style.css`: Sistema de diseño con Glassmorphism y variables CSS.
