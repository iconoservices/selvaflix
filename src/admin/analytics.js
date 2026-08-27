/**
 * 📊 Analíticas del panel admin
 * ─────────────────────────────────────────────────────────────────────────
 * Extraído de main.js el 2026-08-15. Se carga con import() dinámico desde
 * switchAdminTab('analytics'), así que un visitante normal NUNCA lo baja
 * (ni este archivo ni el trabajo de pintar los gráficos).
 *
 * Que estas 12 funciones son solo-admin NO se dedujo leyendo el código:
 * se midió en vivo instrumentando window y usando el sitio como visitante
 * y como admin. Ver .agents/knowledge/KI_SEPARAR_ADMIN.md — ahí está
 * explicado por qué el análisis estático da falsos en este proyecto.
 *
 * Dependencias: se inyectan desde main.js con init() para que este módulo
 * no vuelva a inicializar Firebase ni cree un import circular.
 * Chart.js es global (viene por <script> en index.html).
 */

let db, collection, query, where, orderBy, getDocs, supabase;

export function init(deps) {
  ({ db, collection, query, where, orderBy, getDocs, supabase } = deps);
}

// Estado propio de Analíticas: vivía suelto en main.js pero solo lo usa esto.
let _dayChartMode = 'bars';   // 'bars' | 'line' — toggle de "Actividad por Día"
let _dayChartBuckets = [];    // Buckets del último loadMetrics, para repintar sin re-consultar

// Agrupa un rango de fechas en buckets de día/semana/mes según su duración,
// para que "Actividad por Día" siga siendo legible en rangos largos (ej. "Este año"
// no debería intentar pintar 365 barras/puntos).
window._computeTimeBuckets = (start, end) => {
  const spanDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const toISO = (d) => d.toISOString().split('T')[0];
  const monthNames = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const buckets = [];
  let granularity = 'day';

  // Lista de días del rango en UTC (mismo criterio que byDay/toISOString en
  // loadMetrics) — evita que las etiquetas se corran un día por zona horaria
  // si se derivaran con getDate()/getMonth() locales en su lugar.
  const allDayKeys = [];
  let cursor = new Date(start);
  while (cursor <= end) { allDayKeys.push(toISO(cursor)); cursor.setDate(cursor.getDate() + 1); }

  if (spanDays > 92) {
    granularity = 'month';
    const byMonth = {};
    allDayKeys.forEach(k => {
      const monthKey = k.slice(0, 7); // YYYY-MM
      if (!byMonth[monthKey]) byMonth[monthKey] = [];
      byMonth[monthKey].push(k);
    });
    Object.keys(byMonth).sort().forEach(monthKey => {
      const m = parseInt(monthKey.slice(5, 7), 10) - 1;
      buckets.push({ label: monthNames[m], keys: byMonth[monthKey] });
    });
  } else if (spanDays > 31) {
    granularity = 'week';
    for (let i = 0; i < allDayKeys.length; i += 7) {
      const weekKeys = allDayKeys.slice(i, i + 7);
      const [, m, d] = weekKeys[0].split('-');
      buckets.push({ label: `${d}/${m}`, keys: weekKeys });
    }
  } else {
    allDayKeys.forEach(k => buckets.push({ label: k.split('-')[2], keys: [k] }));
  }

  return { granularity, buckets };
};

