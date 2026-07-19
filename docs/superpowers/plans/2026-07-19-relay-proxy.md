# Relay Privacy Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, deploy, and verify one hardened Rehydra proxy for OpenAI Chat Completions and Anthropic Messages traffic sent to Relay.

**Architecture:** Extend the existing Rehydra CLI with a route-aware `auto` provider, a configurable bind host, fail-closed required NER startup, and a local health endpoint. Keep the existing anonymizer and provider codecs, repair response framing and long-input NER, then deploy the pinned container through FRP and Caddy.

**Tech Stack:** TypeScript 5, Node.js 22, Vitest, ONNX Runtime, Docker Compose, OpenWrt FRP, Caddy 2.11.

## Global Constraints

- Public endpoint: `https://rehydra-test.99.suyiiyii.top`.
- Backend listener: `10.21.22.21:8787`; FRP remote port: `37696`, after a final live conflict check.
- Upstream: `https://upstream.example`; clients retain the `/v1` API path.
- Support only `GET /healthz`, `GET /v1/models`, `POST /v1/chat/completions`, and `POST /v1/messages`.
- Do not implement OpenAI Responses compatibility.
- Pass client `Authorization` and `x-api-key` headers through; never store a Relay API key.
- Use in-memory PII mappings, required quantized NER, and secret recognizers.
- Never log raw bodies, credentials, PII values, or mappings.
- Fail closed when required NER initialization or detection fails.
- Test-first for every code behavior; observe each new test fail before implementation.
- Back up, validate, restart/reload, and verify every shared FRP or Caddy change.

---

### Task 1: Route-aware auto proxy and health endpoint

**Files:**
- Modify: `src/proxy/providers/openai.ts`
- Modify: `src/proxy/providers/anthropic.ts`
- Modify: `src/proxy/rehydra-proxy.ts`
- Modify: `src/proxy/proxy-server.ts`
- Modify: `src/proxy/types.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/cli/commands/proxy.ts`
- Test: `test/proxy/providers/openai.test.ts`
- Test: `test/proxy/providers/anthropic.test.ts`
- Test: `test/proxy/proxy-server.test.ts`
- Test: `test/cli/commands/proxy.test.ts`

**Interfaces:**
- Produces: CLI `rehydra proxy auto --upstream <url> --host <host>`.
- Produces: `RehydraProxyServerConfig.isReady?: () => boolean`.
- Produces: local `GET /healthz` JSON with HTTP 200 when ready and 503 otherwise.
- Produces: an explicit route allowlist for the four supported method/path pairs.

- [ ] **Step 1: Write provider route-detection tests**

Add assertions that `OpenAIProvider.matchesRequest()` matches
`/v1/chat/completions` on a non-OpenAI host and that
`AnthropicProvider.matchesRequest()` matches `/v1/messages` even when both
authentication header families are present. Also assert that neither provider
claims the other provider's route.

```ts
expect(openai.matchesRequest(
  "https://upstream.example/v1/chat/completions",
  new Headers({ authorization: "Bearer test-token" }),
)).toBe(true);
expect(anthropic.matchesRequest(
  "https://upstream.example/v1/messages",
  new Headers({ authorization: "Bearer test-token", "x-api-key": "test-key" }),
)).toBe(true);
```

- [ ] **Step 2: Run provider tests and verify RED**

Run:

```bash
npm test -- --run test/proxy/providers/openai.test.ts test/proxy/providers/anthropic.test.ts
```

Expected: route tests fail because matching currently depends on provider hosts
or credential shapes.

- [ ] **Step 3: Implement route-first provider matching**

Parse the URL and match exact paths before credential heuristics:

```ts
const pathname = new URL(url).pathname;
if (pathname === "/v1/chat/completions") return true;
```

Use `/v1/messages` for Anthropic. Retain existing official-host and header
matching for library callers.

- [ ] **Step 4: Add CLI and server behaviour tests**

Test all of the following:

- `auto` is accepted only when `--upstream` is present.
- `--host 0.0.0.0` is passed to `server.listen()`.
- auto mode passes `provider: "auto"` to `createRehydraProxy()`.
- `/healthz` never invokes the proxy handler.
- readiness false returns 503; readiness true returns 200.
- unsupported `/v1/responses` returns 404 without upstream access.
- wrong methods on supported routes return 405.
- `GET /v1/models` and the two supported POST routes reach the handler.

- [ ] **Step 5: Run CLI/server tests and verify RED**

Run:

```bash
npm test -- --run test/cli/commands/proxy.test.ts test/proxy/proxy-server.test.ts
```

Expected: tests fail because `auto`, `--host`, readiness, health, and route
guarding do not exist.

- [ ] **Step 6: Implement minimal CLI/server support**

