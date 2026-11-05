# 0007: Local authentication, sessions and first-run setup

**Status:** Accepted

This implements the plan that [the protocol document](../protocol.md) sketched in Milestone 0. The operating
details are in [authentication](../authentication.md).

## First administrator: a token, and a database invariant

A fresh server may be reachable before its operator gets to it, so an open setup page would let the first
stranger claim it. Setup therefore requires a one-time token, which proves access to the server's configuration
or logs. It comes from `SETUP_TOKEN`, or is generated in memory and logged while setup is pending. Nothing is
seeded, and a generated token does not outlive its process.

A command-line tool was the alternative. It is simple, but it needs shell access on the machine holding the
database credentials, which a containerized deployment makes awkward, and it would have left the web app with
only a dead end to show. It remains an option for recovery.

Concurrency is settled by the database, in keeping with [0004](0004-schema-invariants.md). Migration `0002` adds
`system_bootstrap`, a table whose primary key a `CHECK` fixes to 1. Setup's transaction inserts that row first, so
concurrent attempts wait on it and then fail with a duplicate key, across any number of API instances. If the winner
rolls back, the next attempt can succeed. `GET_LOCK` would have needed no new table, but it would only be
advisory, and it would not stop setup reopening after the administrator is removed.

## Argon2id through `@node-rs/argon2`

Node.js 22 has no built-in Argon2. The `argon2` package runs an install script, and this repository only allows
scripts it has reviewed. `@node-rs/argon2` ships prebuilt binaries as optional dependencies, runs off the event
loop, and has no install script. Parameters are 64 MiB, 3 passes and parallelism 1 (RFC 9106's second
recommendation with one lane). A test pins the hash format.

Stored hashes carry their parameters, so they can be raised later. Nothing rehashes old passwords on sign-in yet.

## Sessions are rows, not signed tokens

Tokens are random, and each request looks one up. That is what makes revocation and disabling a user immediate,
which a self-contained signed token could not do. Only digests are stored. Because the token is already 256 random
bits, plain SHA-256 is the right digest: a slow hash protects guessable secrets and would only slow every request.

Expiry slides (7 days idle) under a fixed limit (30 days), computed in SQL so that only the database's clock
matters. `last_seen_at` is written at most once a minute per session.

## CSRF: origin checks and a derived token

The token is an HMAC of the session token. It needs no storage or server-wide secret, dies with the session, and
cannot be computed by a page that cannot read the `HttpOnly` cookie. The origin check also covers sign-in and
setup, which have no session to derive a token from. Login CSRF is a real attack here, because it would let an
attacker make someone administer the attacker's session.

`SameSite=Strict` works here, even though it stops a cookie on navigation from another site, because a single-page
app's own API requests are always same-site.

## Rate limiting in process

`@fastify/rate-limit` counts every request and has no notion of "give it back on success". What is needed is
small: about 80 lines with an injectable clock. Counters are per process, which is acceptable for a self-hosted
application that normally runs one instance. A deployment with several gets a proportionally higher limit. Moving
to shared counters later would touch only `RateLimiter`.

The limit per username is deliberately much higher than the one per address. Otherwise a stranger could lock out
the only administrator just by failing to sign in as them.

## Consequences

- There is no password recovery yet, short of editing the database.
- A generated setup token is logged. It is one-time, is only ever printed while no administrator exists, and stops
  working the moment one does. Anyone who considers that unacceptable can set `SETUP_TOKEN`.
