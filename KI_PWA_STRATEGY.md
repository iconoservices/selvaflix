# 🧠 KI: El Secreto de la Instalación Directa (PWA Asimétrica)

Este "Knowledge Item" captura la sabiduría acumulada al implementar el sistema de instalación de **SelvaFlix**. Úsalo para replicar esta experiencia premium en futuros proyectos.

---

## 🚀 El Problema: El botón "tonto"
La mayoría de las PWA fallan porque ponen un botón de "Instalar" que no hace nada cuando el navegador no está listo, o muestran el aviso genérico y molesto de Chrome.

## 🔑 La Solución: El "Gatillo" (deferredPrompt)
Para que un botón manual funcione, debemos capturar el permiso del navegador:

1. **Captura de Señal**: Escuchamos `beforeinstallprompt`. Es como esperar a que el semáforo se ponga en verde.
2. **El Candado**: Ejecutamos `e.preventDefault()`. Esto detiene el aviso feo del navegador.
3. **El Estado**: Guardamos el evento en una variable global (`deferredPrompt`).

```javascript
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e; // Guardamos el gatillo
  showMyCustomButton(); // Mostramos nuestra UI premium
});
```

## 📱 El Desafío de Apple (iOS)
Safari es el "muro" de las PWA. No tiene `beforeinstallprompt`. 
- **Estrategia**: Detección manual de UserAgent. Si es iPhone/iPad y no está en modo `standalone`, mostramos una **Guía Visual**.
- **UX Tip**: No digas "Instalar", di "Agregar al inicio". Muestra los iconos de (↑) y (+).

## 🕵️ Lógica de Cortejo (Zero Spam)
No pidas matrimonio en la primera cita.
- **Visita 1**: Delay de 5s (Interés inicial).
- **Visita 2**: Check de Scroll > 50% (Interés real).
- **Visita 3**: Delay de 20s (Usuario cautivo).
- **Control**: Si el modo es `standalone`, **destruye** toda la lógica de banner. No hay nada más molesto que un anuncio pidiéndote instalar algo que ya instalaste.

---
**Perla de Sabiduría**: Una PWA instalada es un usuario ganado. Haz que la transición sea tan suave como un atardecer en la selva.
