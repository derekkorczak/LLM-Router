# LLM Router — Cheapest Qualifying Model over Merge Gateway

## Goal

An OpenAI-compatible HTTP proxy that, for each request, selects the **cheapest
`(model, vendor, service_tier)` candidate that mechanically satisfies the request's hard
requirements**, then executes it through Merge Gateway. Model metadata and pricing are pulled
from Merge on a schedule so the router adapts to new models and price changes without code edits.

Greenfield repo. Working directory is empty.

## Decisions (settled)

| Decision | Choice |
| --- | --- |
| Runtime | TypeScript / Node |
| Form factor | OpenAI-compatible HTTP proxy (`POST /v1/chat/completions`) |
| Catalog storage | Timestamped JSON snapshot on disk + in-memory cache. No database. |
| Refresh | Daily timer + on boot. On failure serve last good snapshot. Hard-fail requests when snapshot age > 7 days. Manual `POST /admin/refresh`. |
| Selection unit | Full `(model, vendor, service_tier)` triple |
| `flex` tier | Deferred — measured as near-useless for cheapest-first (see recon). Model the tier in the route table, but ship v1 with `allowFlex: false` everywhere. |
| Quality gating | **No benchmark data.** Mechanical capability flags only, including the undocumented-but-live `supports_reasoning`. |
| Cheap-model guardrail | Per-profile `deny` globs + optional `minInputPerMillion` price floor. `coding` profile additionally requires `supports_reasoning` and sets a `$0.15` input floor. |
| Output tokens | Split: **filtering** uses the worst case `max_tokens ?? expectedOutputTokens`; **pricing** uses `min(max_tokens ?? ∞, expectedOutputTokens)` |
| Authentication | **None.** Trusted local network only. Bind to an explicit private address, never `0.0.0.0`. |
| Token counting | `tiktoken` `o200k_base` + configurable safety margin (~15%) + fixed per-image / per-document allowance |
| Streaming | SSE passthrough, untouched; read real `usage`/`cost` from final chunk for logging |
| Failure handling | Walk the ranked candidate list, bounded retries (default max 3, with a total deadline) |
| Profile selection | Model alias in the standard `model` field: `auto`, `auto:vision`, etc. Non-`auto:*` values pass through to Merge verbatim. |
| Requirement inference | Infer from request body and **union** with the profile. Profile may add requirements, never relax an inferred one. |

### Accepted risk, stated plainly

There is no benchmark-based quality gating. The cheapest route satisfying the feature flags
wins. `supports_reasoning`, `minInputPerMillion`, and `deny` globs are crude competence
proxies, not competence checks. Measured consequence: without a floor, `auto:coding` selects
`qwen/qwen3.5-4b` — a 4B model — for every coding request. The `coding` profile's floor and
reasoning requirement exist solely to blunt that. **This is intended behavior; do not "fix"
it in code.** If output quality proves unacceptable, raise `minInputPerMillion` or revisit
the decision to skip an external quality feed.

## Merge Gateway facts to build against

**Evidence status.** Schema taken from the published OpenAPI 3.1 spec, then **verified against
a live authenticated `GET /v1/models`** (full pagination, 2026-07-29). Measured numbers below
are from that live catalog. Task 0 recon is complete; its findings are folded in here.

Base URL `https://api-gateway.merge.dev/v1`. Auth: `Authorization: Bearer <key>`.

### Measured catalog shape (live, 2026-07-29)

- **248 models, 380 `(model, vendor)` routes.** All currently `available` at both model and
  route level — no `deprecated` entries exist today, so that filter is purely defensive.
- **Vendor fan-out:** 169 models single-vendor, 79 multi-vendor (55×2, 8×3, 10×4, 2×5, 2×6,
  1×7, 1×8). ~32% multi-vendor, so the `(model, vendor, tier)` selection unit is
  load-bearing, not ceremony.
- **Pricing coverage is 100%** for per-token routes: zero null `input_per_million`, zero null
  `output_per_million`. The unpriced-route concern does not materialize — but see the
  `unit` trap below, which is worse.
- **Flex: only 15 of 380 routes**, all Google Gemini or OpenAI GPT-5.x, all exactly 50% off
  both input and output. Critically, **flex exists only on expensive models** — the cheapest
  flex route is `openai/gpt-5.4-nano` at 0.10/0.625, versus `qwen/qwen3.5-4b` at 0.04/0.07
  on standard. For a cheapest-first router, **a flex route will essentially never win.**
