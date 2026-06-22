-- Track which CSV upload each row came from (one batch id per file upload).
alter table public.iot_data
  add column if not exists upload_batch_id text;

create index if not exists iot_data_upload_batch_id_idx on public.iot_data (upload_batch_id);
