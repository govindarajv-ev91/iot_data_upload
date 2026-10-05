# IoT Data Upload

Upload daily vehicle distances from the four supported vendor formats, resolve vehicle identifiers against `vehicle_master`, and save the results in Supabase.

## Database update and deployment

For an existing installation, run **`sql/fix_upload_integrity.sql` in the Supabase SQL Editor before deploying this version**. The updated app requires its `save_iot_upload` function. It will show an update message if the migration has not been installed.

For a fresh installation, first ensure `public.vehicle_master` exists with the columns used by the vehicle lookup, then run these scripts in order:

1. `sql/create_iot_data_table.sql`
2. `sql/fix_upload_integrity.sql`
3. `sql/fix_dashboard_last_upload_timeout.sql`

These scripts can be run again. The integrity migration preserves existing IoT rows, including legacy duplicates. It adds a private upload receipt table, removes direct client mutation permissions, and permits uploads through the validated database function. Anonymous deletion is disabled. Public dashboard reads and the existing anonymous upload flow continue to work.

The upload function saves a whole file in one transaction. Failed inserts roll back the entire file. It serializes uploads for each source and compares normalized vehicle/date keys against all existing rows. Opspod permits additional files on the same date and skips duplicates. The other sources reject dates that already have saved data. Replaying an identical batch returns its original result; reusing that batch ID for different data is rejected.

The migration does not correct dates or incomplete records created by older versions. Review any known affected historical uploads in the SQL Editor before replacing their data.

Configure `public/config.json` using `public/config.example.json`, or provide `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the build environment. Use the public anonymous key for the browser app.

## Upload validation

Use the supplied templates. A vehicle identifier, valid date, and finite distance greater than or equal to zero are required. Completely blank rows are ignored. Any other invalid row rejects the whole file and reports its worksheet row number; valid rows are not saved separately.

ISO dates such as `2026-06-05` are recommended for CSV files. Ambiguous slash dates are interpreted as day/month/year. Native Excel dates retain their calendar date regardless of display formatting or browser timezone, including workbooks using the 1904 date system.

“Download all unmatched” retrieves every unmatched row up to the export's initial snapshot, rather than stopping at a single API page. An error on any page cancels the export instead of producing an incomplete CSV.

## Development and verification

```sh
npm ci
npm test
npm run build
npm run dev
```

`npm test` runs vehicle lookup, date parsing, file validation, timezone, upload-client, and export regression tests. These tests do not access the configured Supabase database.

Run `npm run test:sql` to verify the migration against a disposable local PostgreSQL database. It covers permissions, legacy data preservation, transaction rollback, retry behavior, normalized duplicates, concurrent uploads, and dashboard compatibility. PostgreSQL binaries (`initdb`, `pg_ctl`, and `psql`) must be on `PATH`, or their directory must be supplied in `POSTGRES_BIN`. The test creates its own temporary database bound to `127.0.0.1` and removes it afterward; it never uses the app's credentials or an existing database.