- **Priority: 0 routes priced.** Confirms the docs. Never emit it.
- **Prompt caching prices present on 203 routes** (`cache_read_per_million`,
  `cache_write_per_million`). Out of scope for v1 but a large future cost lever.
- **Capability distribution:** tool calling 294, tool choice 207, structured outputs 147,
  reasoning 217, streaming 375, image input 163, document input 72, embedding input 0,
  text output 380. ZDR 241.

### Live response contains fields absent from the published OpenAPI spec

The spec I planned against is incomplete. The live payload additionally includes, per route:
`zero_data_retention`, `supports_reasoning`, `reasoning`, `unit`, `input_per_second`,
`output_per_second`, `cache_read_per_million`, `cache_write_per_million`; and per model:
`aliases`. Two consequences:

1. **`supports_reasoning` is a free, mechanical partial quality signal** (217/380 routes).
   Available without any benchmark table. See open decision.
2. **Zod schemas must be permissive** (passthrough unknown keys), not strict. Merge is
   shipping fields ahead of its own spec, so a strict schema would reject live data.

### Confirmed trap: `unit` is not always `per_token`

`openai/whisper-1 @openai` has `unit: "per_second"` with `input_per_million: 0` and
`output_per_million: 0`. Under a null-check-only pricing filter it estimates to **$0 and wins
every single request.** The flattening filter must therefore be
**`pricing.unit === 'per_token'`**, not a null check. Non-chat models (audio) do leak into
this catalog, so capability filters alone are not sufficient either.

### Confirmed vendor divergence (better fixture than the docs example)

`mistral/ministral-3b-2512` is `context_window: 256000, max_output_tokens: 256000` via the
`mistral` vendor, but `128000 / 8192` via `bedrock` — same price. Use this as the primary
test fixture for per-vendor context filtering.

**`GET /models`** — paginated (`data`, `has_more`, `next_cursor`; `limit` default 50).
Each `PublicModel`:

- `model` (`"provider/model-name"`), `provider`, `display_name`
- `availability_status`: `available` | `deprecated`
- `vendors`: map of vendor id -> `PublicVendorModelInfo`, each carrying its **own**:
  - `context_window`, `max_output_tokens`
  - `availability_status`
  - `capabilities`: `input[]` (`text`|`image`|`document`|`embedding`),
    `output[]` (`text`|`tool_use`|`embedding`), `supports_tool_calling`,
    `supports_tool_choice`, `supports_structured_outputs`, `streaming`
  - `pricing`: `input_per_million`, `output_per_million`, `currency`,
    optional `flex` / `priority` (`TierPricing`), and `service_tiers[]`
  - `launch_date`

There is **no** benchmark or intelligence score anywhere. The closest thing to a quality
signal is the live-only boolean `supports_reasoning`.

Capability and context checks **must** read the specific vendor's block, never model-level
aggregates — see the confirmed `ministral-3b` divergence above.

**`POST /responses`** — native surface. Relevant request fields:
`model` (optional if a policy is configured), `input[]`, `tools[]`, `tool_choice`,
`max_tokens`, `temperature`, `top_p`, `stop`, `response_format`, `stream`,
`vendor`, `vendors[]` (ordered, first available wins), `service_tier`
(`standard`|`flex`|`priority`), `service_tier_fallback`, `include_routing_metadata`,
`tags[]`, `project_id`.

Response: `model`, `vendor`, `service_tier` (tier actually billed), `output[]`,
`usage { input_tokens, output_tokens, total_tokens, cost }`, optional `routing`.

Notes that affect implementation:
- `usage.cost` is `null` (never `0`) when the served route has no pricing on file. Treat
  `null` as unknown, never as zero.
- `priority` tier is accepted but priced on no route today, so it always fails closed.
  Never emit it.
- `service_tier` on a route that doesn't price it fails closed with `400`.
- Streaming carries `usage` only on the final `response.done` chunk.

**`GET /vendors`** — vendor -> `supports_zdr`, `supports_byok`, `availability_status`.
Not required for v1; may be useful later for a ZDR-only profile.

**OpenAI-compatible surface** — `POST /v1/openai/chat/completions` exists and returns the
same `usage.cost`. `vendor` / `vendors` are documented **only** on `/v1/responses`.
See Task 1 spike.

