# Relay API-key Proxy Implementation Plan

**Goal:** Deploy one route-restricted Rehydra proxy that replaces API keys
found inside OpenAI Chat Completions and Anthropic Messages content, forwards
requests to Relay, and rehydrates returned content.

**Scope correction:** This deployment uses deterministic API-key rules only.
It does not use NER, ONNX, or natural-language PII recognition. Earlier NER
experiments were reverted before deployment.

## Fixed architecture

```text
Pi / Claude Code
  -> rehydra-test.99.suyiiyii.top:443
  -> Caddy on 99.suyiiyii.top
  -> FRP remote port 37696
  -> 10.21.22.21:8787
  -> Rehydra
  -> https://upstream.example
```

- Supported routes: `GET /healthz`, `GET /v1/models`,
  `POST /v1/chat/completions`, and `POST /v1/messages`.
- Client `Authorization` and `x-api-key` headers pass through unchanged.
- Only API keys inside provider-defined body text are replaced.
- OpenAI Responses is not supported.
- No Relay key is stored by the service.
- Raw request bodies, credentials, replacement values, and mappings are never
  logged.

## Task 1: Route-aware proxy — completed

- Detect OpenAI and Anthropic formats from exact request paths.
- Add provider `auto`, configurable bind host, health endpoint, and route
  allowlist.
- Reject unsupported routes locally.

Verification: provider, CLI, and proxy-server tests plus TypeScript build.

## Task 2: Transport correctness — completed

- Remove stale response framing and compression headers after body changes.
- Cancel the upstream request when the downstream client disconnects.

Verification: buffered/SSE framing and cancellation tests plus build.

## Task 3: API-key-only policy

- Make an explicit `--types API_KEY --secrets` policy enable only `API_KEY`,
  rather than implicitly adding every secret category.
- Test the exact enabled and regex-enabled type sets.
- Run with `--ner disabled`; retain no NER deployment dependency.

Verification:

```bash
npm run test:run -- test/cli/commands/proxy.test.ts
npm run build
```

## Task 4: Container

- Build from `node:22-bookworm-slim` and run as a non-root user.
- Omit development and optional dependencies from the runtime image so ONNX is
  not present.
- Start the exact command:

```text
node dist/cli/bin.js proxy auto --upstream https://upstream.example --host 0.0.0.0 --port 8787 --ner disabled --types API_KEY --secrets --quiet
```

- Compose publishes `8787:8787`, reads only `REHYDRA_KEY` from the host `.env`,
  and health-checks `/healthz`.

Verification:

```bash
npm ci
npm run lint
npm run test:run
npm run build
docker build -t rehydra-relay:0.11.0-hardened .
docker run --rm rehydra-relay:0.11.0-hardened node dist/cli/bin.js --version
```

## Task 5: Backend deployment

- Push `codex/harden-relay-proxy`.
- On `10.21.22.21`, resolve and check out the exact verified commit.
- Generate a host-only `REHYDRA_KEY`, mode `0600`; never print it.
- Build and start Compose.
- Verify container health, `/healthz` HTTP 200, `/v1/responses` HTTP 404,
  non-root runtime, and absence of ONNX runtime.

## Task 6: FRP and Caddy publication

- Recheck that remote port `37696` is unused.
- Back up and append the OpenWrt FRP entry targeting `10.21.22.21:8787`.
- Immediately before restarting shared frpc, request owner confirmation for
  the approximately five-second interruption to all tunnels.
- Verify the new and existing critical FRP listeners.
- Back up, validate, append, and reload the Caddy site for
  `rehydra-test.99.suyiiyii.top`.
- Update both verified port-allocation references.

## Task 7: Real acceptance

- Verify TLS, `/healthz`, authenticated `/v1/models`, and `grok-4.5`.
- Test OpenAI and Anthropic buffered/SSE paths with a synthetic API key inside
  message content.
- Confirm the upstream-facing content contains a replacement tag while the
  client-facing assembled response contains the original synthetic value.
- Confirm authentication headers pass through and never appear in logs.
- Run the full local suite again and record exact commit/image identifiers and
  rollback locations.
