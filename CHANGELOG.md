# 🌴 Bitácora de Desarrollo - SelvaFlix

Este documento es el registro oficial de cambios, errores solucionados y decisiones de arquitectura tomadas durante el desarrollo de SelvaFlix.

---

## [1.6] - 2026-03-04
### 🛡️ Punto de Restauración (Safe Point)
- **Resumen**: Backup completo antes de la **Operación: Caza del Vampiro** (Optimización de Firebase).
- **Estado**: La app SelvaFlix v1.5 funciona correctamente pero presenta un consumo excesivo de cuota en Firebase. Este es el último punto estable antes de la reescritura de los Listeners.

---


## [1.5] - 2026-03-04
### 🧠 Implementación de Memoria y Conocimiento (GPS Pro)
- **Resumen**: Establecimiento de la arquitectura de documentación proactiva y gestión de conocimiento.
- **Cambios**:
  - `MAP.md`: Creación del GPS del proyecto para navegación rápida y decisiones técnicas.
  - `KI_PWA_STRATEGY.md`: Documentación de los "secretos" de la implementación PWA asimétrica.
  - `src/main.js` & `public/sw.js`: Inyección de "Perlas de Sabiduría" (comentarios con contexto y metáforas).
  - Adoptado el rol de **Arquitecto de Memoria Pro**.
- **UX/PX Radar**: Mejora radical en la Experiencia del Desarrollador (PX) para garantizar que el proyecto sea mantenible a largo plazo.

## [1.4] - 2026-03-04
### 🚀 Sincronización Cerebral y Rebranding: SelvaFlix
- **Resumen**: Transición completa de la identidad del proyecto de "Cocona TV" a **SelvaFlix**.
- **Cambios**:
  - `package.json`: Actualizado nombre del proyecto a `selvaflix`.
  - `index.html`: Sincronización de títulos, SEO y etiquetas de administración.
  - `src/main.js`: ADN de Marca actualizado; reemplazo de terminología "Coconas" por "Títulos/Tesoros" y refactorización de clases (`.selva-check`).
  - `src/style.css`: Actualización de clases y comentarios de marca.
  - `public/sw.js`: Bump de caché para asegurar la limpieza del branding viejo en los navegadores de los usuarios.
- **Bugs & Soluciones**:
  - *Asunto*: Nombres de archivos y carpetas quedaron desalineados tras el cambio manual de la carpeta raíz.
  - *Solución*: Se realizó un barrido completo de todas las referencias de ruta y marca para garantizar integridad total.


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
