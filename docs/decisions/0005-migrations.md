# 0005: A small, forward-only migration runner

**Status:** Accepted

Migrations are plain SQL files in `apps/api/migrations`, applied in order by about 150 lines of
TypeScript (`src/db/migrate.ts`). The needs are small and the behavior is easy to test, so a framework
would add more than it gives.

- **Explicit.** `pnpm db:migrate` applies them. The API never migrates on startup, so that deploying
  several instances cannot race, and readiness reports `not_ready` until the schema is current.
- **Forward-only.** There are no down migrations. Applied files must not change, which is enforced by
  checksums. Line endings are normalized first, so checkout settings cannot cause false alarms.
- **Serialized.** `GET_LOCK` makes concurrent runs wait.
- **Failure is visible.** MariaDB cannot roll back DDL, so a failed migration may leave a partial change.
  The runner records a migration before running it and marks it finished afterwards. An unfinished record
  stops further runs until someone restores a backup or resets the database.
- **Multiple statements** are enabled only on the runner's own connection, never on the API's pool, where
  they would make any SQL injection far worse.
