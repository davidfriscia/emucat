# Docker infrastructure

`compose.yaml` in the repository root defines the local MariaDB service. [`sftp-test`](sftp-test) is a real OpenSSH server for
tests only, built and removed by `pnpm test:sftp` and `pnpm test:e2e`. It uses the restricted account the
[repository guide](../../docs/repositories.md) recommends, with keys each test generates.

| Task                     | Command                  |
| ------------------------ | ------------------------ |
| Start MariaDB and wait   | `pnpm db:up`             |
| Stop (keeps data)        | `pnpm db:down`           |
| Stop and **delete data** | `pnpm db:reset`          |
| View logs                | `docker compose logs -f` |

The port is bound to `127.0.0.1` only, and passwords have no defaults: Compose refuses to start
until `.env` provides them.
