# RoutineHub Proxy

Small Express proxy for RoutineHub API requests, packaged for Railway.

## Deploy on Railway

1. Push this `rh-proxy` repository to GitHub.
2. Create a Railway service from that GitHub repo.
3. Generate a public domain under the service networking settings.

Railway will use the included `Dockerfile` and `railway.toml`. The app listens on Railway's injected `PORT` and exposes `/health` for deploy health checks.

## Runtime settings

These environment variables are optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROUTINEHUB_API_BASE` | `https://routinehub.co/api/v1/` | Upstream API base URL. |
| `CACHE_TTL_MS` | `30000` | In-memory cache TTL. Set `0` to disable. |
| `MAX_CACHE_ENTRIES` | `100` | Max cached proxy responses. |
| `MAX_BROWSER_PAGES` | `2` | Limits concurrent Chromium pages to keep memory stable. |
| `REQUEST_TIMEOUT_MS` | `30000` | Upstream/browser request timeout. |
| `RATE_LIMIT_MAX` | `60` | Requests per minute per IP. |
| `DIRECT_FETCH_FIRST` | `true` | Try a cheap HTTP fetch before launching Chromium. Set `false` to always use Chromium. |
| `OUTBOUND_PROXY_URL` | unset | Optional HTTP/SOCKS proxy used for requests to RoutineHub. Useful when a host ASN is blocked by RoutineHub/Cloudflare. |

## RoutineHub Cloudflare blocks

If `/health` works but proxy routes show Cloudflare error `1005`, Railway is reachable but RoutineHub is blocking Railway's outbound ASN/IP. The app cannot fix that from the same Railway egress IP. Use one of these options:

- Set `OUTBOUND_PROXY_URL` to a non-blocked proxy URL, for example `http://user:pass@host:port`.
- Deploy on a provider/IP that RoutineHub does not block.
- Ask RoutineHub to whitelist the deployment ASN/IP.

## Local checks

```sh
npm install
npm run check
npm start
```

The local server defaults to `http://localhost:3000`.

The Docker/Railway image includes Chromium. For full proxy testing with plain `npm start` outside Docker, set `PUPPETEER_EXECUTABLE_PATH` to a local Chrome or Chromium executable.

```sh
docker build -t routinehub-proxy .
docker run --rm -p 3000:3000 routinehub-proxy
```
