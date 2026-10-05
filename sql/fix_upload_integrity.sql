-- Run after create_iot_data_table.sql, before deploying the RPC upload client.
-- Safe to re-run. This migration never removes or rewrites existing IoT rows.
-- Existing duplicates remain available; all new client writes are serialized
-- and checked against the complete table inside a single database transaction.
begin;

alter table public.iot_data
  add column if not exists upload_batch_id text;

create index if not exists iot_data_normalized_vehicle_date_idx
  on public.iot_data (
    data_source,
    run_date,
    (regexp_replace(upper(coalesce(nullif(btrim(vehicle_number), ''), raw_vehicle_id, '')), '[^A-Z0-9]', '', 'g'))
  );

create index if not exists iot_data_upload_batch_id_idx
  on public.iot_data (upload_batch_id);

-- Receipts are private: they include the exact input to make a retry safe and
-- to reject accidental or malicious reuse of a batch ID with different data.
create schema if not exists iot_private;
revoke all on schema iot_private from public, anon, authenticated;

create table if not exists iot_private.upload_receipts (
  upload_batch_id text primary key,
  data_source text not null,
  upload_payload jsonb not null,
  inserted_count bigint not null check (inserted_count >= 0),
  skipped_count bigint not null check (skipped_count >= 0),
  created_at timestamptz not null default now()
);

alter table iot_private.upload_receipts enable row level security;
revoke all privileges on table iot_private.upload_receipts from public, anon, authenticated;

alter table public.iot_data enable row level security;
drop policy if exists "Allow anon insert iot_data" on public.iot_data;
drop policy if exists "Allow anon delete iot_data" on public.iot_data;
drop policy if exists "Allow anon read iot_data" on public.iot_data;
create policy "Allow anon read iot_data"
  on public.iot_data for select to anon, authenticated using (true);

-- Revoke table and any pre-existing column grants. RLS alone would not protect
-- TRUNCATE, and a column INSERT grant must not bypass the RPC write path.
revoke all privileges on table public.iot_data from public, anon, authenticated;
do $$
declare
  column_names text;
  identity_sequence text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
    into column_names
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.iot_data'::regclass
    and a.attnum > 0
    and not a.attisdropped;

  execute format(
    'revoke all privileges (%s) on table public.iot_data from public, anon, authenticated',
    column_names
  );

  identity_sequence := pg_catalog.pg_get_serial_sequence('public.iot_data', 'id');
  if identity_sequence is not null then
    execute format(
      'revoke all privileges on sequence %s from public, anon, authenticated',
      identity_sequence
    );
  end if;
end;
$$;
grant select on table public.iot_data to anon, authenticated;

create or replace function public.save_iot_upload(upload_rows jsonb)
returns table (inserted bigint, skipped bigint)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  row_value jsonb;
  source_key text;
  source_label text;
  batch_id text;
  row_date date;
  vehicle_key text;
  input_count bigint;
  conflict_dates text;
  saved_payload jsonb;
  saved_inserted bigint;
  saved_skipped bigint;
