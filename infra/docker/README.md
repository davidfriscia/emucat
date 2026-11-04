# Docker infrastructure

`compose.yaml` in the repository root defines the local MariaDB service. This directory is
reserved for future images (for example, production images for the API and web app).

| Task                     | Command                  |
| ------------------------ | ------------------------ |
| Start MariaDB and wait   | `pnpm db:up`             |
| Stop (keeps data)        | `pnpm db:down`           |
| Stop and **delete data** | `pnpm db:reset`          |
| View logs                | `docker compose logs -f` |

The port is bound to `127.0.0.1` only, and passwords have no defaults: Compose refuses to start
until `.env` provides them.
