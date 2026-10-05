-- Run in the Supabase SQL Editor before deploying the dashboard RPC client.
create index if not exists iot_data_source_run_date_idx
  on public.iot_data (data_source, run_date desc);

create index if not exists iot_data_unmatched_created_at_idx
  on public.iot_data (lookup_matched, created_at desc)
  where lookup_matched = false;

create or replace function public.iot_dashboard_last_uploads(source_keys text[])
returns table (
  data_source text,
  run_date date,
  created_at timestamptz,
  vehicle_count bigint,
  file_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with latest_dates as (
    select distinct on (d.data_source)
      d.data_source,
      d.run_date
    from public.iot_data d
    where d.data_source = any(source_keys)
    order by d.data_source, d.run_date desc
  )
  select
    latest.data_source,
    latest.run_date,
    max(d.created_at) as created_at,
    count(distinct nullif(regexp_replace(upper(coalesce(d.vehicle_number, d.raw_vehicle_id, '')), '[^A-Z0-9]', '', 'g'), '')) as vehicle_count,
    count(distinct coalesce(d.upload_batch_id, 'legacy:' || date_trunc('second', d.created_at)::text)) as file_count
  from latest_dates latest
  join public.iot_data d
    on d.data_source = latest.data_source
   and d.run_date = latest.run_date
  group by latest.data_source, latest.run_date;
$$;

revoke all on function public.iot_dashboard_last_uploads(text[]) from public;
grant execute on function public.iot_dashboard_last_uploads(text[]) to anon, authenticated;

notify pgrst, 'reload schema';