begin
  if upload_rows is null or jsonb_typeof(upload_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'Upload must contain an array of rows.';
  end if;

  input_count := jsonb_array_length(upload_rows);
  if input_count = 0 then
    raise exception using errcode = '22023', message = 'Upload contains no rows.';
  end if;

  source_key := upload_rows -> 0 ->> 'data_source';
  batch_id := upload_rows -> 0 ->> 'upload_batch_id';
  if source_key is null or source_key not in ('opspod_ev91', 'alt_mobility', 'vehicle_day_report', 'Recent_Details') then
    raise exception using errcode = '22023', message = 'Upload contains an unknown data source.';
  end if;
  if batch_id is null or btrim(batch_id) = '' then
    raise exception using errcode = '22023', message = 'Upload must have a nonempty batch ID.';
  end if;

  -- Validate the entire file before any rows are inserted. Cast errors and
  -- foreign-key errors also abort the RPC transaction, including its receipt.
  for row_value in select value from jsonb_array_elements(upload_rows)
  loop
    if jsonb_typeof(row_value) <> 'object'
       or jsonb_typeof(row_value -> 'data_source') is distinct from 'string'
       or (row_value ->> 'data_source') is distinct from source_key
       or jsonb_typeof(row_value -> 'upload_batch_id') is distinct from 'string'
       or (row_value ->> 'upload_batch_id') is distinct from batch_id then
      raise exception using errcode = '22023', message = 'Every upload row must have the same data source and batch ID.';
    end if;

    if jsonb_typeof(row_value -> 'run_date') is distinct from 'string'
       or (row_value ->> 'run_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception using errcode = '22023', message = 'Every upload row must have a valid date in YYYY-MM-DD format.';
    end if;
    begin
      row_date := (row_value ->> 'run_date')::date;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'Upload contains an invalid calendar date.';
    end;
    if row_date < date '2000-01-01' or row_date > date '2100-12-31' then
      raise exception using errcode = '22023', message = 'Upload dates must be between 2000 and 2100.';
    end if;

    if (row_value -> 'vehicle_number' is not null
        and jsonb_typeof(row_value -> 'vehicle_number') not in ('string', 'null'))
       or (row_value -> 'raw_vehicle_id' is not null
        and jsonb_typeof(row_value -> 'raw_vehicle_id') not in ('string', 'null')) then
      raise exception using errcode = '22023', message = 'Vehicle identifiers must be text.';
    end if;
    vehicle_key := regexp_replace(upper(coalesce(
      nullif(btrim(row_value ->> 'vehicle_number'), ''),
      row_value ->> 'raw_vehicle_id', ''
    )), '[^A-Z0-9]', '', 'g');
    if vehicle_key = '' then
      raise exception using errcode = '22023', message = 'Every upload row must have a vehicle identifier containing letters or numbers.';
    end if;

    if jsonb_typeof(row_value -> 'total_distance') is distinct from 'number' then
      raise exception using errcode = '22023', message = 'Every upload row must have a finite, nonnegative numeric distance.';
    end if;
    if (row_value ->> 'total_distance')::numeric < 0 then
      raise exception using errcode = '22023', message = 'Distance cannot be negative.';
    end if;
    if row_value -> 'lookup_matched' is not null
       and jsonb_typeof(row_value -> 'lookup_matched') not in ('boolean', 'null') then
      raise exception using errcode = '22023', message = 'Vehicle match status must be true or false.';
    end if;
  end loop;

  -- Batch lock also serializes reuse of one ID across different sources.
  -- Source lock makes conflict checking and insert one indivisible operation
  -- across tabs/users; hash collisions only cause harmless extra waiting.
  perform pg_advisory_xact_lock(73042, hashtext(batch_id));
  perform pg_advisory_xact_lock(73041, hashtext(source_key));

  select r.upload_payload, r.inserted_count, r.skipped_count
    into saved_payload, saved_inserted, saved_skipped
  from iot_private.upload_receipts r
  where r.upload_batch_id = batch_id;
  if found then
    if saved_payload is distinct from upload_rows then
      raise exception using errcode = '23505', message = 'This upload batch ID was already used for different data. Choose the file again to start a new upload.';
    end if;
    return query select saved_inserted, saved_skipped;
    return;
  end if;

  if exists (select 1 from public.iot_data d where d.upload_batch_id = batch_id) then
    raise exception using errcode = '23505', message = 'This upload batch ID belongs to an older upload. Choose the file again to start a new upload.';
  end if;

  if source_key <> 'opspod_ev91' then
    select string_agg(existing.run_date::text, ', ' order by existing.run_date)
      into conflict_dates
    from (
      select distinct d.run_date
      from public.iot_data d
      where d.data_source = source_key
        and d.run_date in (
          select (value ->> 'run_date')::date from jsonb_array_elements(upload_rows)
        )
    ) existing;

    if conflict_dates is not null then
      source_label := case source_key
        when 'alt_mobility' then 'Alt Mobility'
        when 'vehicle_day_report' then 'Recent_Details (stridegreen)'
        when 'Recent_Details' then 'vehicle_day_report (Motvolt)'
      end;
      raise exception using errcode = '23505', message = format(
        '%s data already exists for date(s): %s. No rows were saved.', source_label, conflict_dates
      );
    end if;
  end if;

  with input as (
    select
      e.ordinality,
      coalesce(nullif(btrim(r.vehicle_number), ''), nullif(btrim(r.raw_vehicle_id), '')) as vehicle_number,
      r.run_date,
      r.total_distance,
      r.raw_vehicle_id,
      r.vehicle_master_id,
      coalesce(r.lookup_matched, false) as lookup_matched,
      r.lookup_match_type,
      regexp_replace(upper(coalesce(nullif(btrim(r.vehicle_number), ''), r.raw_vehicle_id, '')), '[^A-Z0-9]', '', 'g') as normalized_vehicle
    from jsonb_array_elements(upload_rows) with ordinality e(value, ordinality)
    cross join lateral jsonb_to_record(e.value) as r(
      vehicle_number text,
      run_date date,
      total_distance numeric,
      raw_vehicle_id text,
      vehicle_master_id bigint,
      lookup_matched boolean,
      lookup_match_type text
    )
  ), unique_input as (
    select distinct on (i.run_date, i.normalized_vehicle) i.*
    from input i
    order by i.run_date, i.normalized_vehicle, i.ordinality
  )
  insert into public.iot_data (
    vehicle_number, run_date, total_distance, data_source, raw_vehicle_id,
    vehicle_master_id, lookup_matched, lookup_match_type, upload_batch_id
  )
  select
    i.vehicle_number, i.run_date, i.total_distance, source_key, i.raw_vehicle_id,
    i.vehicle_master_id, i.lookup_matched, i.lookup_match_type, batch_id
  from unique_input i
  where not exists (
    select 1 from public.iot_data d
    where d.data_source = source_key
      and d.run_date = i.run_date
      and regexp_replace(upper(coalesce(nullif(btrim(d.vehicle_number), ''), d.raw_vehicle_id, '')), '[^A-Z0-9]', '', 'g') = i.normalized_vehicle
  );

  get diagnostics inserted = row_count;
  skipped := input_count - inserted;
  insert into iot_private.upload_receipts (
    upload_batch_id, data_source, upload_payload, inserted_count, skipped_count
  ) values (batch_id, source_key, upload_rows, inserted, skipped);

  return next;
end;
$$;

revoke all on function public.save_iot_upload(jsonb) from public;
grant execute on function public.save_iot_upload(jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
