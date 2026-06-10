# forge-pi

> General-purpose agent runtime at the edge. The orchestrator that bridges all SuperInstance systems.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange.svg)](https://workers.cloudflare.com)
[![Live](https://img.shields.io/badge/Status-LIVE-green.svg)](https://forge-pi.casey-digennaro.workers.dev/health)

## What It Does

forge-pi is the central nervous system of the SuperInstance fleet. It sits at the edge and handles four things:

1. **Dispatch** — Route natural-language queries to the right agent
2. **Discover** — Find relevant capabilities across 543+ crates via semantic search
3. **Compose** — Chain multiple capabilities into pipelines
4. **Offload** — Delegate heavy compute to ephemeral codespace workers

Every operation enforces the conservation law: **γ + η = C** (free potential + actualized work = capacity). Budget is reserved before execution, committed on success, released on failure.

Every message between agents uses the **I2I Vessel Protocol** — typed bottles (BOTTLE, SYNTHESIS, ACK, CHALLENGE, CHECKPOINT) passed through KV.

## Architecture

```
                      ┌─────────────────────┐
                      │    USER / CLIENT    │
                      └──────────┬──────────┘
                                 │ POST /forge
                                 ▼
                      ┌─────────────────────┐
                      │      forge-pi       │
                      │  Cloudflare Worker  │
                      │                     │
                      │  1. Embed query     │
                      │  2. Vector search   │
                      │  3. Route to agent  │
                      │  4. Reserve budget  │
                      │  5. Drop I2I bottle │
                      │  6. Commit budget   │
                      └──┬──┬──┬──┬──┬─────┘
                         │  │  │  │  │
            ┌────────────┘  │  │  │  └──────────────┐
            ▼               ▼  │  ▼                  ▼
     ┌──────────────┐  ┌──────┴──────────┐  ┌──────────────┐
     │ fleet-edge   │  │  fleet-budget   │  │fleet-vector  │
     │ (dispatch)   │  │  (γ+η=C budget) │  │    -api      │
     │ Workers AI   │  │  KV: budget:*   │  │ (discovery)  │
     │ Vectorize    │  │  KV: reserve:*  │  │  543 crates  │
     └──────────────┘  └─────────────────┘  └──────────────┘
```

### Agent Routing Table

forge-pi maps queries to agents based on keyword matching + vector search results:

| Agent | Keywords | Handles |
|-------|----------|---------|
| `fleet-midi` | midi, music, chord, harmony, audio, composition | Musical generation |
| `ghost-track` | tracking, analytics, monitoring, metrics | Telemetry |
| `persona-engine` | persona, character, dialogue, voice, narrative | Character work |
| `fleet-conductor` | scheduling, orchestration, coordination, routing | Fleet scheduling |
| `forgemaster` | build, compile, test, deploy, ci, cargo | Build pipeline |
| `oracle2` | prediction, forecast, embedding, model, inference | Prediction |
| `construct` | math, sheaf, cohomology, topology, spectral | Math/reasoning |

### Conservation Budget Lifecycle

```
         reserve()              commit()           release()
   ┌──────────────┐      ┌──────────────┐    ┌──────────────┐
   │ gamma: 1000  │      │ gamma: 950   │    │ gamma: 1000  │
   │ eta: 0       │  →   │ eta: 50      │ OR │ eta: 0       │
   │ reserved: 50 │      │ reserved: 0  │    │ reserved: 0  │
   │ available:950│      │ ✓ γ+η=1000=C │    │ ✓ rolled back│
   └──────────────┘      └──────────────┘    └──────────────┘
```

1. **Reserve**: Lock `amount` from available budget. Creates a reservation with TTL.
2. **Commit**: Transfer from γ (free) to η (actualized). Validates γ+η=C. Deletes reservation.
3. **Release**: Unlock reserved amount back to available. No γ/η change. For failures/rollbacks.

If `commit()` detects a conservation violation (γ+η ≠ C), it rolls back automatically.

### I2I Vessel Protocol

Bottles are the universal message format between agents:

```typescript
interface I2IBottle {
  type: 'I2I:BOTTLE' | 'I2I:SYNTHESIS' | 'I2I:ACK'
      | 'I2I:CHALLENGE' | 'I2I:CHECKPOINT';
  id: string;           // UUID
  from: string;         // agent name (e.g., 'forge-pi')
  to: string;           // target agent (e.g., 'construct')
  timestamp: number;    // ms epoch
  payload: object;      // request-specific data
  conservation?: {      // budget tracking
    gamma: number;
    eta: number;
  };
  ttl?: number;         // seconds before expiry (default 3600)
}
```

**Bottle types:**
- `I2I:BOTTLE` — Initial message/request to an agent
- `I2I:SYNTHESIS` — Response/result from an agent
- `I2I:ACK` — Acknowledgment (received, will process)
- `I2I:CHALLENGE` — Verification request (prove you computed correctly)
- `I2I:CHECKPOINT` — State snapshot for recovery

**Storage**: Bottles stored in KV under `bottle:{target}:{id}`. Each agent has an inbox at `inbox:{agent}` (last 100 bottles).

## API Reference

### `POST /forge`

Main entry point. Routes a query to the best agent.

**Request:**
```json
{
  "query": "compute sheaf cohomology groups for this simplicial complex",
  "domain": "math",
  "mode": "dispatch",
  "budget_limit": 50,
  "context": { "priority": "high" }
}
```

**Modes:**

| Mode | What happens | Returns |
|------|-------------|---------|
| `dispatch` | Embed → search → route → drop bottle | `{ bottle_id, target_agent, capabilities_used, conservation }` |
| `discover` | Embed → search → return matches | `{ capabilities, target_agent, cost_estimate }` |
| `compose` | Embed → search → create pipeline → drop bottles to each step | `{ pipeline, bottle_ids, conservation }` |
| `offload` | Generate codespace-worker command for local execution | `{ command, target_capability, conservation }` |

**Response (dispatch mode):**
```json
{
  "ok": true,
  "mode": "dispatch",
  "bottle_id": "a1b2c3d4-...",
  "target_agent": "construct",
  "capabilities_used": ["sheaf-cohomology", "spectral-sequence"],
  "conservation": {
    "gamma": 3.5,
    "eta": 1.24,
    "total": 4.74
  },
  "conservation_valid": true
}
```

**Cost estimation:**
- γ cost: `2 + (capability_count × 0.5)` — compute cost
- η cost: `1 + (query_length × 0.01)` — memory cost
- Total must be under `budget_limit` (default 50)

### `POST /discover`

Semantic search across the fleet's 543 indexed crates.

```bash
curl -X POST https://forge-pi.casey-digennaro.workers.dev/discover \
  -H "Content-Type: application/json" \
  -d '{"query": "ternary scheduling algorithm"}'
```

Returns top 10 matches with cosine similarity scores.

### `POST /bottle`

Drop a raw I2I bottle to any agent.

```bash
curl -X POST https://forge-pi.casey-digennaro.workers.dev/bottle \
  -H "Content-Type: application/json" \
  -d '{
    "type": "I2I:BOTTLE",
    "to": "construct",
    "payload": { "query": "prove conservation holds", "hook_point": "proof.verify" },
    "ttl": 7200
  }'
```

### `GET /bottle/:target/:id`

Read a specific bottle.

### `GET /budget?domain=`

Check conservation budget for a domain.

```json
{
  "domain": "math",
  "gamma": 950,
  "eta": 50,
  "C": 1000,
  "reserved": 0,
  "available": 950
}
```

### `GET /status`

Fleet overview: agents, default budget, conservation law.

### `GET /health`

Returns `{ "status": "ok", "service": "forge-pi", "version": "0.1.0" }`.

## Cron Jobs

forge-pi runs a scheduled cleanup every hour:

1. Lists all `bottle:*` keys in KV
2. Deletes bottles older than 1 hour (timestamp-based)
3. Logs cleanup stats to `cron:cleanup:{timestamp}`

## Bindings (wrangler.toml)

```toml
name = "forge-pi"
main = "src/worker.ts"

[vars]
VERSION = "0.1.0"

[[kv_namespaces]]
binding = "FLEET_KV"
id = "3db4cb084224415cada2c97d84365491"

[ai]
binding = "AI"

[[vectorize]]
binding = "VECTORIZE"
index_name = "fleet-crates"
```

## Local Development

```bash
git clone https://github.com/SuperInstance/forge-pi.git
cd forge-pi
npm install
npx wrangler dev
```

Test endpoints:
```bash
# Health check
curl http://localhost:8787/health

# Discover capabilities
curl -X POST http://localhost:8787/discover \
  -d '{"query":"midi chord generation"}'

# Full forge dispatch
curl -X POST http://localhost:8787/forge \
  -d '{"query":"compute H^1 of this sheaf","mode":"dispatch","domain":"math"}'
```

## Deployment

```bash
npx wrangler deploy
```

Live at: `https://forge-pi.casey-digennaro.workers.dev`

## Error Handling

forge-pi follows a strict rollback protocol:

1. **Budget reservation fails** → return 409 (insufficient budget)
2. **Execution fails** (any error) → `releaseBudget()` returns reserved amount
3. **Conservation commit fails** (γ+η≠C detected) → rollback, return 500
4. **Cost exceeds limit** → return 409 with cost estimate

No operation leaves orphaned reservations. Every code path either commits or releases.

## Integration with Other Fleet Workers

| Worker | forge-pi's relationship |
|--------|------------------------|
| **fleet-edge** | forge-pi is the upstream orchestrator; fleet-edge does the actual HTTP dispatch |
| **fleet-budget** | forge-pi implements its own budget system (KV-based); migrating to D1 for atomic consistency |
| **fleet-vector-api** | forge-pi queries Vectorize directly (same binding) for capability discovery |
| **fleet-event-router** | forge-pi's I2I bottles could migrate to event-router's pub/sub mesh |
| **fleet-health** | Monitors forge-pi's `/health` endpoint every 30 minutes |

## Migration Path (v0.2.0)

The D1 migration (designed by Fable 5) will:

1. Replace KV budget with D1 `budgets` table + CHECK constraints
2. Replace KV bottles with D1 `bottles` table + lifecycle states
3. Use `batch()` for atomic reserve+event+log writes
4. Demote KV to read cache with version stamps

See `memory/fable5-d1-design.md` for the full schema.

## Related

- [fleet-edge](https://github.com/SuperInstance/fleet-edge-worker) — HTTP dispatch worker
- [fleet-budget](https://github.com/SuperInstance/fleet-budget) — Conservation budget worker
- [fleet-event-router](https://github.com/SuperInstance/fleet-event-router) — Pub/sub + gossip
- [fleet-vector-api](https://github.com/SuperInstance/fleet-vector-api) — Semantic crate search
- [SuperInstance](https://github.com/SuperInstance) — Organization

## License

Apache-2.0 — See [LICENSE](LICENSE)