## Task 0 — Catalog reconnaissance — **DONE**

Executed live on 2026-07-29. Findings are recorded in the section above and have already
been folded into the tasks below. The one remaining action is to re-run the same dump once
during implementation and commit it as `fixtures/catalog-sample.json`, so every unit test
runs against real catalog data rather than hand-invented shapes.

### What the `coding` profile actually selects today (measured)

Ranked by `input + 4×output` (a 1:4 prompt:completion assumption), cheapest text +
tool-calling routes:

| Model @ vendor | in / out ($/M) | ctx | reasoning |
| --- | --- | --- | --- |
| `qwen/qwen3.5-4b` @empiriolabs | 0.04 / 0.07 | 262144 | yes |
| `mistral/ministral-3b-2512` @mistral | 0.10 / 0.10 | 256000 | no |
| `zai/glm-4-32b-0414-128k` @zai | 0.10 / 0.10 | 128000 | no |
| `amazon/nova-micro` @bedrock | 0.035 / 0.14 | 128000 | no |
| `qwen/qwen3.5-9b` @empiriolabs | 0.09 / 0.13 | 262144 | yes |
| `cohere/command-r7b-12-2024` @cohere | 0.0375 / 0.15 | 128000 | no |
| `openai/gpt-oss-20b` @togetherai | 0.05 / 0.20 | 128000 | yes |

**This is the concrete consequence of dropping quality gating: a 4B model wins every coding
request.** It is exactly what "cheapest that satisfies the flags" means. The `deny` globs and
`minInputPerMillion` floor in the config must be calibrated against this table, not guessed.

Cheapest vision routes are similar: `qwen/qwen3.5-4b`, `google/gemma-3-4b-it`.

### Calibration step still outstanding

The `coding` profile is configured as `requires: [tool_calling, reasoning]` with
`minInputPerMillion: 0.15`. From the table above, that correctly eliminates the three cheap
reasoning-capable routes (`qwen3.5-4b` $0.04, `gpt-oss-20b` $0.05, `qwen3.5-9b` $0.09).
**What sits immediately above the $0.15 floor was not measured** — the recon key was revoked
before that query ran.

First implementation step after the catalog loader works: run `POST /admin/explain` with a
representative coding request and inspect the top 10. Confirm the winner is a model you would
actually accept for the work. If it is still too weak, raise the floor rather than adding
deny globs — the floor stays valid as new models ship, globs do not.

## Task 1 — Spike: which Merge surface to target (do this first, it shapes Task 6)

Blocking unknown. Resolve before writing the execution layer.

1. Send `POST /v1/openai/chat/completions` with an explicit `model`, plus
   `vendors: ["..."]` and `service_tier: "flex"` on a route known to price flex.
2. Inspect the response for the pinned `vendor` and the billed `service_tier`.

- **If pinning is honored:** proxy passes the OpenAI body through nearly untouched
  (inject `model`, `vendors`, `service_tier`, `service_tier_fallback`). No format
  translation. Preferred.
- **If pinning is ignored or rejected:** translate OpenAI Chat Completions -> `/v1/responses`
  and back. Pinning correctness is non-negotiable; a silently different vendor invalidates
  the capability check, which is the entire point of the router.

Record the outcome in the repo README. Design the execution layer behind a single
`GatewayClient` interface so either surface is swappable.

## Task 2 — Project scaffold

- Node + TypeScript, strict mode. Fastify (or Express) HTTP server.
- Deps: `tiktoken` (or `js-tiktoken`), `zod` for config + Merge response validation,
  `picomatch` (or equivalent) for deny/allow globs, a structured logger (`pino`).
- Config from env + a `router.config.json`/`.yaml` file. Zod-validate on boot; refuse to
  start on invalid config.
- Env: `MERGE_API_KEY`, `BIND_HOST`, `PORT`, `CATALOG_DIR`, `CATALOG_REFRESH_INTERVAL_MS`,
  `CATALOG_MAX_AGE_MS` (default 7d), `LOG_LEVEL`.
- **No caller authentication** — trusted local network, per decision. Two cheap constraints
  that keep that assumption true: default `BIND_HOST` to `127.0.0.1` (never `0.0.0.0`, and
  require it to be set explicitly to bind any non-loopback interface), and log a startup
  warning whenever the bind address is non-loopback. The process holds a live billable Merge
  key, so an accidental `0.0.0.0` bind is an open relay to your LLM spend.

