# SelvaFlix caído por egress de Supabase — cómo lo arreglamos

**Fecha:** 2026-09-06
**Síntoma:** ninguna peli carga. La base de SelvaFlix devuelve `HTTP 402 —
exceed_egress_quota`. El plan gratis de Supabase da 5 GB de egress/mes y la org
los pasó (iba 11.4 / 5 GB). Supabase restringió **todos** los proyectos de la
org (SelvaFlix y boga-market comparten cupo).

---

## Por qué se pasó de 5 GB

El Worker cacheaba el catálogo en `caches.default` — que es **por-colo de
Cloudflare y se evicta solo**. Cada vez que ese caché se vaciaba, el Worker
rebajaba la tabla `movies` entera (~9900 filas) de Supabase. Y cuando Supabase
empezó a dar 402, el Worker devolvía error → **cada visitante caía a bajar el
catálogo entero directo de Supabase**. Espiral: miss → todos a Supabase → 402 →
el Worker no puede rellenar → más directo. 228 % del cupo.

---

## Parte 1 — que el sitio no se vea en blanco (YA, no necesita Supabase)

`src/main.js`:
- **Tarjeta de mantenimiento** (`mostrarOverlayMantenimiento`): si el catálogo
  vuelve vacío, se muestra "volvemos el 12" + campo de mail, en vez de un home
  vacío. Los mails los junta el Worker en KV (`/flix/waitlist`), porque
  Firestore rechaza a los visitantes anónimos.
  → cambiar `SELVA_MANTENIMIENTO_HASTA` con la fecha real del reset.
- El front **ya no cae a Supabase directo** cuando el Worker da 5xx (500/502/504):
  no iba a andar igual y solo empeoraba el egress.
- **No se abre el websocket de Realtime** si el catálogo vino vacío (antes se
  quedaba reconectando en loop para siempre).

Deploy: push a `main` (Vercel auto-despliega).

Ver los mails juntados:
```
curl -H "x-selva-admin: <ADMIN_KEY>" https://icono-proxy.jnmcsky.workers.dev/flix/waitlist
```

---

## Parte 2 — que no vuelva a reventar (Worker v1.9)

`worker/index.js` — `/flix/catalog` pasa a 3 niveles:

| Nivel | Qué es | Egress de Supabase |
|---|---|---|
| L1 | `caches.default` (por-colo, 10 min) | 0 |
| L2 | **KV global** (`CATALOG_KV`), lo refresca un **Cron 1×/día** + cada edición del admin | ~1 descarga/día |
| L3 | KV vacío (primer arranque) → se construye en el momento | 1 vez |

- Si Supabase está caído/402, se sigue sirviendo **la última copia buena de KV
  para siempre** → el Worker nunca devuelve error → el navegador nunca vuelve a
  pegarle directo a Supabase.
- El catálogo va **gzipeado** en KV.
- Escrituras del admin: refrescan KV, pero como mucho 1 vez cada 90 s.

**Estimación:** de ~11 GB/mes → **< 1 GB/mes** para el catálogo.

### Configuración en Cloudflare (una sola vez)

1. Worker `icono-proxy` → **Settings → Bindings → Add → KV Namespace**
   - Variable name: `CATALOG_KV`
   - KV namespace: crear uno nuevo, ej. `selva-catalog`
2. **Settings → Triggers → Cron Triggers → Add**
   - `0 3 * * *`  (1×/día; las ediciones del admin refrescan KV solas)
3. **Deploy** el Worker.

Sin el binding `CATALOG_KV`, `/flix/catalog` responde `503` y el sitio cae al
camino viejo (directo a Supabase) — no rompe nada, pero tampoco mejora.

### Verificar (con Supabase ya restaurado)

```
curl -s -H "x-selva-auth: selva_master_key_2026_premium" \
  "https://icono-proxy.jnmcsky.workers.dev/flix/catalog" \
  -w "\nHTTP %{http_code} | %{size_download} bytes\n" | tail -c 300
```
Tiene que dar un JSON con títulos y `HTTP 200`. Headers útiles:
`X-Selva-Catalog-Count` y `X-Selva-Catalog-Age-Sec`.

---

## Restaurar Supabase HOY (sin pagar los $25 de Pro)

Opciones, de menos a más laburo:

1. **Esperar al reset del ciclo.** El egress del plan gratis se resetea cada mes
   en la fecha del ciclo. Ver la fecha exacta en **Supabase → Organization →
   Billing**. Si es el 12, faltan pocos días. En cuanto vuelva, el primer hit a
   `/flix/catalog` (o el Cron) llena KV y ya queda blindado.

2. **Sacar boga-market a otra org.** SelvaFlix y boga-market comparten el cupo de
   5 GB. Ver el egress **por proyecto** (cada Project → Reports → Egress). Si
   SelvaFlix solo quedó por debajo de 5 GB, mover boga-market a una org nueva
   (Project Settings → General → Transfer project) **re-habilita SelvaFlix solo**.

3. **Proyecto Supabase nuevo + migrar `movies`.** Cupo fresco hoy. Dump/restore
   de la tabla + cambiar `VITE_SUPABASE_URL` (sitio) y `SUPABASE_URL` (Worker).
   Igual hay que tener el Worker v1.9 puesto o revienta de nuevo en ~2 semanas.

> El SQL de RLS (`sql/rls_phase2.sql`) es OTRA cosa (seguridad) — **no** hace
> falta para esto, no correrlo ahora.