Extend `ParsedOptions` and `parseArgs()` with `host` and `require-ner`. Add
`auto` to the provider canonical map without a default upstream; throw this
exact error when it is absent:

```text
Provider auto requires --upstream
```

Centralize request admission in `proxy-server.ts`:

```ts
export function classifyProxyRoute(method: string, pathname: string):
  | "health"
  | "proxy"
  | "not-found"
  | "method-not-allowed";
```

Use exact method/path pairs from Global Constraints. Return JSON errors locally
for rejected routes. Keep `incomingMessageToRequest()` and `writeResponse()` as
the transport adapters used by both the exported server and CLI.

- [ ] **Step 7: Verify Task 1 and commit**

Run:

```bash
npm test -- --run test/proxy/providers/openai.test.ts test/proxy/providers/anthropic.test.ts test/proxy/proxy-server.test.ts test/cli/commands/proxy.test.ts
npm run build
```

Expected: all selected tests pass and TypeScript exits 0.

Commit:

```bash
git add src/proxy src/cli test/proxy test/cli/commands/proxy.test.ts
git commit -m "feat: add route-aware auto proxy"
```

---

### Task 2: Correct response framing and cancellation

**Files:**
- Modify: `src/proxy/rehydra-fetch.ts`
- Modify: `src/proxy/proxy-server.ts`
- Test: `test/proxy/rehydra-fetch.test.ts`
- Test: `test/proxy/proxy-server.test.ts`

**Interfaces:**
- Produces: `sanitizeModifiedResponseHeaders(headers: Headers): Headers`.
- Produces: `incomingMessageToRequest(..., signal?: AbortSignal): Request`.

- [ ] **Step 1: Write stale-header regression tests**

Create mock buffered responses containing `Content-Length`, `Content-Encoding`,
`Transfer-Encoding`, and `Connection`. After rehydration, assert all four are
absent while `Content-Type` and safe provider headers remain.

- [ ] **Step 2: Run the framing test and verify RED**

Run:

```bash
npm test -- --run test/proxy/rehydra-fetch.test.ts -t "removes stale framing headers"
```

Expected: at least `content-length` remains on the rebuilt JSON response.

- [ ] **Step 3: Implement one response-header sanitizer**

Export one internal sanitizer and use it for every modified buffered, invalid
JSON, tool-loop, and SSE response:

```ts
const STRIP_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
```

- [ ] **Step 4: Write cancellation tests**

Create an upstream mock that waits for its request signal to abort. Close the
downstream response before completion and assert the signal used by upstream
fetch becomes aborted.

- [ ] **Step 5: Run cancellation test and verify RED**

Run:

```bash
npm test -- --run test/proxy/proxy-server.test.ts -t "cancels upstream"
```

Expected: timeout/failure because the incoming request currently has no abort
controller connected to the downstream response.

- [ ] **Step 6: Connect downstream closure to upstream cancellation**

Create one `AbortController` per incoming request, pass its signal to the Web
Request, abort on `req.aborted` and premature `res.close`, and remove listeners
after the response finishes. Do not treat a normal completed response as an
error.

- [ ] **Step 7: Verify Task 2 and commit**

Run:

```bash
npm test -- --run test/proxy/rehydra-fetch.test.ts test/proxy/proxy-server.test.ts
npm run build
```

Commit:

```bash
git add src/proxy test/proxy
git commit -m "fix: sanitize proxy framing and cancellation"
```

---

### Task 3: Process long NER inputs without truncation

**Files:**
- Modify: `src/ner/ner-model.ts`
- Test: `test/ner/ner-model.test.ts`

**Interfaces:**
- Produces: `createNERTextWindows(text: string, maxLength: number, overlap?: number): NERTextWindow[]`.
- Produces: `NERTextWindow { text: string; start: number; end: number }`.

- [ ] **Step 1: Write pure windowing tests**

Cover empty/short strings, a string longer than two windows, overlap, complete
source coverage, monotonic offsets, and a boundary adjacent to a UTF-16
surrogate pair. For `maxLength = 10` and `overlap = 2`, assert every window is
at most eight source characters plus overlap and concatenated coverage reaches
the final character.

- [ ] **Step 2: Run windowing tests and verify RED**

Run:

```bash
npm test -- --run test/ner/ner-model.test.ts -t "NER text windows"
```

Expected: import/function-not-found failure.

- [ ] **Step 3: Implement safe overlapping windows**

Reserve two model tokens for CLS/SEP, use a maximum source window size of
`maxLength - 2`, default overlap `min(64, floor(windowSize / 4))`, guarantee
forward progress, and move boundaries by one UTF-16 code unit when they would
split a surrogate pair.

