# Relay Privacy Proxy Design

## Goal

Deploy one hardened Rehydra instance that accepts both OpenAI Chat Completions
and Anthropic Messages requests, anonymizes sensitive content, forwards the
requests to `https://upstream.example/v1`, and rehydrates buffered and streamed
responses before returning them to clients.

The public endpoint will be:

```text
https://rehydra-test.99.suyiiyii.top
```

This is an isolated test service. Existing Sub2API, LiteLLM, and other FRP
services are outside the implementation scope.

## Architecture

```text
Pi / Claude Code
  -> Caddy on 99.suyiiyii.top:443
  -> 127.0.0.1:37696
  -> FRP tunnel
  -> 10.21.22.21:8787
  -> Rehydra proxy
  -> https://upstream.example/v1
```

- Caddy terminates TLS and proxies HTTP without inspecting request bodies.
- FRP exposes only the fixed Rehydra listener.
- Rehydra uses one process and automatically selects the OpenAI or Anthropic
  body codec from the request path and headers.
- Client `Authorization` and `x-api-key` headers pass through unchanged.
- The service does not store or inject a Relay API key.
- PII mappings use in-memory storage and disappear when the process restarts.

## Supported Surface

The first deployment supports only:

- `GET /healthz`: local process and readiness status; never forwarded.
- `GET /v1/models`: direct upstream pass-through.
- `POST /v1/chat/completions`: OpenAI buffered and SSE responses.
- `POST /v1/messages`: Anthropic buffered and SSE responses.

Unsupported `/v1/*` routes return an explicit error instead of silently
forwarding an uninspected protocol. OpenAI Responses is not supported in this
iteration.

## Proxy Behaviour

### Request handling

1. Validate the route, method, and JSON content type.
2. Select the provider from the route, with headers used only as corroborating
   evidence.
3. Detect and anonymize configured PII and secrets in provider-defined text
   fields, tool results, and system instructions.
4. Forward the rebuilt body and allowlisted headers to Relay.
5. Never log raw request bodies, API keys, PII values, or mappings.

Provider detection must not depend on the Relay hostname because both
protocols share the same upstream domain.

### Response handling

- Buffered JSON responses are parsed according to the selected provider and
  rehydrated, including tool-call arguments.
- SSE responses are parsed incrementally. Rehydration must tolerate a PII tag
  split across arbitrary upstream chunks.
- Modified responses remove stale `Content-Length`, `Content-Encoding`, and
  hop-by-hop framing headers.
- Client disconnects cancel the upstream request.
- Upstream status codes and safe response bodies pass through unchanged.

### Failure behaviour

- Invalid client JSON returns `400` without calling Relay.
- Anonymizer or required NER initialization failure keeps readiness false and
  prevents LLM requests from reaching Relay.
- Unsupported routes return `404` or `405` explicitly.
- Upstream network failure returns a structured `502`.
- Detection errors fail closed; there is no regex-only fallback when NER is
  configured as required.

## NER and Secret Detection

- Existing deterministic recognizers remain enabled for email, IP addresses,
  credentials, API keys, private keys, JWTs, and related structured secrets.
- `--secrets` is enabled in deployment.
- Quantized NER is required for person, organization, and location detection.
- Inputs exceeding one model window are processed in overlapping chunks. No
  suffix may be silently discarded.
- Duplicate entities in chunk overlaps are merged deterministically.

## Operational Configuration

- Rehydra listens on `0.0.0.0:8787` inside the backend host/container.
- Docker Compose pins the built image and uses restart policy
  `unless-stopped`.
- The encryption key is supplied through a host-only environment file and is
  never committed.
- No Relay key is stored server-side.
- Health checks call `/healthz` locally.
- Logs contain request ID, protocol, route, status, latency, and anonymized
  entity counts only.

FRP uses remote port `37696`, subject to a final live conflict check. Caddy
publishes `rehydra-test.99.suyiiyii.top` without Basic Auth because supported
clients already authenticate to Relay and Basic Auth would conflict with
their API authentication model.

## Verification

Automated tests cover:

- route-based OpenAI/Anthropic provider selection;
- client API-key pass-through without log exposure;
- stale response framing header removal;
- long-input NER chunking and overlap merging;
- fail-closed initialization and detection errors;
- buffered response and tool-argument rehydration;
- OpenAI and Anthropic SSE rehydration when tags split across chunks;
- `/healthz`, `/v1/models`, unsupported routes, and client cancellation.

Deployment acceptance uses the real Relay `grok-4.5` model and verifies:

1. OpenAI buffered response.
2. OpenAI SSE with actual incremental delivery.
3. Anthropic buffered response.
4. Anthropic SSE with actual incremental delivery.
5. Request anonymization and response rehydration using synthetic PII.
6. `Authorization` and `x-api-key` pass-through.
7. `/v1/models` pass-through.
8. Internal port, FRP port, Caddy TLS, and public endpoint health.

## Deployment and Rollback

Deployment order is backend, FRP, then Caddy. Every shared configuration is
backed up and validated before reload or restart.

Rollback is performed in reverse order:

1. Remove or disable the Caddy site and reload validated configuration.
2. Restore the backed-up OpenWrt FRP configuration and restart frpc.
3. Stop the Rehydra Compose project on `10.21.22.21`.

No existing service configuration or port allocation is repurposed.
