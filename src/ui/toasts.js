// ============================================================
//  🍿 Notificaciones UI Premium (Toasts)
//  Módulo autónomo: solo manipula el DOM (#toast-container).
//  No depende de Firebase ni del estado de la app.
//  Se expone como window.showToast para que lo usen los
//  handlers inline del HTML y el resto de main.js.
// ============================================================

window.showToast = (message, type = 'info', duration = 4000) => {
  const container = document.getElementById('toast-container');
  if (!container) return; // Si no existe el HTML, silencioso

  const toast = document.createElement('div');
  const typeColors = {
      'success': '#2ecc71',
      'error': '#e74c3c',
      'warning': '#f1c40f',
      'info': '#3498db',
      'primary': 'var(--primary)'
  };
  const color = typeColors[type] || typeColors['info'];

  toast.innerHTML = `
      <div style="background: rgba(15,15,15,0.95); border: 1px solid ${color}; border-left: 4px solid ${color};
                  color: white; padding: 12px 18px; border-radius: 8px; font-size: 0.85rem;
                  box-shadow: 0 10px 25px rgba(0,0,0,0.5); font-family: 'Outfit', sans-serif;
                  display: flex; align-items: center; gap: 10px; pointer-events: auto;
                  transform: translateX(120%); transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);">
          ${message}
      </div>
  `;
  container.appendChild(toast);

  // Animar Entrada
  requestAnimationFrame(() => {
      requestAnimationFrame(() => {
          toast.firstElementChild.style.transform = 'translateX(0)';
      });
  });

  // Salida Opcional Automática
  setTimeout(() => {
      toast.firstElementChild.style.transform = 'translateX(120%)';
      toast.firstElementChild.style.opacity = '0';
      setTimeout(() => toast.remove(), 400); // Dar tiempo a la animación css
  }, duration);
};