- [ ] **Step 4: Write prediction aggregation tests**

Use a test subclass/injected pass runner to return known spans in separate
windows. Assert spans after the first window receive absolute offsets and that
same-type overlapping duplicates are reduced to one span, preferring higher
confidence and then the longer span.

- [ ] **Step 5: Run aggregation test and verify RED**

Run:

```bash
npm test -- --run test/ner/ner-model.test.ts -t "aggregates window predictions"
```

Expected: only the first truncated tokenizer window is represented.

- [ ] **Step 6: Run NER per window and merge results**

Make `predict()` call `runNERPass()` for every window, shift each span by
`window.start`, run case fallback per window, and merge duplicate overlapping
spans before existing boundary cleanup. Do not catch inference errors; they
must propagate to the proxy and prevent upstream forwarding.

- [ ] **Step 7: Verify Task 3 and commit**

Run:

```bash
npm test -- --run test/ner/ner-model.test.ts test/ner/tokenizer.test.ts test/ner/bio-decoder.test.ts
npm run build
```

Commit:

```bash
git add src/ner/ner-model.ts test/ner/ner-model.test.ts
git commit -m "fix: process long NER inputs in windows"
```

---

### Task 4: Fail closed when required NER is unavailable

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `src/cli/commands/proxy.ts`
- Test: `test/cli/commands/proxy.test.ts`

**Interfaces:**
- Consumes: route health/readiness support from Task 1.
- Produces: CLI flag `--require-ner` and readiness transition only after the NER handler initializes.

- [ ] **Step 1: Write required-NER tests**

Mock model loading success and failure. With `--require-ner`, assert the proxy
handler returns 503 until NER is ready, becomes ready after successful loading,
and remains unavailable after failure. Without the flag, preserve the existing
regex-first optional fallback for general CLI users.

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
npm test -- --run test/cli/commands/proxy.test.ts -t "required NER"
```

Expected: option/readiness assertions fail.

- [ ] **Step 3: Implement required-NER state**

Represent state explicitly:

```ts
type ProxyReadiness =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "failed"; message: string };
```

Do not swallow the initialization error. Log only its safe error message, keep
health at 503, and reject supported LLM routes locally without invoking the
regex-only handler.

- [ ] **Step 4: Verify Task 4 and commit**

Run:

```bash
npm test -- --run test/cli/commands/proxy.test.ts
npm run build
```

Commit:

```bash
git add src/cli test/cli/commands/proxy.test.ts
git commit -m "feat: add fail-closed NER readiness"
```

---

### Task 5: Containerize and run the complete local test suite

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `deploy/relay/docker-compose.yml`
- Create: `deploy/relay/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: CLI flags from Tasks 1 and 4.
- Produces: local image `rehydra-relay:0.11.0-hardened` exposing port 8787.

- [ ] **Step 1: Add a multi-stage Docker build**

Use `node:22-bookworm-slim`, run `npm ci`, `npm run build`, retain the optional
`onnxruntime-node` runtime dependency, create a non-root user, and start:

```text
node packages/cli/bin.js proxy auto --upstream https://upstream.example --host 0.0.0.0 --port 8787 --ner quantized --require-ner --secrets --quiet
```

The Compose file maps `8787:8787`, sets `REHYDRA_KEY` from an uncommitted host
environment file, uses `restart: unless-stopped`, and health-checks
`http://127.0.0.1:8787/healthz`.

- [ ] **Step 2: Document only deployment-critical operations**

Document key generation, `.env` permissions, build/start/stop, health, logs,
and rollback. Do not document or embed a Relay key.

- [ ] **Step 3: Run complete verification**

Run:

```bash
npm ci
npm run lint
npm run test:run
npm run build
docker build -t rehydra-relay:0.11.0-hardened .
docker run --rm rehydra-relay:0.11.0-hardened node packages/cli/bin.js --version
```

Expected: lint/build exit 0, all tests pass, and container prints Rehydra
version 0.11.0.

- [ ] **Step 4: Commit container support**

```bash
git add Dockerfile .dockerignore deploy README.md
git commit -m "build: add Relay proxy container"
```

---

### Task 6: Deploy backend and verify the private listener

**Files/State:**
- Remote create: `10.21.22.21:/home/suyiiyii/services/rehydra-test/`
- Remote create: `.env` with mode 0600.
- Remote Docker Compose project: `rehydra-test`.

**Interfaces:**
- Produces: healthy `http://10.21.22.21:8787/healthz`.

- [ ] **Step 1: Push the implementation branch**

Run:

```bash
git push -u origin codex/harden-relay-proxy
```

- [ ] **Step 2: Resolve the exact commit on the backend**

