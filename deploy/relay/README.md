# Relay privacy proxy

This deployment starts a route-restricted Rehydra proxy on port `8787`. It
accepts OpenAI Chat Completions and Anthropic Messages requests, passes client
credentials through to `https://upstream.example`, and uses rule matching to
replace API keys found inside request text. It does not use an NER model.

## Configure

Create the host-only encryption key beside `docker-compose.yml`:

```bash
umask 077
printf 'REHYDRA_KEY=%s\n' "$(openssl rand -base64 32)" > .env
chmod 600 .env
```

`REHYDRA_KEY` encrypts the in-memory PII map. Do not put the Relay API key
in this file; client `Authorization` and `x-api-key` headers are passed through.

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
