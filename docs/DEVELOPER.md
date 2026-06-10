# forge-pi Developer Guide

> For engineers integrating with, extending, or debugging forge-pi.

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [The I2I Vessel Protocol](#the-i2i-vessel-protocol)
3. [Conservation Budget System](#conservation-budget-system)
4. [Agent Routing](#agent-routing)
5. [Capability Discovery](#capability-discovery)
6. [Adding a New Agent](#adding-a-new-agent)
7. [Adding a New Bottle Type](#adding-a-new-bottle-type)
8. [Integration Patterns](#integration-patterns)
9. [Debugging](#debugging)
10. [D1 Migration (v0.2)](#d1-migration-v02)

---

## Core Concepts

### The Conservation Law: γ + η = C

Every operation in forge-pi consumes budget. The total capacity C is fixed per domain.

- **γ (gamma)** — Free potential. Budget available for new work.
- **η (eta)** — Actualized work. Budget that has been consumed.
- **reserved** — Budget locked for in-flight operations.
- **available = γ - reserved** — What can be spent right now.

The invariant: `γ + η + reserved = C` at all times. This is enforced at commit time.

### The I2I Vessel Protocol

Agents communicate through typed messages called "bottles" — inspired by message-in-a-bottle patterns in distributed systems. Bottles are stored in KV and have a TTL (default 1 hour).

### The Four Modes

| Mode | Purpose | When to use |
|------|---------|-------------|
| `dispatch` | Send a single query to one agent | Default. One task, one target. |
| `discover` | Find what agents/capabilities exist | Exploratory. No execution. |
| `compose` | Chain multiple capabilities in sequence | Multi-step tasks. Pipeline of bottles. |
| `offload` | Generate a command for local execution | Heavy compute that can't run on Workers. |

---

## The I2I Vessel Protocol

### Bottle Lifecycle

```
  Agent A                  KV                  Agent B
     │                      │                      │
     │  dropBottle()        │                      │
     ├─────────────────────►│ bottle:B:B:id         │
     │                      │ inbox:B += [id]       │
     │                      │                      │
     │                      │  readBottle()         │
     │                      │◄─────────────────────┤
     │                      │                      │
     │                      │  dropBottle()         │
     │  (SYNTHESIS)         │◄─────────────────────┤
     │◄─────────────────────┤ inbox:A += [id]       │
     │                      │                      │
```

### Bottle Types in Detail

**`I2I:BOTTLE`** — The workhorse. A request from one agent to another.

```json
{
  "type": "I2I:BOTTLE",
  "id": "uuid-here",
  "from": "forge-pi",
  "to": "construct",
  "timestamp": 1718000000000,
  "payload": {
    "query": "compute H^1",
    "context": {},
    "discovered_capabilities": ["sheaf-cohomology"],
    "hook_point": "dispatch.query"
  },
  "conservation": { "gamma": 3.0, "eta": 1.5 },
  "ttl": 3600
}
```

The `hook_point` field tells the target agent which code path to execute. Standard hook points:
- `dispatch.query` — Main query dispatch
- `compose.step` — Pipeline step execution
- `proof.verify` — Verification/challenge
- `checkpoint.save` — State persistence

**`I2I:SYNTHESIS`** — A response/result. The `payload.in_response_to` field links back to the original bottle ID.

**`I2I:ACK`** — Acknowledgment. The target received the bottle and will process it.

**`I2I:CHALLENGE`** — Verification request. "Prove you computed this correctly." Used in trust-but-verify patterns.

**`I2I:CHECKPOINT`** — State snapshot for crash recovery. Contains the full agent state at a point in time.

### KV Key Layout

| Key Pattern | Contents | TTL |
|-------------|----------|-----|
| `bottle:{target}:{id}` | Full bottle JSON | Bottle's `ttl` (default 3600s) |
| `inbox:{agent}` | Array of bottle IDs (last 100) | 86400s (24h) |
| `reserve:{id}` | Reservation details (domain, amount) | 3600s (1h) |
| `budget:{domain}` | Current budget state | No expiry |
| `log:{id}` | Operation log entry | 604800s (7 days) |
| `cron:cleanup:{ts}` | Cleanup stats | 86400s (24h) |

---

## Conservation Budget System

### Reserve → Commit → Release

```typescript
// 1. Reserve budget before work
const reservation = await reserveBudget(env, 'math', 4.74, 'forge-pi: sheaf computation');
// → { ok: true, reservation_id: 'abc-123' }
// Budget state: gamma=995.26, reserved=4.74, available=995.26

// 2. Do the work...
const result = await doExpensiveComputation();

// 3a. Success → commit (gamma decreases, eta increases)
await commitBudget(env, 'abc-123');
// Budget state: gamma=995.26, eta=4.74, reserved=0

// 3b. Failure → release (everything stays the same)
await releaseBudget(env, 'abc-123');
// Budget state: gamma=1000, eta=0, reserved=0
```

### Conservation Validation

At commit time, forge-pi checks:
```
if |(gamma + eta) - C| > 0.001:
    ROLLBACK
    return error "Conservation violation: γ + η ≠ C"
```

This catches floating-point drift and race conditions. The 0.001 tolerance handles floating-point arithmetic imprecision.

### Cost Estimation Formula

```typescript
const gammaCost = 2 + (capabilities.length * 0.5);  // Compute cost
const etaCost = 1 + (query.length * 0.01);            // Memory cost
const total = gammaCost + etaCost;
```

- **γ cost** scales with the number of capabilities consulted (vector search results)
- **η cost** scales with query length (longer queries = more processing)

### Budget Defaults

New domains start with: `gamma=1000, eta=0, C=1000, reserved=0, available=1000`.

---

## Agent Routing

### How Routing Works

1. **Keyword matching**: The query is compared against each agent's keyword list
2. **Capability metadata**: Vector search results may contain agent routing hints
3. **Fallback**: If no agent matches, defaults to `construct` (the math/reasoning agent)

### The Agent Map

```typescript
const AGENT_MAP: Record<string, string[]> = {
  'fleet-midi':      ['midi', 'music', 'chord', 'harmony', 'audio', 'composition'],
  'ghost-track':     ['tracking', 'analytics', 'monitoring', 'metrics', 'telemetry'],
  'persona-engine':  ['persona', 'character', 'dialogue', 'voice', 'narrative'],
  'fleet-conductor': ['scheduling', 'orchestration', 'coordination', 'routing'],
  'forgemaster':     ['build', 'compile', 'test', 'deploy', 'ci', 'cargo'],
  'oracle2':         ['prediction', 'forecast', 'embedding', 'model', 'inference'],
  'construct':       ['math', 'sheaf', 'cohomology', 'topology', 'spectral', 'hodge'],
};
```

### Adding a New Agent

1. Add the agent and its keywords to `AGENT_MAP` in `src/worker.ts`
2. Deploy: `npx wrangler deploy`
3. The agent can now receive I2I bottles via KV

Example:
```typescript
'my-new-agent': ['keyword1', 'keyword2', 'keyword3'],
```

---

## Capability Discovery

### How Discovery Works

1. **Embed**: The query is embedded using Workers AI (`@cf/baai/bge-small-en-v1.5`, 384 dimensions)
2. **Search**: The embedding is queried against the `fleet-crates` Vectorize index (543 crates, cosine similarity)
3. **Return**: Top-K results with scores and metadata

### Vectorize Index Details

- **Index**: `fleet-crates`
- **Model**: `bge-small-en-v1.5` (384 dimensions)
- **Metric**: Cosine similarity
- **Size**: 543 crates indexed
- **Binding**: `VECTORIZE` in wrangler.toml

### Discovery Response

```json
{
  "query": "ternary scheduling",
  "capabilities": [
    {
      "id": "ternary-scheduler",
      "score": 0.89,
      "metadata": {
        "language": "rust",
        "version": "0.1.0"
      }
    }
  ]
}
```

---

## Adding a New Bottle Type

1. Add the type to the `BottleType` union in `src/worker.ts`:
```typescript
type BottleType = 'I2I:BOTTLE' | 'I2I:SYNTHESIS' | 'I2I:ACK' 
                | 'I2I:CHALLENGE' | 'I2I:CHECKPOINT' | 'I2I:YOUR_TYPE';
```

2. Add handling in the target agent's worker code
3. Add any new KV key patterns needed
4. Update the cron cleanup to handle the new type if needed

---

## Integration Patterns

### Pattern 1: Simple Dispatch

```bash
# Client → forge-pi → target agent
curl -X POST /forge -d '{"query":"generate midi chords","mode":"dispatch"}'
```

### Pattern 2: Multi-Step Pipeline

```bash
# Client → forge-pi → [agent1, agent2, agent3]
curl -X POST /forge -d '{"query":"analyze and visualize","mode":"compose"}'
```

Each step in the pipeline gets its own I2I bottle with `pipeline_step` in the payload.

### Pattern 3: Discover First, Dispatch Second

```bash
# Step 1: Find what's available
curl -X POST /discover -d '{"query":"sheaf theory"}'

# Step 2: Dispatch with context
curl -X POST /forge -d '{"query":"compute H^1","mode":"dispatch","context":{"capabilities":[...]}}'
```

### Pattern 4: Offload Heavy Compute

```bash
curl -X POST /forge -d '{"query":"cargo test --release","mode":"offload"}'
# Returns a command to execute locally
```

---

## Debugging

### Check forge-pi Health

```bash
curl https://forge-pi.casey-digennaro.workers.dev/health
```

### Check Budget State

```bash
curl https://forge-pi.casey-digennaro.workers.dev/budget?domain=math
```

### Check Fleet Status

```bash
curl https://forge-pi.casey-digennaro.workers.dev/status
```

### Read a Specific Bottle

```bash
curl https://forge-pi.casey-digennaro.workers.dev/bottle/construct/a1b2c3d4-...
```

### Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| "Insufficient budget" | `available < cost` | Wait for reservations to expire (1h TTL) or increase domain capacity |
| "Conservation violation" | γ+η≠C after commit | Check for concurrent writes to the same domain budget |
| "No capabilities found" | Vectorize returned 0 results | Query might be too abstract; try specific technical terms |
| Bottle not found | TTL expired or never created | Check the bottle ID; bottles expire after 1 hour |
| Rate limiting | Workers AI embed limits | Reduce query frequency or batch requests |

---

## D1 Migration (v0.2)

The KV-based system has a known limitation: no atomic transactions. Two concurrent requests can both reserve budget from the same domain and overcommit.

The D1 migration addresses this with:

### Atomic Batch Writes

```typescript
// D1 batch — all-or-nothing
await env.DB.batch([
  env.DB.prepare('UPDATE budgets SET gamma = gamma - ?, eta = eta + ?, reserved = reserved - ? WHERE domain = ?')
    .bind(amount, amount, amount, domain),
  env.DB.prepare('INSERT INTO events (id, domain, type, aggregate, payload, actor, ts) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, domain, 'budget.committed', `budget:${domain}`, JSON.stringify({amount}), 'forge-pi', Date.now()),
]);
```

### CHECK Constraints

```sql
CHECK (abs(gamma + eta + reserved - capacity) < 1e-6)
```

This makes conservation violations structurally impossible at the database level.

### Migration Order

1. Create `fleet-events` D1 database
2. Apply schema migration (5 tables)
3. Bind D1 to fleet-budget first, test
4. Bind D1 to forge-pi, test
5. Bind D1 to fleet-event-router, test
6. Demote KV to read cache

See `memory/fable5-d1-design.md` for the complete migration schema.

---

## File Reference

```
forge-pi/
├── src/
│   └── worker.ts        # 548 lines — the entire worker
├── docs/
│   └── DEVELOPER.md     # This file
├── wrangler.toml        # CF bindings (KV, AI, Vectorize)
├── CONTRIBUTING.md
└── LICENSE              # Apache-2.0
```

## Related Documentation

- [Fable 5 D1 Design](../../memory/fable5-d1-design.md) — Complete database schema for v0.2
- [Fleet Topology](../../memory/forge-pi-topology.md) — System map and data flows
- [Fleet Assessment](../../memory/forge-pi-assessment.md) — Honest status of integration maturity