Clone or fetch the fork into the service directory and check out the exact
verified commit SHA, not a moving branch. Confirm the worktree is clean.

- [ ] **Step 3: Generate host-only key and start Compose**

Generate a 32-byte base64 key on the backend, write only
`REHYDRA_KEY=<value>` to `.env`, chmod 0600, build the pinned image, and start
the Compose project. Do not print the generated value.

- [ ] **Step 4: Verify readiness and isolation**

Run on the backend:

```bash
docker compose ps
curl -fsS http://127.0.0.1:8787/healthz
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/v1/responses
```

Expected: container healthy, health HTTP 200, unsupported route HTTP 404.
Verify logs contain no request bodies or credentials.

---

### Task 7: Publish through FRP and Caddy

**Files/State:**
- Remote modify: `10.21.22.11:/etc/config/frp`
- Remote modify: `99.suyiiyii.top:/etc/caddy/Caddyfile`
- Modify after live verification: `/Users/suyiiyii/ops/.agents/skills/frp-management/references/port-allocation.md`
- Modify after live verification: `/Users/suyiiyii/ops/.agents/skills/service-expose/references/port-allocation.md`

**Interfaces:**
- Consumes: backend listener from Task 6.
- Produces: public HTTPS endpoint.

- [ ] **Step 1: Perform final live port conflict check**

Confirm `37696` is absent from OpenWrt FRP config and cloud listeners. Stop if
either side already uses it.

- [ ] **Step 2: Back up and validate the proposed FRP configuration**

Create `/etc/config/frp.backup.<timestamp>`, append exactly one enabled TCP
proxy targeting `10.21.22.21:8787`, with encryption and compression enabled,
remark `rehydra-test`, and confirm `uci show frp` succeeds with no duplicate
remote ports.

- [ ] **Step 3: Obtain the required shared-frpc restart confirmation**

Report that restarting frpc affects every existing FRP tunnel for about five
seconds. Do not restart until the owner confirms the interruption window.

- [ ] **Step 4: Restart frpc and verify critical tunnels**

Restart frpc, verify cloud port 37696, curl its `/healthz`, then verify existing
critical ports 37688, 37689, 37690, 37691, and 37692 are listening again.

- [ ] **Step 5: Back up, append, and validate Caddy**

Append:

```caddy
rehydra-test.99.suyiiyii.top {
    tls dujiakai@foxmail.com
    reverse_proxy 127.0.0.1:37696 {
        flush_interval -1
        header_up X-Caddy-Real-IP {remote_host}
    }
}
```

Run `caddy validate --config /etc/caddy/Caddyfile`; reload only after validation
passes. Confirm Caddy remains active and other named sites still respond.

- [ ] **Step 6: Update both port allocation references**

Record remote port 37696, service `Rehydra Test`, target
`10.21.22.21:8787`, domain `rehydra-test.99.suyiiyii.top`, and verified status
in both repository-local reference tables.

---

### Task 8: Real Relay acceptance and delivery

**Files/State:**
- Public endpoint: `https://rehydra-test.99.suyiiyii.top`.
- No committed credentials or synthetic-PII artifacts.

**Interfaces:**
- Produces: verified client configuration and rollback evidence.

- [ ] **Step 1: Verify transport and model listing**

Check TLS certificate, HTTP protocol, `/healthz`, and authenticated `/v1/models`.
Assert `grok-4.5` appears without printing the credential.

- [ ] **Step 2: Verify OpenAI buffered and SSE paths**

Use synthetic unique email/API-token values. Assert Relay never receives
the original values using safe count/type observability, buffered output is
rehydrated, SSE sends multiple chunks with TTFB less than total time, and the
assembled client output contains originals rather than tags.

- [ ] **Step 3: Verify Anthropic buffered and SSE paths**

Repeat with `x-api-key` and Anthropic Messages payloads. Verify both response
modes rehydrate correctly despite Relay's non-streaming Anthropic
`text/event-stream` response header by prioritizing the request's `stream`
field and parsing buffered JSON when `stream` is false.

- [ ] **Step 4: Verify tool arguments**

First use deterministic local mock tests. Attempt one real Relay tool call;
if Relay returns its known upstream 502 for the same direct payload,
record it as an upstream limitation rather than a proxy failure.

- [ ] **Step 5: Run final local and deployed verification**

Run the full test/lint/build suite again, inspect `git diff`, verify no secrets
are tracked, confirm backend/FRP/Caddy health, and record exact commit/image
identifiers.

- [ ] **Step 6: Commit ops references and report**

Commit only the two verified port-allocation reference changes in the ops
repository with a conventional docs commit. Report public URL, client Base URL
settings, test evidence, changed infrastructure, rollback locations, and any
remaining Relay limitation.
