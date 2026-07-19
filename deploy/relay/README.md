# Relay privacy proxy

This deployment starts a route-restricted Rehydra proxy on port `8787`. It
accepts OpenAI Chat Completions and Anthropic Messages requests, passes client
credentials through to the upstream relay configured in `.env`, and uses rule
matching to replace API keys found inside request text. It does not use an NER
model.

## Configure

Create the host-only `.env` beside `docker-compose.yml` with the encryption
key and the real upstream URL (the URL is deliberately kept out of git):

```bash
umask 077
{
  printf 'REHYDRA_KEY=%s\n' "$(openssl rand -base64 32)"
  printf 'REHYDRA_UPSTREAM=%s\n' "https://<your-relay>"
} > .env
chmod 600 .env
```

`REHYDRA_KEY` encrypts the in-memory PII map. `REHYDRA_UPSTREAM` is the
upstream base URL the proxy forwards to; it also accepts
`host=url[,host=url...]` to route by the request's Host header (`*` as host is
an explicit catch-all, unmatched hosts get 502). Do not put the upstream API
key in this file; client `Authorization` and `x-api-key` headers are passed
through.

## Operate

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 rehydra
curl -fsS http://127.0.0.1:8787/healthz
```

Stop the service with:

```bash
docker compose down
```

## Roll back

Check out the previously verified commit, rebuild the same pinned image tag,
and recreate the service:

```bash
docker compose build --no-cache
docker compose up -d --force-recreate
```