// Pinta metrics-day-chart con los buckets ya calculados (_dayChartBuckets), en
// modo barras o línea según _dayChartMode. Separado de loadMetrics para poder
// repintar al instante al tocar el toggle, sin re-consultar Firestore.
window.renderDayChart = () => {
  const dayChart = document.getElementById('metrics-day-chart');
  if (!dayChart) return;
  const buckets = _dayChartBuckets;
  if (!buckets || buckets.length === 0) {
    dayChart.innerHTML = '<div style="margin:auto; color:#555; font-size:0.7rem;">Sin datos.</div>';
    return;
  }

  if (_dayChartMode === 'line') {
    const maxEvents = Math.max(...buckets.map(b => b.total), 1);
    const w = Math.max(buckets.length * 24, 100);
    const h = 100;
    const stepX = buckets.length > 1 ? w / (buckets.length - 1) : 0;
    const pointsFor = (key) => buckets.map((b, i) => {
      const x = buckets.length > 1 ? i * stepX : w / 2;
      const y = h - (b[key] / maxEvents) * h;
      return `${x},${y}`;
    }).join(' ');
    const dotsFor = (key, color) => buckets.map((b, i) => {
      const x = buckets.length > 1 ? i * stepX : w / 2;
      const y = h - (b[key] / maxEvents) * h;
      return `<circle cx="${x}" cy="${y}" r="2.5" fill="${color}"><title>${b.label}: ${b[key]}</title></circle>`;
    }).join('');

    dayChart.innerHTML = `
      <div style="display:flex; flex-direction:column; width:100%; height:100%;">
        <div style="display:flex; gap:12px; margin-bottom:4px; flex-shrink:0;">
          <span style="display:flex; align-items:center; gap:4px; font-size:0.55rem; color:#999;"><span style="width:8px; height:8px; border-radius:2px; background:#3498DB; display:inline-block;"></span>Visitas</span>
          <span style="display:flex; align-items:center; gap:4px; font-size:0.55rem; color:#999;"><span style="width:8px; height:8px; border-radius:2px; background:#F1C40F; display:inline-block;"></span>Reproducciones</span>
        </div>
        <!-- El <svg> con viewBox tiene su propio aspect-ratio intrínseco (w:h del
             viewBox), que en flexbox gana sobre flex:1 si el <svg> mismo es el
             flex item — se estiraba a ~192px en vez de llenar los ~140px de la
             tarjeta, empujando las etiquetas fuera de la vista. Envolverlo en un
             <div> con flex:1 + min-height:0 (sin aspect-ratio propio) evita eso. -->
        <div style="flex:1; min-height:0; position:relative;">
          <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%; height:100%; display:block; overflow:visible;">
            <line x1="0" y1="${h}" x2="${w}" y2="${h}" stroke="rgba(255,255,255,0.12)" stroke-width="1" vector-effect="non-scaling-stroke" />
            <polyline points="${pointsFor('total')}" fill="none" stroke="#3498DB" stroke-width="2" vector-effect="non-scaling-stroke" />
            <polyline points="${pointsFor('plays')}" fill="none" stroke="#F1C40F" stroke-width="2" vector-effect="non-scaling-stroke" />
            ${dotsFor('total', '#3498DB')}${dotsFor('plays', '#F1C40F')}
          </svg>
        </div>
        <div style="display:flex; margin-top:4px; flex-shrink:0;">
          ${buckets.map(b => `<span style="flex:1; text-align:center; font-size:0.5rem; color:#777; overflow:hidden; white-space:nowrap;">${b.label}</span>`).join('')}
        </div>
      </div>
    `;
  } else {
    const maxEvents = Math.max(...buckets.map(b => b.total), 1);
    dayChart.innerHTML = buckets.map(b => {
      const h1 = (b.total / maxEvents) * 100;
      const h2 = (b.plays / maxEvents) * 100;
      return `
        <div style="flex:1; min-width:18px; display:flex; flex-direction:column; align-items:center; gap:4px; height:100%;">
          <div style="flex:1; width:100%; display:flex; align-items:flex-end; gap:1px; position:relative; background:rgba(255,255,255,0.01); border-radius:1px;">
            <div style="width:50%; height:${h1}%; background:#3498DB; opacity:0.8;" title="${b.label}: ${b.total} visitas"></div>
            <div style="width:50%; height:${h2}%; background:#F1C40F; opacity:0.8;" title="${b.label}: ${b.plays} reproducciones"></div>
          </div>
          <span style="font-size:0.5rem; color:#777;">${b.label}</span>
        </div>
      `;
    }).join('');
  }
};

