# Lingo

A self-hosted, always-connected IRC client for the browser. The Bun server stays connected to your networks and keeps searchable history in SQLite; the React app follows along from any device, with Web Push for highlights when no browser is open.

## Requirements

- [Bun](https://bun.sh) 1.2 or newer, or Docker.
- For anything beyond localhost: a TLS reverse proxy (Caddy, nginx, …). Lingo serves plain HTTP.

## Run with Docker (recommended)

```sh
cp .env.example .env          # optional: edit settings
docker compose up -d --build
docker compose logs lingo     # shows the one-time setup URL
```

The log prints `Lingo setup: open http://0.0.0.0:3000/?setup=<token>`. Open that path on the address you reach Lingo at (e.g. `http://127.0.0.1:3000/?setup=<token>`) and create the admin account. The token lives only in memory: a restart before setup prints a new one. When `LINGO_PUBLIC_ORIGIN` is set, the printed URL already uses it.

`compose.yaml` publishes the port on `127.0.0.1:3000` only, stores the database in the `lingo-data` volume at `/data/lingo.sqlite`, and restarts the container unless stopped. The image runs as the unprivileged `bun` user and has a health check on `GET /api/health`.

Without compose:

```sh
docker build -t lingo .
docker run -d --name lingo --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v lingo-data:/data \
  -e LINGO_PUBLIC_ORIGIN=https://irc.example.com \
  -e LINGO_TRUST_PROXY=1 \
  lingo
```

Upgrade with `git pull && docker compose up -d --build`. Migrations run on startup and keep existing history.

## Run with Bun

```sh
bun install --frozen-lockfile
bun run build                 # builds dist/ and type-checks
bun run start                 # serves the app and API on 127.0.0.1:3000
```

The database defaults to `local/lingo.sqlite`; set `LINGO_DB_PATH` to keep it elsewhere. Lingo stops cleanly on `SIGINT`/`SIGTERM`, so it runs under systemd as a plain `ExecStart=/usr/local/bin/bun src/server/index.ts` with `WorkingDirectory` set to the checkout and `Restart=on-failure`.

Development: `bun run dev` runs the server in watch mode with Vite on `http://127.0.0.1:5173`, proxying `/api` to the server. `bun test` runs the test suite.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example). Bun reads `.env` from the working directory. Invalid values stop startup with an error naming the variable.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LINGO_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address |
| `LINGO_PORT` | `3000` | HTTP port |
| `LINGO_DB_PATH` | `local/lingo.sqlite` (`/data/lingo.sqlite` in Docker) | SQLite database |
| `LINGO_PUBLIC_ORIGIN` | unset | Exact HTTPS origin, e.g. `https://irc.example.com` |
| `LINGO_TRUST_PROXY` | unset | `1` to take the client IP from the right-most `X-Forwarded-For` entry |
| `LINGO_HISTORY_RETENTION_DAYS` | unset (forever) | Global history retention, 1–3650 |
| `LINGO_TEACUP_URL`, `LINGO_TEACUP_USERNAME`, `LINGO_TEACUP_PASSWORD` | unset | Enable file uploads through a teacup instance |
| `LINGO_TEACUP_PUBLIC_URL` | `LINGO_TEACUP_URL` | Base of upload links posted to IRC |
| `LINGO_UPLOAD_MAX_MB` | `25` | Per-file upload limit, 1–500 |

Inside Docker, `127.0.0.1` is the container itself: point `LINGO_TEACUP_URL` at a service name on a shared network or at `host.docker.internal`.

## Behind a reverse proxy

Set `LINGO_PUBLIC_ORIGIN` to the HTTPS origin users open. Without it, the browser's `https://` origin will not match the proxied `http://` request and every change is rejected with 403, cookies lose the `Secure` flag, and Web Push is unavailable. Set `LINGO_TRUST_PROXY=1` only when the proxy is the only way to reach Lingo, so clients cannot forge `X-Forwarded-For`.

The proxy must pass WebSocket upgrades on `/api/events`, keep the `Host` header, and allow request bodies up to the upload limit plus 1 MiB if uploads are on.

Caddy:

```caddy
irc.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name irc.example.com;
    # ssl_certificate …; ssl_certificate_key …;
    client_max_body_size 26m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
        proxy_read_timeout 1h;
    }
}
```

## Backups

Everything (accounts, networks, history, the Web Push key pair) is in the one SQLite database, which runs in WAL mode. Copy it with SQLite's online backup rather than copying the file while Lingo runs:

```sh
sqlite3 /path/to/lingo.sqlite ".backup '/backups/lingo-$(date +%F).sqlite'"
# Docker: the image has no sqlite3, so back up the volume from a throwaway container
docker run --rm -v lingo_lingo-data:/data -v "$PWD":/backup alpine \
  sh -c 'apk add -q sqlite && sqlite3 /data/lingo.sqlite ".backup /backup/lingo.sqlite"'
```

Keep backups private: the database holds IRC and SASL passwords and full history.
