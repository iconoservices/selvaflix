-- ═══════════════════════════════════════════════════════════════════════════
-- admin_metrics — agregación del panel de Analíticas (Supabase / Postgres)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO
-- user_activity y analytics_geo se migraron de Firestore a Supabase el
-- 2026-08-19 (commit b0c42cf). Pero window.loadMetrics (src/admin/analytics.js)
-- quedó sin migrar: seguía leyendo la colección de Firestore, que ya nadie
-- escribe, así que los números del panel estaban congelados en esa fecha.
--
-- No alcanza con leer las tablas "en crudo" desde el navegador: user_activity
-- tiene ~200k filas/mes y PostgREST corta cualquier respuesta en 1000 filas.
-- Esta función hace TODO el conteo/agrupado del lado de la base y devuelve un
-- único JSON chico.
--
-- CÓMO INSTALAR
-- Pegar este archivo entero en el editor SQL de Supabase y ejecutarlo una vez.
-- (Las funciones SQL del proyecto no están versionadas en el repo salvo esta —
--  ver login_stats_by_uid, pwa_uids_since, etc., creadas a mano.)
--
-- COLUMNAS QUE ASUME
--   user_activity(ts timestamptz, visitor_id text, action text,
--                 details jsonb, platform text, user_agent text, uid text)
--   analytics_geo(ts timestamptz, type text, country text, city text, ...)
-- ═══════════════════════════════════════════════════════════════════════════

-- Índices de apoyo (no-op si ya existen).
create index if not exists user_activity_ts_idx        on public.user_activity (ts);
create index if not exists user_activity_action_ts_idx on public.user_activity (action, ts);
create index if not exists analytics_geo_type_ts_idx   on public.analytics_geo (type, ts);

-- p_tz_offset_min: minutos a sumar a UTC para obtener la hora local del admin
-- (JS: -new Date().getTimezoneOffset()). Solo afecta al histograma "por hora" /
-- "pico máximo"; los días siguen en UTC para alinear con _computeTimeBuckets.
create or replace function public.admin_metrics(
  p_start         timestamptz,
  p_end           timestamptz,
  p_prev_start    timestamptz,
  p_prev_end      timestamptz,
  p_tz_offset_min int default 0
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with cur as (
    select
      ts,
      visitor_id,
      action,
      details,
      coalesce(nullif(platform, ''), 'Desconocido')       as platform,
      (ts at time zone 'UTC')::date                        as day,
      extract(hour from (ts at time zone 'UTC')
              + (p_tz_offset_min * interval '1 minute'))::int as hour
    from user_activity
    where ts >= p_start and ts <= p_end
      and action <> 'manual_seed'          -- carga masiva del admin, no tráfico real
  ),
  base as (
    select
      count(*) filter (where action = 'page_view')   as page_views,
      count(*) filter (where action = 'play_start')   as plays,
      count(distinct visitor_id)                      as unique_visitors
    from cur
  ),
  prev as (
    select count(*) filter (where action = 'page_view') as prev_page_views
    from user_activity
    where ts >= p_prev_start and ts <= p_prev_end
      and action <> 'manual_seed'
  ),
  returning_v as (
    select count(*) as returning_visitors
    from (
      select visitor_id
      from cur
      where visitor_id is not null
      group by visitor_id
      having count(distinct day) > 1       -- apareció en más de un día distinto
    ) t
  ),
  by_day as (
    select day,
      count(*) filter (where action = 'page_view')  as total,
      count(*) filter (where action = 'play_start')  as plays,
      count(distinct visitor_id)                     as visitors
    from cur
    group by day
  ),
  by_hour as (
    select hour, count(*) as total
    from cur
    group by hour
  ),
  devices as (
    select platform, count(*) as total
    from cur
    group by platform
  ),
  pop_daily as (
    select
      details->>'title' as title,
      day,
      count(*) as c,
      max(ts)  as last_ts
    from cur
    where action = 'play_start'
      and coalesce(details->>'title', '') <> ''
    group by 1, 2
  ),
  pop as (
    select
      title,
      sum(c)::int                    as cnt,
      max(last_ts)                   as last_ts,
      jsonb_object_agg(day::text, c) as by_day
    from pop_daily
    group by title
    order by cnt desc
    limit 15
  ),
  visitors_break as (
    select
      coalesce(visitor_id, 'anónimo') as vid,
      max(platform)                   as platform,
      min(ts)                         as first_ts,
      max(ts)                         as last_ts,
      count(*)                        as events,
      count(*) filter (where action in ('play_start', 'watch_attempt')) as plays
    from cur
    group by 1
    order by max(ts) desc
    limit 500
  ),
  geo_c as (
    select country, count(*) as c
    from analytics_geo
    where type = 'visit' and ts >= p_start and ts <= p_end
      and coalesce(country, '') <> ''
    group by country
  ),
  geo_city as (
    select city, count(*) as c
    from analytics_geo
    where type = 'visit' and ts >= p_start and ts <= p_end
      and coalesce(city, '') <> ''
    group by city
  )
  select jsonb_build_object(
    'pageViews',         (select page_views        from base),
    'plays',             (select plays             from base),
    'uniqueVisitors',    (select unique_visitors   from base),
    'prevPageViews',     (select prev_page_views   from prev),
    'returningVisitors', (select returning_visitors from returning_v),
    'byDay',   (select coalesce(jsonb_agg(jsonb_build_object(
                 'day', to_char(day, 'YYYY-MM-DD'),
                 'total', total, 'plays', plays, 'visitors', visitors
               ) order by day), '[]'::jsonb) from by_day),
    'byHour',  (select coalesce(jsonb_agg(jsonb_build_object(
                 'hour', hour, 'total', total
               ) order by hour), '[]'::jsonb) from by_hour),
    'devices', (select coalesce(jsonb_agg(jsonb_build_object(
                 'platform', platform, 'total', total
               ) order by total desc), '[]'::jsonb) from devices),
    'popular', (select coalesce(jsonb_agg(jsonb_build_object(
                 'title', title,
                 'count', cnt,
                 'lastMs', (extract(epoch from last_ts) * 1000)::bigint,
                 'byDay', by_day
               ) order by cnt desc), '[]'::jsonb) from pop),
    'visitors', (select coalesce(jsonb_agg(jsonb_build_object(
                 'vid', vid,
                 'platform', platform,
                 'firstMs', (extract(epoch from first_ts) * 1000)::bigint,
                 'lastMs',  (extract(epoch from last_ts)  * 1000)::bigint,
                 'events', events,
                 'plays', plays
               ) order by last_ts desc), '[]'::jsonb) from visitors_break),
    'geoCountries', (select coalesce(jsonb_object_agg(country, c), '{}'::jsonb) from geo_c),
    'geoCities',    (select coalesce(jsonb_object_agg(city, c), '{}'::jsonb) from geo_city)
  );
$$;

grant execute on function public.admin_metrics(timestamptz, timestamptz, timestamptz, timestamptz, int)
  to anon, authenticated;

-- Prueba rápida (mes actual):
--   select public.admin_metrics(
--     date_trunc('month', now()), now(),
--     date_trunc('month', now()) - interval '1 month', date_trunc('month', now()) - interval '1 second',
--     -180
--   );
