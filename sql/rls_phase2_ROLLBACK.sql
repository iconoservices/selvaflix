-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK de rls_phase2.sql — volver todo a como estaba (RLS apagado)
-- ═══════════════════════════════════════════════════════════════════════════
-- Usar SOLO si después de activar RLS el panel admin no puede editar el
-- catálogo. Pegar entero en el SQL Editor de Supabase y Run. Efecto inmediato.
-- La web pública sigue funcionando igual en todo momento.
-- ═══════════════════════════════════════════════════════════════════════════

drop policy if exists movies_public_read          on public.movies;
drop policy if exists analytics_geo_anon_insert    on public.analytics_geo;
drop policy if exists analytics_geo_read           on public.analytics_geo;
drop policy if exists user_activity_anon_insert    on public.user_activity;
drop policy if exists user_activity_read           on public.user_activity;

alter table public.movies         disable row level security;
alter table public.analytics_geo  disable row level security;
alter table public.user_activity  disable row level security;