## Task 3 — Catalog fetch + snapshot store

- `fetchCatalog()`: page `GET /models` following `next_cursor` until `has_more` is false.
  Zod-validate each `PublicModel`; log and skip malformed entries.
- **Abort the whole refresh** (retaining the previous table) if any page is non-2xx, if any
  page lacks a `data` array, or if **more than 5% of models fail validation**. Skipping a
  couple of malformed entries is fine; skipping a third of the catalog silently produces a
  router that thinks expensive models don't exist. Observed live: one page returned no `data`
  array transiently, so this is not hypothetical.
- Bound pagination with a max-page guard to prevent a cursor loop from spinning forever.
- Flatten to a **candidate route table**: one row per
  `(model, vendor, tier)` where `tier ∈ service_tiers` and pricing for that tier exists.
  Skip `priority` always. Skip rows where model-level **or** vendor-level
  `availability_status` is `deprecated`.
  Row fields: `model`, `provider`, `vendor`, `tier`, `contextWindow`, `maxOutputTokens`,
  `inputPerMillion`, `outputPerMillion`, capability flags.
- **Require `pricing.unit === 'per_token'`.** Drop everything else. Confirmed necessary:
  `openai/whisper-1` is `per_second` with both per-million rates at `0`, and would otherwise
  estimate to $0 and win every ranking. Also defensively drop rows where either
  `input_per_million` or `output_per_million` is null/non-numeric (none exist today, but the
  field is nullable in the schema). Count and log all drops per refresh.
- Zod schemas must use **passthrough** for unknown keys. The live payload carries fields the
  published OpenAPI spec omits (`supports_reasoning`, `zero_data_retention`, `unit`,
  `cache_*_per_million`, `aliases`); a strict schema rejects real data.
- Retain `supports_reasoning`, `zero_data_retention`, and model-level `aliases` on each row.
  Reasoning is an optional profile requirement; ZDR is a likely near-term profile constraint;
  aliases must be considered when matching `deny`/`allow` globs so a denied model cannot slip
  back in under an alternate id.
- Persist `{ fetchedAt, sourceCount, routes[] }` to `CATALOG_DIR/catalog-<ISO>.json` plus
  a `catalog-latest.json` pointer. Retain the last N snapshots for price-change diffing.
- `CatalogStore`: holds the in-memory table, `fetchedAt`, and `isStale()` /
  `isExpired()`. On boot, load `catalog-latest.json` if present so the service is
  immediately serviceable, then refresh in the background.
- Scheduler: refresh on boot + every 24h. On failure, log, increment a failure counter,
  keep the previous table. Never replace a good table with a partial one — swap
  atomically only after a complete successful fetch.
- `POST /admin/refresh` forces a refresh and returns the new `fetchedAt` and route count.

## Task 4 — Token counting

`estimatePromptTokens(body)`:

- Encode all text content with `o200k_base`. Include role/message framing overhead
  (a small fixed per-message constant) and the serialized `tools` JSON — tool schemas are
  frequently the largest part of a coding-agent prompt and must not be omitted.
- Add a fixed configured allowance per image part and per document part. The fixed document
  allowance is crude — a 200-page PDF is nothing like a 1-page one. Scale it from the decoded
  byte length of base64 document parts rather than using a constant, and leave URL-sourced
  documents on the constant since size is unknowable without fetching.
- Multiply the total by `1 + tokenSafetyMargin` (default `0.15`) and round up.

**Output tokens produce two different numbers, and conflating them mis-ranks.** Callers
routinely set `max_tokens` as a high safety cap rather than an expectation, so pricing the
worst case skews the ranking toward low-output-price models.

```
outputCeiling  = body.max_tokens ?? profile.expectedOutputTokens   // hard limits
outputExpected = min(body.max_tokens ?? Infinity, profile.expectedOutputTokens)  // pricing
```

- `outputCeiling` feeds the **capability and context filters** — a route must be able to emit
  that many tokens, and `promptTokens + outputCeiling` must fit the context window.
- `outputExpected` feeds the **cost estimate only**.

