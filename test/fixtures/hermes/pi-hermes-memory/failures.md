Assumed SQLite was fine for local-only state; it wasn't, Postgres is the default. <!-- created=2026-08-10, last=2026-08-10 -->
§
Secrets come from the 1Password cache, never op read directly. Confirmed again after a near-miss grepping .env for a stray token. <!-- created=2026-08-11, last=2026-08-11 -->
