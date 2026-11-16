-- filename: app/migrations/0021_job_lease.sql
-- Each claim gives a job a fresh lease. The processor sends it back with
-- every request, so a machine whose job was handed to another (it slept past
-- the stale-job sweep) cannot save over the new owner's results.
ALTER TABLE jobs ADD COLUMN lease_id TEXT;