// 👥 Usuarios Únicos por Día (DAU) — mismos buckets que "Actividad por Día"
// (día/semana/mes según el rango, ver _computeTimeBuckets). byDay[k].visitors
// es el conteo de visitantes DISTINTOS de ese día, que ya calculó Postgres
// (count(distinct visitor_id) en admin_metrics). Para buckets de un solo día
// (rangos ≤ 31 días) es exacto. Para buckets semana/mes se suman los uniques
// diarios: alguien que entró lunes y martes de la misma semana cuenta 2 en vez
// de 1 — es una aproximación por arriba, aceptable para este gráfico (antes se
// unían los Sets de IDs, pero con ~200k filas/mes ya no se bajan al navegador).
window.renderDAUChart = (timeBuckets, byDay) => {
  const el = document.getElementById('metrics-dau-chart');
  if (!el) return;

  const buckets = timeBuckets.buckets.map(b => {
    let dau = 0;
    b.keys.forEach(k => { const v = byDay[k]; if (v) dau += (v.visitors || 0); });
    return { label: b.label, dau };
  });

  if (buckets.length === 0 || buckets.every(b => b.dau === 0)) {
    el.innerHTML = '<div style="margin:auto; color:#555; font-size:0.7rem;">Sin datos.</div>';
    return;
  }

  const max = Math.max(...buckets.map(b => b.dau), 1);
  el.innerHTML = buckets.map(b => {
    const h = (b.dau / max) * 100;
    return `
      <div style="flex:1; min-width:18px; display:flex; flex-direction:column; align-items:center; gap:4px; height:100%;">
        <div style="flex:1; width:100%; display:flex; align-items:flex-end; position:relative; background:rgba(255,255,255,0.01); border-radius:1px;">
          <div style="width:100%; height:${h}%; background:#9b59b6; opacity:0.85; border-radius:1px 1px 0 0;" title="${b.label}: ${b.dau} usuarios únicos"></div>
        </div>
        <span style="font-size:0.5rem; color:#777;">${b.label}</span>
      </div>
    `;
  }).join('');
};

// Toggle barras/línea del gráfico "Actividad por Día" en Analíticas
window.setDayChartMode = (mode) => {
  _dayChartMode = mode;
  window.renderDayChart();
  const barsBtn = document.getElementById('daychart-mode-bars');
  const lineBtn = document.getElementById('daychart-mode-line');
  [barsBtn, lineBtn].forEach(b => { if (b) { b.style.opacity = '0.5'; b.style.fontWeight = 'normal'; } });
  const activeBtn = mode === 'line' ? lineBtn : barsBtn;
  if (activeBtn) { activeBtn.style.opacity = '1'; activeBtn.style.fontWeight = '800'; }
};

// Abre/cierra el desglose por día/semana/mes de un título en la tabla de Popularidad
window.togglePopularDetail = (rowId, triggerRow) => {
  const detailRow = document.getElementById(rowId);
  if (!detailRow) return;
  const isOpen = detailRow.style.display !== 'none';
  detailRow.style.display = isOpen ? 'none' : 'table-row';
  const arrow = triggerRow.querySelector('span');
  if (arrow) arrow.textContent = isOpen ? '▸' : '▾';
};

window.initMetricsSelectors = () => {
  // Por defecto: Este Mes al abrir el tab
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const lastDay = now.toISOString().split('T')[0];
  
  const startEl = document.getElementById('metrics-start-date');
  const endEl = document.getElementById('metrics-end-date');
  
  if (startEl && endEl) {
    // Solo fijamos el default si los campos están vacíos (primera vez que se abre).
    // No disparamos loadMetrics aquí: quien llama a initMetricsSelectors se encarga
    // de pedir los datos después (evita duplicar la consulta a Firestore).
    if (!startEl.value) {
      startEl.value = firstDay;
      endEl.value = lastDay;
      window._metricsMode = 'month';
      window._metricsAnchor = now;
    }
  }
  window._updateMetricsRangeLabel(window._metricsMode, window._metricsAnchor || now, startEl?.value, endEl?.value);
};

window.applyMetricsFilters = () => {
  const start = document.getElementById('metrics-start-date').value;
  const end = document.getElementById('metrics-end-date').value;
  if (!start || !end) return;
  // Rango escrito a mano: ya no es "Hoy/7 días/Mes/Año", así que ◀ ▶ no aplican.
  window._metricsMode = null;
  window._updateMetricsRangeLabel();
  window.loadMetrics(start, end);
};

// Calcula el rango [start, end] (YYYY-MM-DD) para un preset, anclado a una
// fecha de referencia — esa ancla es la que se mueve con ◀ ▶.
window._computeMetricsRangeForPreset = (preset, anchor) => {
  const toISO = (d) => d.toISOString().split('T')[0];
  let start, end;
  if (preset === 'today') {
    start = new Date(anchor);
    end = new Date(anchor);
  } else if (preset === '7d') {
    end = new Date(anchor);
    start = new Date(anchor);
    start.setDate(start.getDate() - 6);
  } else if (preset === 'month') {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  } else if (preset === 'year') {
    start = new Date(anchor.getFullYear(), 0, 1);
    end = new Date(anchor.getFullYear(), 11, 31);
  }
  return { start: toISO(start), end: toISO(end) };
};

