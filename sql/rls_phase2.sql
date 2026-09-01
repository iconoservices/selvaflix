-- ═══════════════════════════════════════════════════════════════════════════
-- rls_phase2 — activar Row Level Security en las 3 tablas que el Security
-- Advisor marca como "RLS Disabled in Public"  (movies, analytics_geo,
-- user_activity)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- QUÉ ARREGLA
--   Hoy la anon key (pública, está en el bundle del sitio) puede LEER, ESCRIBIR
--   y BORRAR estas 3 tablas. Cualquiera con F12 podía `delete from movies`.
--
-- CÓMO QUEDA
--   movies         → lectura pública; escritura SOLO por el Worker (service_role).
--   analytics_geo  → la web puede insertar visitas; lectura para el panel.
--   user_activity  → la web puede insertar actividad; lectura para el panel.
--   El email ya no se escribe en user_activity (fix en src/main.js).
--   service_role saltea RLS, así que el Worker (/flix/admin/*) sigue pudiendo
--   todo.
--
-- ANTES DE CORRER ESTO
--   1. El Worker v1.8 tiene que estar desplegado con los secretos
--      SUPABASE_SERVICE_ROLE y ADMIN_KEY cargados en Cloudflare.
--   2. El sitio (Vercel) tiene que estar desplegado con el commit de la Fase 2
--      (las escrituras del admin ya pasando por el Worker).
--   Si corrés esto ANTES, el panel admin no podrá editar el catálogo hasta que
--   los otros dos pasos estén listos (la web pública sigue andando igual).
--
-- CÓMO INSTALAR
--   Pegar este archivo entero en el editor SQL de Supabase y ejecutarlo.
--   Es idempotente: se puede volver a correr sin problema.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── movies ────────────────────────────────────────────────────────────────
alter table public.movies enable row level security;

drop policy if exists movies_public_read on public.movies;
create policy movies_public_read
  on public.movies
  for select
  to anon, authenticated
  using (true);

-- Sin políticas de insert/update/delete: quedan bloqueadas para anon.
-- El Worker escribe con service_role, que saltea RLS por completo.

-- ── analytics_geo ─────────────────────────────────────────────────────────
alter table public.analytics_geo enable row level security;

drop policy if exists analytics_geo_anon_insert on public.analytics_geo;
create policy analytics_geo_anon_insert
  on public.analytics_geo
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists analytics_geo_read on public.analytics_geo;
create policy analytics_geo_read
  on public.analytics_geo
  for select
  to anon, authenticated
  using (true);

-- ── user_activity ─────────────────────────────────────────────────────────
alter table public.user_activity enable row level security;

drop policy if exists user_activity_anon_insert on public.user_activity;
create policy user_activity_anon_insert
  on public.user_activity
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists user_activity_read on public.user_activity;
create policy user_activity_read
  on public.user_activity
  for select
  to anon, authenticated
  using (true);

-- ── Comprobación ──────────────────────────────────────────────────────────
-- Tras correr esto, en el editor SQL:
--   select relname, relrowsecurity
--   from pg_class
--   where relname in ('movies','analytics_geo','user_activity');
-- Las 3 tienen que dar relrowsecurity = true.
--
-- Y el Security Advisor (Database → Advisors) no debería mostrar más los 3
-- errores "RLS Disabled in Public".