Worked example: caller sets `max_tokens: 32000` on the `coding` profile
(`expectedOutputTokens: 4000`). Routes capping below 32000 output are correctly excluded, the
context check reserves the full 32000, but ranking prices a realistic 4000-token completion. A
caller setting `max_tokens: 100` is priced at 100, not 4000.

Document that cross-family tokenizers differ; only relative ranking matters, and the safety
margin protects the context-fit check, where absolute accuracy actually matters.

## Task 5 — Requirement inference, filtering, ranking

**Requirements** = union of profile-declared and body-inferred. Inference rules:

- Any `image_url` / image content part -> `input` must include `image`
- Any document / PDF part -> `input` must include `document`
- `tools` non-empty -> `supports_tool_calling`
- `tool_choice` naming a specific function or `"required"` -> `supports_tool_choice`
- `response_format` json object or json schema -> `supports_structured_outputs`
- `stream: true` -> `streaming`
- Always -> `output` must include `text`

Profile-only requirements (never inferred from the body): `reasoning` ->
`supports_reasoning`, and `zdr` -> `zero_data_retention`.

**Filter** each candidate route:

1. Capability flags satisfy every requirement (read from **that vendor's** block).
2. `promptTokens + outputCeiling <= contextWindow`
3. `outputCeiling <= maxOutputTokens`
4. Model id **and any alias** does not match a profile `deny` glob; matches `allow` if set.
5. `inputPerMillion >= profile.minInputPerMillion` when configured.
6. Tier is `standard`, or `flex` and `profile.allowFlex` is true.

**Rank** by estimated total cost, ascending, using `outputExpected` — not `outputCeiling`:

```
cost = promptTokens/1e6 * inputPerMillion + outputExpected/1e6 * outputPerMillion
```

Tie-breakers, in order: larger `contextWindow`, then newer `launch_date`, then
lexicographic `model` + `vendor` for determinism. Return the **full ranked list**, not one
winner — Task 7 walks it.

If the list is empty, return `503` with a structured body naming which requirement
eliminated the most candidates. Do not silently fall back to Merge's own routing.

### Selection is stateless — and that is already stable

The router holds **no per-conversation state**. Every turn of a multi-turn conversation is
re-ranked from scratch. This looks like it would cause erratic mid-conversation model
switching, but it does not, for two reasons:

1. **Pricing only changes once per day** (catalog refresh cadence). Within a catalog
   generation the ranking function is pure, and tie-breaks are fully deterministic, so
   identical inputs always select the identical candidate.
2. The only inputs that vary turn-to-turn are prompt length and `max_tokens`. Those change
   the selection **only** when growth crosses a `context_window` or `max_output_tokens`
   boundary and eliminates the incumbent — which is precisely when a switch is desirable.

So no session affinity, conversation fingerprinting, or sticky-routing cache is needed in v1.
Add a test asserting that two identical requests select the identical candidate, and that a
request whose prompt has grown past the incumbent's context window switches to the next
qualifying candidate rather than failing.

**Caveat, and the reason to revisit:** because selection is per-turn and prompt-cache pricing
is out of scope, the router does not reason about cache locality. On 203 routes Merge
publishes `cache_read_per_million`, typically a large discount on repeated prefixes. For a
coding agent resending a growing 50K-token prompt every turn, staying on one model to earn
cache hits can be cheaper than moving to the nominally cheapest model. Cache-aware pricing is
the single highest-value v2 change, and it is what would justify introducing stickiness.

## Task 6 — Gateway execution client

`GatewayClient.execute(candidate, body, { stream })` behind one interface, implemented
against whichever surface Task 1 selected.

- Always pin: `model: candidate.model`, `vendors: [candidate.vendor]`, and
  `service_tier` + `service_tier_fallback: true` when the candidate tier is `flex`.
- Set `include_routing_metadata: true` on non-streaming calls to cross-check the served
  vendor against the pinned one; log a warning on mismatch.
- Streaming: pipe SSE chunks through unmodified. Parse the terminal chunk out-of-band to
  capture real `usage` and `cost` for logging without mutating the client's stream.
- Classify errors: `429` / `5xx` / connection errors are **retryable**; `400` indicating an
  unsupported feature is **retryable** (advance to the next candidate) and additionally
  logged as a capability-metadata discrepancy worth investigating; `401` / `403` and
  malformed-input `400`s are **terminal**.
- **Sampling-parameter compatibility.** Reasoning models commonly reject `temperature` /
  `top_p`. Since the `coding` profile now *requires* `supports_reasoning`, this will be hit.
  The live payload carries a `reasoning` object per route that may describe constraints —
  inspect it during Task 0's re-run. Until its shape is known, treat a `400` naming an
  unsupported sampling parameter as retryable, and on the retry against the **same** candidate
  strip the offending parameter once before advancing to the next candidate. Log every strip.

### Streaming forecloses failover — handle it explicitly

Once the first SSE byte is flushed to the client, the response status and headers are
committed and the ranked-list walk is **dead**. Policy:

- Buffer nothing, but do not flush until the upstream connection is established and the first
  upstream chunk arrives. Failures **before** first byte fail over normally.
- Failures **after** first byte cannot fail over. Propagate the upstream error into the stream
  and terminate; do not silently truncate as if the response completed. Increment a distinct
  `stream_failed_midflight` counter — this is the one failure mode the retry design cannot
  cover, so it needs its own visibility.
- `X-Router-*` headers must therefore be computed and set **before** the first flush.
  `X-Router-Actual-Cost` is unavailable at that point on streaming requests; omit it and emit
  the real cost only to the structured log from the terminal chunk.

## Task 7 — Proxy endpoint

`POST /v1/chat/completions`:

1. If `model` is not an `auto:*` alias (and not bare `auto`), forward verbatim to Merge and
   return the response unchanged. Escape hatch, no routing.
2. Resolve the profile from the alias. Unknown alias -> `400`.
3. If the catalog is expired (age > `CATALOG_MAX_AGE_MS`), return `503` — do not route on
   week-old prices.
4. Estimate tokens, infer requirements, filter, rank.
5. Walk the ranked list: attempt candidate `i`; on a retryable failure advance to `i+1`,
   up to `maxAttempts` (default 3) and a total wall-clock deadline. Terminal errors surface
   immediately.
6. On success, set response headers: `X-Router-Model`, `X-Router-Vendor`,
   `X-Router-Tier`, `X-Router-Estimated-Cost`, `X-Router-Actual-Cost`,
   `X-Router-Attempts`, `X-Router-Candidates-Considered`, `X-Router-Catalog-Age-Seconds`.
7. Log one structured line per request: profile, requirements, prompt/output token
   estimates, top 3 candidates with estimated costs, attempts, served
   model/vendor/tier, estimated vs actual cost, latency.

Also expose:

- `GET /healthz` — liveness
- `GET /readyz` — catalog present and not expired
- `GET /v1/models` — **must stay OpenAI-shaped**, because drop-in SDK clients and chat UIs
  call it to populate model pickers. Return an OpenAI `{object:"list", data:[{id,object,...}]}`
  containing the `auto:*` profile aliases **plus** the passthrough model ids. Do not return the
  internal route table here.
- `GET /admin/routes` — the flattened `(model, vendor, tier)` route table with prices and
  capability flags. This is where the debugging view lives.
- `POST /admin/explain` — same body as a chat request, returns the ranked candidate list
  and per-filter elimination counts **without** calling any provider. This is the primary
  debugging tool; build it early, not last.

## Task 8 — Config shape

```jsonc
{
  "tokenSafetyMargin": 0.15,
  "imageTokenAllowance": 1200,
  "documentTokenAllowance": 3000,
  "maxAttempts": 3,
  "requestDeadlineMs": 120000,
  "refreshAbortDropRatio": 0.05,
  "shadowModel": null,
  "profiles": {
    "default": {
      "expectedOutputTokens": 1500,
      "allowFlex": false,
      "deny": [],
      "minInputPerMillion": 0
    },
    "coding": {
      "expectedOutputTokens": 4000,
      "requires": ["tool_calling", "reasoning"],
      "allowFlex": false,
      "deny": [],
      "minInputPerMillion": 0.15
    },
    "vision": {
      "expectedOutputTokens": 1000,
      "requires": ["image_input"],
      "allowFlex": false,
      "minInputPerMillion": 0
    },
    "bulk": {
      "expectedOutputTokens": 800,
      "allowFlex": false,
      "minInputPerMillion": 0
    }
  }
}
```

`auto` maps to `default`; `auto:coding` to `coding`, etc.

## Task 9 — Docker Deployment

- **Containerize the router** using a `Dockerfile` and `docker-compose.yml` for local development and production.
- **Base image**: Use a lightweight Node.js LTS image (e.g., `node:20-alpine`).
- **Multi-stage build**: Extract only runtime dependencies to reduce image size.
- **Environment variables**: Expose `MERGE_API_KEY`, `BIND_HOST`, `PORT`, `CATALOG_DIR`, etc., via `docker-compose.yml`.
- **Volume mounts**: Bind `CATALOG_DIR` to persist catalog snapshots.
- **Networking**: Run as a container with `--network=host` for local debugging (bind to `127.0.0.1` only).
- **Health checks**: Add `GET /healthz` and `GET /readyz` endpoints to validate container readiness.
- **Logging**: Use `docker-compose` to stream logs to a local terminal or external service (e.g., ELK).

### Dockerfile
```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### docker-compose.yml
```yaml
version: "3.8"
services:
  router:
    build: .
    container_name: llm-router
    network_mode: host  # Bind to 127.0.0.1 only
    volumes:
      - ./catalog:/app/catalog
    environment:
      - MERGE_API_KEY=${MERGE_API_KEY}
      - BIND_HOST=127.0.0.1
      - PORT=3000
      - CATALOG_DIR=/app/catalog
    restart: unless-stopped
```

### Deployment Steps
1. **Build and start**:
   ```bash
   docker-compose build
   docker-compose up -d
   ```
2. **Verify**:
   - Check logs: `docker-compose logs router`.
   - Test endpoints: `curl http://localhost/healthz`.

## Rollout

Greenfield, so no migration. Introduce to real traffic in three stages, each gated on the
previous:

1. **Dry run.** Deploy with routing reachable only via `POST /admin/explain`. Replay a corpus
   of representative real requests and read the selections. No provider calls, no spend. This
   is where the `coding` floor gets calibrated.
2. **Shadow mode.** Config flag `shadowModel: "<explicit model id>"`. The router performs full
   selection, logs its pick and estimated cost, then **executes against the shadow model
   instead**. Yields a real cost delta between "what we'd have spent" and "what we spend now"
   without exposing users to a 4B model. Run until the delta is credible.
3. **Live.** Clear `shadowModel`. Start with the `default` profile only; enable `auto:coding`
   last, since it is the profile where quality risk is concentrated.

Rollback is a config change (set `shadowModel`, or point clients back at Merge directly), not
a redeploy.

## Validation

All unit tests run against `fixtures/catalog-sample.json` — the real committed catalog dump —
not hand-invented shapes.

- **Unit — filtering/ranking:** `flex` rows appear only when `allowFlex` is true; `priority`
  never appears; `deprecated` rows never appear; a tool-calling requirement excludes routes
  with `supports_tool_calling: false` while retaining sibling vendor rows of the same model.
- **Unit — cost ranking:** construct two routes where A is cheaper on input and more
  expensive on output, and assert the ranking flips as `expectedOutputTokens` grows. This
  is the specific bug the output-token estimate exists to prevent — pin it with a test.
- **Unit — ceiling vs expected split:** with `max_tokens: 32000` and
  `expectedOutputTokens: 4000`, assert routes with `max_output_tokens < 32000` are excluded,
  the context check reserves 32000, and the ranking prices 4000. With `max_tokens: 100`,
  assert pricing uses 100. This is the ranking-skew fix — pin it.
- **Unit — guardrails:** deny globs and `minInputPerMillion` each eliminate the expected
  rows; empty result yields `503` with elimination counts.
- **Unit — inference:** each inference rule fires from a representative body; profile
  requirements union rather than override.
- **Unit — token counting:** tool schemas are included in the count; margin applied;
  image/document allowances added.
- **Unit — catalog:** pagination follows `next_cursor`; a mid-pagination failure leaves the
  previous in-memory table intact; expiry past 7 days flips `isExpired()`.
- **Unit — pricing unit trap (regression test):** with the real catalog fixture loaded,
  assert `openai/whisper-1` never appears in any ranking, and that no candidate with
  `unit !== 'per_token'` survives flattening. This is the highest-value single test in the
  suite — without it the router silently routes everything to a $0 audio model.
- **Unit — permissive parsing:** a route payload containing unknown future keys parses
  successfully rather than throwing.
- **Unit — vendor context divergence (real fixture):** `mistral/ministral-3b-2512` with a
  200K-token prompt keeps the `mistral` route (256K ctx) and drops the `bedrock` route
  (128K ctx).
- **Unit — determinism:** two identical requests select the identical candidate; a request
  whose prompt grew past the incumbent's context window switches to the next qualifying
  candidate rather than returning `503`.
- **Unit — refresh abort threshold:** a payload where 10% of models fail validation aborts the
  refresh and retains the prior table; a payload where 1% fail completes with the bad entries
  skipped. A page missing `data` aborts.
- **Integration (mocked Merge):** retryable `429` on candidate 1 advances to candidate 2;
  terminal `401` surfaces immediately; `maxAttempts` is respected; SSE passthrough is
  byte-identical and the final-chunk usage is captured.
- **Integration — streaming failover boundary:** an upstream failure *before* first byte fails
  over to candidate 2; an upstream failure *after* first byte terminates the stream with a
  propagated error, does **not** attempt candidate 2, and increments
  `stream_failed_midflight`.
- **Integration — `GET /v1/models` shape:** response validates against the OpenAI models-list
  shape and includes every configured `auto:*` alias.
- **Live smoke:** point the OpenAI SDK at the proxy with `model: "auto"`; confirm a real
  response, and confirm `X-Router-Vendor` matches the response `vendor`. Compare
  `X-Router-Estimated-Cost` to `X-Router-Actual-Cost` across ~20 varied requests and record
  the error distribution in the README — this calibrates `tokenSafetyMargin` and the
  `expectedOutputTokens` defaults.
- **Cost regression:** run a fixed request corpus through `POST /admin/explain` against two
  catalog snapshots and diff the selected candidates. Surfaces silent routing changes caused
  by upstream price moves.

## Risks

- **Merge's published OpenAPI spec lags its live API.** Confirmed: several live fields are
  undocumented. Treat the spec as a floor, not a contract; parse permissively and re-run the
  Task 0 dump periodically to detect new fields.
- **Non-chat models (audio, and likely others later) are present in the model catalog.**
  `unit`-based filtering handles today's case, but new modalities may need new exclusions.
  Alert on any route whose `unit` is unrecognized rather than silently dropping it.
- **Vendor pinning may not work on the OpenAI-compatible surface.** Mitigated by the Task 1
  spike and the `GatewayClient` interface.
- **Merge capability metadata may be wrong for some routes,** producing `400`s the filter
  should have caught. Mitigated by treating feature-`400`s as retryable and logging them as
  discrepancies.
- **Cost estimates are approximate** (foreign tokenizer, guessed output length). Only
  relative ranking matters; the live-smoke calibration step quantifies the error.
- **Merge bills provider cost + plan rate**, and BYOK is priced at list. `usage.cost` is not
  the invoiced amount. Label all router-reported figures as estimates of provider cost.
- **Silent quality degradation** is the expected steady state given no benchmark-based
  gating. `supports_reasoning` plus a price floor are crude proxies, not competence checks.
  The `/admin/explain` endpoint and the cost-regression diff are the only visibility into it.
- **A price floor decays as an implicit quality signal.** Model prices fall over time, so a
  fixed `$0.15` floor admits progressively weaker models. Revisit the floor whenever the
  cost-regression diff shows the selected model changing.
- **`GET /models` returned an empty/dataless page once during recon** (transient). The
  refresh loop must treat a page with a missing `data` array as a failed refresh and retain
  the previous table, not silently build a partial catalog. Covered by a unit test.

## Out of scope for v1

Caller authentication (trusted local network), embeddings routing, semantic response caching,
budget enforcement, per-customer (Embedded Routing) policies, ZDR/BYOK-constrained profiles,
latency-aware or quality-aware selection, session-sticky routing, and a persistent
request-log datastore.

**Ranked v2 candidates**, in order of expected value:

1. **Cache-aware pricing.** `cache_read_per_million` is published on 203 routes and is
   typically a steep discount on repeated prefixes. For agent workloads that resend a growing
   prompt every turn this likely dominates all other cost levers, and it is the change that
   would justify introducing sticky routing.
2. **Latency as a secondary rank key**, once real per-route latency data has accumulated.
3. **`flex` tier**, if Merge expands it beyond the current 15 expensive routes.
4. **An external quality feed** (models.dev / Artificial Analysis), if the price-floor proxy
   proves insufficient in practice.