// Atajos rápidos de rango de fechas para Analíticas (Hoy / 7 días / Mes / Año).
// Guarda el modo y la fecha ancla en window._metrics* para que ◀ ▶ (shiftMetricsRange)
// sepan por cuánto moverse (1 día / 1 semana / 1 mes / 1 año según el modo activo).
window.setMetricsPreset = (preset) => {
  if (!['today', '7d', 'month', 'year'].includes(preset)) return;
  window._metricsMode = preset;
  window._metricsAnchor = new Date();
  window._applyMetricsRangeFromState();
};

// ◀ ▶ de la vista de Analíticas: mueve la fecha ancla un paso (del tamaño del
// modo activo) y recarga. No hace nada si el rango actual es "personalizado"
// (cargado a mano con Aplicar), porque ahí no hay un "paso" bien definido.
window.shiftMetricsRange = (direction) => {
  if (!window._metricsMode) return;
  const a = window._metricsAnchor ? new Date(window._metricsAnchor) : new Date();
  if (window._metricsMode === 'today') a.setDate(a.getDate() + direction);
  else if (window._metricsMode === '7d') a.setDate(a.getDate() + direction * 7);
  else if (window._metricsMode === 'month') a.setMonth(a.getMonth() + direction);
  else if (window._metricsMode === 'year') a.setFullYear(a.getFullYear() + direction);
  window._metricsAnchor = a;
  window._applyMetricsRangeFromState();
};

window._applyMetricsRangeFromState = () => {
  const preset = window._metricsMode;
  const anchor = window._metricsAnchor || new Date();
  const { start, end } = window._computeMetricsRangeForPreset(preset, anchor);

  const startEl = document.getElementById('metrics-start-date');
  const endEl = document.getElementById('metrics-end-date');
  if (startEl) startEl.value = start;
  if (endEl) endEl.value = end;

  window._updateMetricsRangeLabel(preset, anchor, start, end);
  window.loadMetrics(start, end);
};

const METRICS_MONTH_NAMES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

window._updateMetricsRangeLabel = (preset, anchor, startStr, endStr) => {
  const labelEl = document.getElementById('metrics-range-label');
  const prevBtn = document.getElementById('metrics-range-prev');
  const nextBtn = document.getElementById('metrics-range-next');
  if (!labelEl) return;

  if (!preset) {
    labelEl.innerText = 'Rango personalizado';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }
  if (prevBtn) prevBtn.disabled = false;
  if (nextBtn) nextBtn.disabled = false;

  const todayISO = new Date().toISOString().split('T')[0];
  let text = '';
  if (preset === 'today') {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (startStr === todayISO) text = 'Hoy';
    else if (startStr === yesterday.toISOString().split('T')[0]) text = 'Ayer';
    else text = startStr;
  } else if (preset === '7d') {
    text = `${startStr} → ${endStr}`;
  } else if (preset === 'month') {
    text = `${METRICS_MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`;
  } else if (preset === 'year') {
    text = `${anchor.getFullYear()}`;
  }
  labelEl.innerText = text;
};

// Cuántos dispositivos tienen push activado. No depende del rango de fechas
// de Analíticas, así que se cachea y solo se vuelve a pedir a Firestore si
// pasaron más de 5 min o si se fuerza (force=true) — evita descargar TODA
// la colección "users" cada vez que cambiás de Hoy a 7 días a Este mes, etc.
let _fcmSubsCountCache = null;
let _fcmSubsCountFetchedAt = 0;
window._loadFcmSubsCount = async (force = false) => {
  const subsEl = document.getElementById("push-subs-count");
  const fresh = Date.now() - _fcmSubsCountFetchedAt < 5 * 60 * 1000;
  if (_fcmSubsCountCache !== null && fresh && !force) {
    if (subsEl) subsEl.innerText = `${_fcmSubsCountCache} dispositivos suscritos.`;
    return;
  }
  try {
    const usersSnap = await getDocs(collection(db, "users"));
    let tokenCount = 0;
    usersSnap.forEach(d => { if (d.data().fcmToken) tokenCount++; });
    _fcmSubsCountCache = tokenCount;
    _fcmSubsCountFetchedAt = Date.now();
    if (subsEl) subsEl.innerText = `${tokenCount} dispositivos suscritos.`;
  } catch (e) { console.error("Error cargando usuarios: ", e); }
};

