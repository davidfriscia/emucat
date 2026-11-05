# Authentication and administrator setup

The reasoning behind these choices is in [decision 0007](decisions/0007-local-authentication.md).

## Setting up the first administrator

A fresh installation has no users and no default credentials. Nobody can sign in until someone creates the
first administrator, once, on purpose.

1. Start the API. While setup is pending, its log has a line like this, once per process:

   ```text
   First-run setup is pending. Open /setup in the web app and enter this one-time token: …
   ```

   To choose the token yourself, for instance when you cannot easily read the logs, set `SETUP_TOKEN` to at
   least 32 random characters. It is then not logged.

2. Open `/setup` in the web app. Signing in also takes you there while setup is pending.
3. Enter the token, a username (3 to 64 letters, digits, `.`, `_` or `-`), a display name and a password of at
   least 12 characters.

You are then signed in as the administrator, and setup closes for good: the token no longer does anything, and
`POST /setup` answers 409. This holds even if the administrator is later removed from the database.

The token matters because a new server may be reachable before its operator gets to it. Without one, the first
stranger to find `/setup` would own the installation.

### If you lose the password

There is no recovery flow yet. Someone with database access can compute a new Argon2id hash and update
`users.password_hash`. This is a [known limitation](../README.md#known-limitations).

## Sessions

- Signing in creates a random 256-bit token. The browser holds it in a cookie, and MariaDB holds only its
  SHA-256 digest in `user_sessions.token_hash`, so reading the table does not let anyone sign in.
- The cookie is `HttpOnly` and `SameSite=Strict`, on path `/`.
- With `COOKIE_SECURE` on, it is also `Secure` and named `__Host-emucat_session`. Otherwise it is
  `emucat_session`.
- A session is checked on every request. It ends when any of these happens:

| Event                       | Default                       | Setting                      |
| --------------------------- | ----------------------------- | ---------------------------- |
| Unused for too long         | 7 days                        | `SESSION_IDLE_TTL_HOURS`     |
| Too long since signing in   | 30 days, however active it is | `SESSION_ABSOLUTE_TTL_HOURS` |
| Signing out, or revoking it | Immediately                   |                              |
| Changing the password       | All other sessions            |                              |
| The user is disabled        | Immediately                   |                              |

## Passwords

Hashed with Argon2id (64 MiB of memory, 3 passes, parallelism 1), never logged, and never returned. A wrong
password, an unknown username and a disabled account get the same response after the same amount of work.

## CSRF

Two independent checks:

1. **Origin.** Every state-changing request, including sign-in and setup, is refused if `Origin` is not this
   site, or `Sec-Fetch-Site` says it came from elsewhere. Behind a proxy that rewrites `Host`, set
   `PUBLIC_ORIGIN`.
2. **Token.** On session routes, the `X-CSRF-Token` header must match a token derived from the session token.
   `GET /auth/session`, `GET /auth/me`, sign-in and setup return it. The web app keeps it in memory.

`SameSite=Strict` and JSON-only bodies are further layers underneath.

## Rate limiting

Attempts are counted when they start and given back when they succeed, so a parallel burst cannot get around
the limit.

| Attempt               | Limit, per 15 minutes           |
| --------------------- | ------------------------------- |
| Sign-in               | 20 per address, 50 per username |
| Setup                 | 10 per address                  |
| Changing the password | 10 per user                     |

Counters live in the API process, so several instances each count separately and a restart clears them. Behind
a reverse proxy, set `TRUST_PROXY` to the proxy's address, or every client appears to be the same address.

## Roles

The schema allows `admin` and `user`. This version only ever creates `admin`, and every administration route
requires it. There is no self-registration. A signed-in `user` could manage their own account but would get 403
from administration routes.

## Production checklist

- Serve over HTTPS, with a reverse proxy sending `/api` to the API and everything else to the web build, on one
  origin. The API has no CORS configuration, on purpose.
- Set `NODE_ENV=production`, which turns on `Secure` cookies. Leave `COOKIE_SECURE` unset.
- Set `TRUST_PROXY`. Set `PUBLIC_ORIGIN` if your proxy does not preserve `Host`.
- Complete setup right after the first start, so the token stops mattering.