window.loadMetrics = async (startDateStr, endDateStr) => {
  const log = document.getElementById('metrics-recent-log');
  const popularList = document.getElementById('metrics-popular-list');
  const deviceChart = document.getElementById('metrics-device-chart');

  // Gemelos del widget compacto en el Panel (Resumen General)
  const logDash = document.getElementById('metrics-recent-log-dashboard');
  const popularListDash = document.getElementById('metrics-popular-list-dashboard');

  // KPI Elements
  const totalVisits = document.getElementById('stat-total-visits');
  const totalPlays = document.getElementById('stat-total-plays');
  const totalUniqueEl = document.getElementById('stat-unique-visitors');
  const growthEl = document.getElementById('stat-growth');
  const peakEl = document.getElementById('stat-peak-hour');
  const returningEl = document.getElementById('stat-returning-visitors');
  const returningPctEl = document.getElementById('stat-returning-pct');

  if (log) log.innerText = "Sincronizando con la selva... 📡";
  if (logDash) logDash.innerText = "Sincronizando con la selva... 📡";

  try {
    // Si no hay fechas, usar mes actual por defecto
    if (!startDateStr || !endDateStr) {
        const now = new Date();
        startDateStr = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        endDateStr = now.toISOString().split('T')[0];
        // Los selectores de fecha pueden no existir en el panel; blindar el .value
        const sEl = document.getElementById('metrics-start-date');
        const eEl = document.getElementById('metrics-end-date');
        if (sEl) sEl.value = startDateStr;
        if (eEl) eEl.value = endDateStr;
    }

    const start = new Date(startDateStr);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDateStr);
    end.setHours(23, 59, 59, 999);

    const rangeDuration = end.getTime() - start.getTime();
    const prevStart = new Date(start.getTime() - rangeDuration - 1);
    const prevEnd = new Date(start.getTime() - 1);

    // 📦 AGREGACIÓN EN EL SERVIDOR (Postgres / Supabase).
    // user_activity y analytics_geo se migraron a Supabase el 2026-08-19
    // (commit b0c42cf) pero ESTA función quedó sin migrar y siguió leyendo la
    // colección de Firestore, que ya nadie escribe: los números estaban
    // congelados en esa fecha. Y no alcanza con leerlas de Supabase "crudo":
    // son ~200k filas/mes y PostgREST corta la respuesta en 1000 filas. La
    // función SQL admin_metrics() agrupa todo del lado de la base y devuelve un
    // JSON chico. Correr una sola vez el SQL de sql/admin_metrics.sql en el
    // editor SQL de Supabase.
    const [rpcRes, logRes, geoTotalRes] = await Promise.all([
      supabase.rpc('admin_metrics', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_prev_start: prevStart.toISOString(),
        p_prev_end: prevEnd.toISOString(),
        p_tz_offset_min: -new Date().getTimezoneOffset(), // hora local del admin p/ el pico
      }),
      // Log reciente: con 30 filas alcanza y entra en el tope de 1000 de PostgREST.
      supabase.from('user_activity')
        .select('ts, action, details, platform')
        .neq('action', 'manual_seed')
        .gte('ts', start.toISOString()).lte('ts', end.toISOString())
        .order('ts', { ascending: false })
        .limit(30),
      // Denominador para los % del desglose geográfico (lo cuenta Postgres).
      supabase.from('analytics_geo')
        .select('ts', { count: 'exact', head: true })
        .eq('type', 'visit')
        .gte('ts', start.toISOString()).lte('ts', end.toISOString()),
    ]);

    if (rpcRes.error) throw rpcRes.error;
    const M = rpcRes.data || {};

    // ── KPIs ──────────────────────────────────────────────────────────────
    const pageViews = M.pageViews || 0;
    const plays = M.plays || 0;
    const uniqueCount = M.uniqueVisitors || 0;

    if (totalVisits) totalVisits.innerText = pageViews;
    if (totalPlays) totalPlays.innerText = plays;
    if (totalUniqueEl) totalUniqueEl.innerText = uniqueCount;

    // Breakdown por visitante para el modal "Detalle de visitantes"
    // (lo lee renderVisitorDetailTable en main.js). Top 500 por última actividad.
    window._lastVisitorBreakdown = Array.isArray(M.visitors) ? M.visitors : [];
    window._lastMetricsData = window._lastVisitorBreakdown; // compat con lectores viejos

    if ((pageViews + plays + uniqueCount) === 0) {
      if (log) log.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);"><p>Sin actividad registrada en este periodo.</p></div>';
      if (logDash) logDash.innerHTML = '<div style="text-align:center; padding:10px; color:var(--admin-text-muted);">Sin actividad registrada.</div>';
      if (popularListDash) popularListDash.innerHTML = '<tr><td colspan="2" style="text-align:center; padding: 15px;">Sin datos.</td></tr>';
      if (popularList) popularList.innerHTML = '<tr><td colspan="2" style="text-align:center; padding: 20px;">No hay datos.</td></tr>';
      [growthEl, peakEl].forEach(el => { if (el) el.innerText = '0'; });
      if (returningEl) returningEl.innerText = '0';
      if (returningPctEl) returningPctEl.innerText = '0%';
      return;
    }

    // ── Recurrentes ───────────────────────────────────────────────────────
    // % de visitantes del período que aparecieron en más de un día distinto.
    const recurrentes = M.returningVisitors || 0;
    if (returningEl) returningEl.innerText = recurrentes;
    if (returningPctEl) returningPctEl.innerText = `${uniqueCount > 0 ? Math.round((recurrentes / uniqueCount) * 100) : 0}%`;

    // ── Crecimiento vs período anterior similar (sobre page_views) ─────────
    const prevPageViews = (M.prevPageViews == null) ? null : (M.prevPageViews || 0);
    if (growthEl && prevPageViews !== null) {
      if (prevPageViews === 0) {
        growthEl.innerText = 'New';
        growthEl.style.color = '#2ECC71';
      } else {
        const diff = ((pageViews - prevPageViews) / prevPageViews) * 100;
        growthEl.innerText = `${diff > 0 ? '+' : ''}${Math.round(diff)}%`;
        growthEl.style.color = diff >= 0 ? '#2ECC71' : '#E74C3C';
      }
    }

    // ── byDay / byHour (ya vienen agrupados por Postgres) ─────────────────
    // M.byDay: [{ day:'YYYY-MM-DD', total, plays, visitors }]
    const byDay = {};
    (M.byDay || []).forEach(r => {
      byDay[r.day] = { total: r.total || 0, plays: r.plays || 0, visitors: r.visitors || 0 };
    });

    // M.byHour: [{ hour:0..23, total }]
    const byHour = new Array(24).fill(0);
    (M.byHour || []).forEach(r => {
      const h = Number(r.hour);
      if (h >= 0 && h < 24) byHour[h] = r.total || 0;
    });

    // ⚡ Pico máximo (hora con más tráfico)
    let peakH = 0;
    for (let h = 1; h < 24; h++) if (byHour[h] > byHour[peakH]) peakH = h;
    if (peakEl && byHour[peakH] > 0) peakEl.innerText = `${peakH}:00 hs`;

    // 📅 Actividad por Día/Semana/Mes (buckets según el largo del rango).
    const timeBuckets = window._computeTimeBuckets(start, end);
    window.renderDAUChart(timeBuckets, byDay);
    _dayChartBuckets = timeBuckets.buckets.map(b => {
      let total = 0, plays = 0;
      b.keys.forEach(k => { const v = byDay[k]; if (v) { total += v.total; plays += v.plays; } });
      return { label: b.label, total, plays };
    });
    window.renderDayChart();

    // Mapa fecha -> índice de bucket, para el desglose por título en Popularidad.
    const bucketIndexByDay = {};
    timeBuckets.buckets.forEach((b, i) => b.keys.forEach(k => { bucketIndexByDay[k] = i; }));

    // 🕒 Actividad por Hora (Peak Map)
    const hourChart = document.getElementById('metrics-hour-chart');
    if (hourChart) {
      const maxH = Math.max(...byHour, 1);
      hourChart.innerHTML = byHour.map((total, h) => {
        const height = (total / maxH) * 100;
        const label = h.toString().padStart(2, '0');
        return `
          <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:4px; height:100%;">
            <div style="flex:1; width:100%; display:flex; align-items:flex-end; background:rgba(255,255,255,0.01);">
              <div style="width:100%; height:${height}%; background:#E67E22; opacity:0.8; border-radius:1px 1px 0 0;"></div>
            </div>
            <span style="font-size:0.45rem; color:#444;">${label}</span>
          </div>
        `;
      }).join('');
    }

    // 🕒 Log Reciente (30 filas traídas aparte de la agregación)
    const buildLogRow = (d) => {
      const date = new Date(d.timestamp).toLocaleTimeString();
      let color = "#2ECC71"; // green
      let emoji = "👀";
      if (d.action === 'play_start' || d.action === 'watch_attempt') { color = "#F1C40F"; emoji = "🎬"; }
      if (d.action === 'page_view') { color = "#3498DB"; emoji = "🧭"; }
      if (d.action === 'mass_seed') { color = "#E67E22"; emoji = "🚜"; }

      return `<div style="margin-bottom: 5px; border-bottom: 1px solid #222; padding-bottom: 2px;">
                <span style="color: #666;">[${date}]</span>
                <span style="color: ${color}; font-weight: bold;">${emoji} ${(d.action || '').toUpperCase()}</span>:
                <span style="color: #eee;">${d.details?.title || d.details?.page || 'N/A'}</span>
                <span style="font-size: 0.6rem; color: #444;"> (${d.platform})</span>
            </div>`;
    };
    const recentRows = (logRes.data || []).map(r => ({
      timestamp: r.ts ? Date.parse(r.ts) : 0,
      action: r.action || 'unknown',
      details: r.details || {},
      platform: r.platform || 'Desconocido',
    }));
    if (log) log.innerHTML = recentRows.slice(0, 30).map(buildLogRow).join('') || '<div style="text-align:center; padding:20px; color:var(--text-muted);">Sin eventos recientes.</div>';
    if (logDash) logDash.innerHTML = recentRows.slice(0, 8).map(buildLogRow).join('') || '<div style="text-align:center; padding:10px; color:var(--admin-text-muted);">Sin eventos recientes.</div>';

    // 🏆 Popularidad — M.popular: [{ title, count, lastMs, byDay:{'YYYY-MM-DD':n} }]
    const counts = {};
    (M.popular || []).forEach(p => {
      const byBucket = new Array(_dayChartBuckets.length).fill(0);
      Object.entries(p.byDay || {}).forEach(([day, n]) => {
        const bIdx = bucketIndexByDay[day];
        if (bIdx !== undefined && byBucket[bIdx] !== undefined) byBucket[bIdx] += Number(n) || 0;
      });
      counts[p.title] = { count: p.count || 0, last: p.lastMs || 0, byBucket };
    });
    const sortedPopularAll = Object.entries(counts).sort((a, b) => b[1].count - a[1].count);

    // Fila simple sin desglose, para el widget compacto del Panel (Dashboard)
    const buildPopularRowSimple = ([title, info]) => `
            <tr>
                <td style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px;">${title}</td>
                <td style="font-weight: bold; color:white; text-align:right;">${info.count}</td>
            </tr>
        `;

    // Fila expandible (clic para ver el desglose) usada en la tabla completa de Analíticas
    const buildPopularRowDetailed = ([title, info], idx) => {
      const rowId = `pop-detail-${idx}`;
      const breakdown = _dayChartBuckets
        .map((b, i) => ({ label: b.label, count: info.byBucket[i] || 0 }))
        .filter(x => x.count > 0);
      const breakdownHtml = breakdown.length
        ? breakdown.map(x => `<span style="display:inline-block; background:rgba(255,255,255,0.06); border-radius:4px; padding:2px 6px; margin:2px; font-size:0.6rem; color:#ccc;">${x.label}: <b style="color:#F1C40F;">${x.count}</b></span>`).join('')
        : '<span style="color:#555; font-size:0.65rem;">Sin desglose disponible.</span>';
      return `
            <tr style="cursor:pointer;" onclick="window.togglePopularDetail('${rowId}', this)" title="Clic para ver el desglose por fecha">
                <td style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px;"><span style="color:#666; font-size:0.6rem; margin-right:4px;">▸</span>${title}</td>
                <td style="font-weight: bold; color:white; text-align:right;">${info.count}</td>
            </tr>
            <tr id="${rowId}" style="display:none; background:rgba(255,255,255,0.02);">
                <td colspan="2" style="padding:8px 12px;">${breakdownHtml}</td>
            </tr>
        `;
    };

    if (popularList) popularList.innerHTML = sortedPopularAll.slice(0, 10).map(buildPopularRowDetailed).join('') || '<tr><td colspan="2" style="text-align:center; padding: 20px;">No hay datos.</td></tr>';
    if (popularListDash) popularListDash.innerHTML = sortedPopularAll.slice(0, 5).map(buildPopularRowSimple).join('') || '<tr><td colspan="2" style="text-align:center; padding: 15px;">Sin datos.</td></tr>';

    // 📱 Dispositivos — M.devices: [{ platform, total }]
    if (deviceChart) {
      const platforms = {};
      (M.devices || []).forEach(r => { platforms[r.platform || 'Desconocido'] = r.total || 0; });
      const vals = Object.values(platforms);
      const max = vals.length ? Math.max(...vals) : 1;

      deviceChart.innerHTML = Object.entries(platforms).map(([plat, count]) => {
        const width = (count / max) * 100;
        return `
                <div style="background: rgba(255,255,255,0.02); padding: 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.03);">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 0.6rem;">
                        <span style="color: #aaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80px;">${plat}</span>
                        <span style="color: #3498DB; font-weight: 800;">${count}</span>
                    </div>
                    <div style="height: 4px; background: rgba(255,122,0,0.05); border-radius: 2px; overflow: hidden;">
                        <div style="width: ${width}%; height: 100%; background: #3498DB; box-shadow: 0 0 5px rgba(52,152,219,0.3);"></div>
                    </div>
                </div>
            `;
      }).join('');
    }

    // 🌍 ANALÍTICAS GEOGRÁFICAS — M.geoCountries / M.geoCities: { nombre: conteo }
    const geoCountries = M.geoCountries || {};
    const geoCities = M.geoCities || {};
    const geoTotal = geoTotalRes.error ? 0 : (geoTotalRes.count || 0);
    if (Object.keys(geoCountries).length || Object.keys(geoCities).length) {
      window.renderGeoChart('metrics-geo-countries', 'Países', geoCountries, 'met_countries');
      window.renderGeoChart('metrics-geo-cities', 'Ciudades', geoCities, 'met_cities');

      const geoTableBody = document.getElementById('metrics-geo-table-body');
      if (geoTableBody) {
        const topCons = Object.entries(geoCountries).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const denom = Math.max(geoTotal, ...Object.values(geoCountries), 1);
        geoTableBody.innerHTML = topCons.map(([name, count]) => `
                <tr>
                    <td style="font-weight: bold; color: white;">${name}</td>
                    <td style="text-align: center;">${count}</td>
                    <td style="text-align: center; color: var(--primary);">
                        ${((count / denom) * 100).toFixed(1)}%
                    </td>
                </tr>
            `).join('') || '<tr><td colspan="3" style="text-align:center;">Sin datos geográficos.</td></tr>';
      }
    }

  } catch (err) {
    console.error("Error loading metrics:", err);
    const faltaRPC = err && (err.code === 'PGRST202' || err.code === '42883' || /admin_metrics/.test(err.message || ''));
    const msg = faltaRPC
      ? 'Falta la función <code>admin_metrics</code> en Supabase. Corré una vez el SQL de <b>sql/admin_metrics.sql</b> en el editor SQL de Supabase y reintentá.'
      : `Error: ${err.message || err}`;
    if (log) {
      log.innerHTML = `
            <div style="text-align:center; padding: 20px;">
                <p style="color: #E74C3C; font-weight:bold;">¡No se pudieron cargar las métricas! 🐒</p>
                <p style="font-size:0.7rem; color:var(--text-muted); margin-top:5px;">${msg}</p>
                <button class="btn btn-secondary" style="margin-top:15px; padding:6px 15px; font-size:0.7rem;" onclick="window.loadMetrics()">Reintentar 🔄</button>
            </div>
        `;
    }
    if (logDash) {
      logDash.innerHTML = `<div style="text-align:center; padding:10px; color:#E74C3C; font-size:0.7rem;">No se pudieron cargar las métricas 🐒</div>`;
    }
  }
};
