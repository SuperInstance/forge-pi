/**
 * Forge-Pi — General-Purpose Agent Runtime at the Edge
 *
 * The orchestrator that bridges all SuperInstance systems:
 * - fleet-edge (dispatch), fleet-budget (conservation), fleet-vector-api (discovery)
 * - A2A-native-notebookLM (cognitive), spreadsheet-engine (computation)
 * - codespace-worker (offload)
 *
 * Every operation enforces γ + η = C.
 * Every message maps to I2I vessel protocol.
 */

interface Env {
  AI: any;
  VECTORIZE: VectorizeIndex;
  FLEET_KV: KVNamespace;
  VERSION: string;
}

// ─── I2I Vessel Protocol ───────────────────────────────────────────

type BottleType = 'I2I:BOTTLE' | 'I2I:SYNTHESIS' | 'I2I:ACK' | 'I2I:CHALLENGE' | 'I2I:CHECKPOINT';

interface I2IBottle {
  type: BottleType;
  id: string;
  from: string;
  to: string;
  timestamp: number;
  payload: Record<string, any>;
  conservation?: { gamma: number; eta: number };
  ttl?: number;
}

// ─── Conservation Budget ───────────────────────────────────────────

interface BudgetState {
  domain: string;
  gamma: number;
  eta: number;
  C: number;
  reserved: number;
  available: number;
}

// ─── Capability Discovery ──────────────────────────────────────────

interface DiscoveredCapability {
  id: string;
  score: number;
  metadata: Record<string, any>;
}

// ─── Request Types ─────────────────────────────────────────────────

interface ForgeRequest {
  query: string;
  domain?: string;
  mode?: 'dispatch' | 'discover' | 'compose' | 'offload';
  budget_limit?: number;
  context?: Record<string, any>;
}

// ─── Helpers ───────────────────────────────────────────────────────

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function error(msg: string, status = 400, details?: any): Response {
  return json({ error: msg, ...(details || {}) }, status);
}

function uid(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Date.now();
}

// ─── I2I Bottle Operations ────────────────────────────────────────

async function dropBottle(env: Env, bottle: I2IBottle): Promise<string> {
  const kvKey = `bottle:${bottle.to}:${bottle.id}`;
  const ttl = bottle.ttl || 3600;
  await env.FLEET_KV.put(kvKey, JSON.stringify(bottle), { expirationTtl: ttl });

  // Add to target's inbox
  const inboxKey = `inbox:${bottle.to}`;
  const raw = await env.FLEET_KV.get(inboxKey);
  const inbox: string[] = raw ? JSON.parse(raw) : [];
  inbox.push(bottle.id);
  await env.FLEET_KV.put(inboxKey, JSON.stringify(inbox.slice(-100)), { expirationTtl: 86400 });

  return bottle.id;
}

async function readBottle(env: Env, target: string, bottleId: string): Promise<I2IBottle | null> {
  const raw = await env.FLEET_KV.get(`bottle:${target}:${bottleId}`);
  return raw ? JSON.parse(raw) : null;
}

async function waitForSynthesis(env: Env, target: string, originalId: string, maxWaitMs = 30000): Promise<I2IBottle | null> {
  const start = now();
  while (now() - start < maxWaitMs) {
    // Check if a SYNTHESIS bottle addressed back to us exists
    const inboxKey = `inbox:forge-pi`;
    const raw = await env.FLEET_KV.get(inboxKey);
    if (raw) {
      const inbox: string[] = JSON.parse(raw);
      for (const id of inbox) {
        const bottle = await readBottle(env, 'forge-pi', id);
        if (bottle && bottle.type === 'I2I:SYNTHESIS' && bottle.payload?.in_response_to === originalId) {
          return bottle;
        }
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

// ─── Conservation Budget ──────────────────────────────────────────

async function getBudget(env: Env, domain: string): Promise<BudgetState> {
  const raw = await env.FLEET_KV.get(`budget:${domain}`);
  if (raw) return JSON.parse(raw);
  const budget: BudgetState = {
    domain,
    gamma: 1000,
    eta: 0,
    C: 1000,
    reserved: 0,
    available: 1000,
  };
  await env.FLEET_KV.put(`budget:${domain}`, JSON.stringify(budget));
  return budget;
}

async function reserveBudget(env: Env, domain: string, amount: number, description: string): Promise<{ ok: boolean; reservation_id?: string; error?: string }> {
  const budget = await getBudget(env, domain);
  if (budget.available < amount) {
    return { ok: false, error: `Insufficient budget: ${budget.available} available, ${amount} requested` };
  }

  budget.reserved += amount;
  budget.available = budget.gamma - budget.reserved;
  await env.FLEET_KV.put(`budget:${domain}`, JSON.stringify(budget));

  const resId = uid();
  await env.FLEET_KV.put(`reserve:${resId}`, JSON.stringify({ id: resId, domain, amount, description, created_at: now() }), { expirationTtl: 3600 });

  return { ok: true, reservation_id: resId };
}

async function commitBudget(env: Env, reservationId: string): Promise<{ ok: boolean; budget?: BudgetState; error?: string }> {
  const raw = await env.FLEET_KV.get(`reserve:${reservationId}`);
  if (!raw) return { ok: false, error: 'Reservation not found' };

  const { domain, amount } = JSON.parse(raw);
  const budget = await getBudget(env, domain);

  budget.gamma -= amount;
  budget.eta += amount;
  budget.reserved -= amount;
  budget.available = budget.gamma - budget.reserved;

  // Validate conservation: γ + η must equal C
  if (Math.abs((budget.gamma + budget.eta) - budget.C) > 0.001) {
    // Rollback
    budget.gamma += amount;
    budget.eta -= amount;
    budget.reserved += amount;
    budget.available = budget.gamma - budget.reserved;
    await env.FLEET_KV.put(`budget:${domain}`, JSON.stringify(budget));
    return { ok: false, error: 'Conservation violation: γ + η ≠ C after commit' };
  }

  await env.FLEET_KV.put(`budget:${domain}`, JSON.stringify(budget));
  await env.FLEET_KV.delete(`reserve:${reservationId}`);
  return { ok: true, budget };
}

async function releaseBudget(env: Env, reservationId: string): Promise<{ ok: boolean }> {
  const raw = await env.FLEET_KV.get(`reserve:${reservationId}`);
  if (!raw) return { ok: false };

  const { domain, amount } = JSON.parse(raw);
  const budget = await getBudget(env, domain);
  budget.reserved -= amount;
  budget.available = budget.gamma - budget.reserved;
  await env.FLEET_KV.put(`budget:${domain}`, JSON.stringify(budget));
  await env.FLEET_KV.delete(`reserve:${reservationId}`);
  return { ok: true };
}

// ─── Capability Discovery ─────────────────────────────────────────

async function discoverCapabilities(env: Env, query: string, topK = 5): Promise<DiscoveredCapability[]> {
  // Embed the query using Workers AI
  const embedResponse = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: [query] });
  const vector = embedResponse.data[0];

  // Search Vectorize
  const results = await env.VECTORIZE.query(vector, { topK, returnMetadata: 'all' });
  return results.matches.map((m: any) => ({
    id: m.id,
    score: m.score,
    metadata: m.metadata || {},
  }));
}

// ─── Agent Routing ────────────────────────────────────────────────

const AGENT_MAP: Record<string, string[]> = {
  'fleet-midi': ['midi', 'music', 'chord', 'harmony', 'audio', 'composition'],
  'ghost-track': ['tracking', 'analytics', 'monitoring', 'metrics', 'telemetry'],
  'persona-engine': ['persona', 'character', 'dialogue', 'voice', 'narrative'],
  'fleet-conductor': ['scheduling', 'orchestration', 'coordination', 'routing'],
  'forgemaster': ['build', 'compile', 'test', 'deploy', 'ci', 'cargo'],
  'oracle2': ['prediction', 'forecast', 'embedding', 'model', 'inference'],
  'construct': ['math', 'sheaf', 'cohomology', 'topology', 'spectral', 'hodge'],
};

function routeToAgent(query: string, capabilities: DiscoveredCapability[]): string {
  const q = query.toLowerCase();
  let bestAgent = 'construct';
  let bestScore = 0;

  for (const [agent, keywords] of Object.entries(AGENT_MAP)) {
    const score = keywords.reduce((s, kw) => s + (q.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestAgent = agent;
    }
  }

  // Also check capability metadata for agent routing hints
  for (const cap of capabilities) {
    const capName = cap.id.toLowerCase();
    for (const [agent, keywords] of Object.entries(AGENT_MAP)) {
      for (const kw of keywords) {
        if (capName.includes(kw)) {
          return agent;
        }
      }
    }
  }

  return bestAgent;
}

// ─── Main Request Handler ─────────────────────────────────────────

async function handleRequest(request: ForgeRequest, env: Env): Promise<Response> {
  const domain = request.domain || 'default';
  const mode = request.mode || 'dispatch';
  const budgetLimit = request.budget_limit || 50;

  // Step 1: Discover relevant capabilities
  const capabilities = await discoverCapabilities(env, request.query, 5);

  if (capabilities.length === 0) {
    return error('No capabilities found for this query', 404);
  }

  // Step 2: Route to best agent
  const targetAgent = routeToAgent(request.query, capabilities);

  // Step 3: Estimate conservation cost
  const gammaCost = 2 + capabilities.length * 0.5; // compute cost
  const etaCost = 1 + request.query.length * 0.01;  // memory cost
  const totalCost = gammaCost + etaCost;

  if (totalCost > budgetLimit) {
    return error('Estimated cost exceeds budget limit', 409, {
      estimated_cost: totalCost,
      budget_limit: budgetLimit,
    });
  }

  // Step 4: Reserve conservation budget
  const reservation = await reserveBudget(env, domain, totalCost, `forge-pi: ${request.query.slice(0, 60)}`);
  if (!reservation.ok || !reservation.reservation_id) {
    return error('Budget reservation failed: ' + reservation.error, 409);
  }

  // Step 5: Execute based on mode
  let result: any;
  try {
    switch (mode) {
      case 'discover':
        result = { mode: 'discover', capabilities, target_agent: targetAgent, cost_estimate: totalCost };
        break;

      case 'dispatch':
        // Drop I2I bottle to target agent
        const bottleId = await dropBottle(env, {
          type: 'I2I:BOTTLE',
          id: uid(),
          from: 'forge-pi',
          to: targetAgent,
          timestamp: now(),
          payload: {
            query: request.query,
            context: request.context,
            discovered_capabilities: capabilities.slice(0, 3),
            hook_point: 'dispatch.query',
          },
          conservation: { gamma: gammaCost, eta: etaCost },
          ttl: 3600,
        });

        result = {
          mode: 'dispatch',
          bottle_id: bottleId,
          target_agent: targetAgent,
          capabilities_used: capabilities.slice(0, 3).map(c => c.id),
          conservation: { gamma: gammaCost, eta: etaCost, total: totalCost },
        };
        break;

      case 'compose':
        // Compose multiple capabilities into a pipeline
        const pipeline = capabilities.slice(0, 3).map((cap, i) => ({
          step: i + 1,
          capability: cap.id,
          score: cap.score,
          agent: routeToAgent(cap.id, [cap]),
        }));

        // Drop bottles to each agent in the pipeline
        const pipelineBottles = [];
        for (const step of pipeline) {
          const bid = await dropBottle(env, {
            type: 'I2I:BOTTLE',
            id: uid(),
            from: 'forge-pi',
            to: step.agent,
            timestamp: now(),
            payload: {
              query: request.query,
              pipeline_step: step.step,
              capability: step.capability,
              hook_point: 'compose.step',
            },
            conservation: { gamma: gammaCost / pipeline.length, eta: etaCost / pipeline.length },
            ttl: 3600,
          });
          pipelineBottles.push(bid);
        }

        result = {
          mode: 'compose',
          pipeline,
          bottle_ids: pipelineBottles,
          conservation: { gamma: gammaCost, eta: etaCost, total: totalCost },
        };
        break;

      case 'offload':
        // Generate codespace-worker command
        result = {
          mode: 'offload',
          command: `codespace-worker SuperInstance/${capabilities[0]?.id || 'unknown'} "cargo test --release"`,
          target_capability: capabilities[0]?.id,
          conservation: { gamma: gammaCost, eta: etaCost, total: totalCost },
          note: 'Execute this command locally. Results will be tracked via I2I CHECKPOINT.',
        };
        break;

      default:
        return error(`Unknown mode: ${mode}`, 400);
    }

    // Step 6: Commit the conservation budget
    const commit = await commitBudget(env, reservation.reservation_id);
    if (!commit.ok) {
      // Release if commit failed (conservation violation)
      await releaseBudget(env, reservation.reservation_id);
      return error('Conservation commit failed: ' + commit.error, 500);
    }

    // Step 7: Log the operation
    await env.FLEET_KV.put(
      `log:${uid()}`,
      JSON.stringify({
        timestamp: now(),
        domain,
        mode,
        query: request.query.slice(0, 100),
        target_agent: targetAgent,
        capabilities: capabilities.slice(0, 3).map(c => c.id),
        conservation: { gamma: gammaCost, eta: etaCost },
        budget_after: commit.budget,
      }),
      { expirationTtl: 604800 }
    );

    return json({
      ok: true,
      ...result,
      conservation_valid: true,
    });
  } catch (err: any) {
    // Rollback budget on any error
    await releaseBudget(env, reservation.reservation_id);
    return error(`Execution failed: ${err.message}`, 500);
  }
}

// ─── Scheduled Handler (Cron) ─────────────────────────────────────

async function handleScheduled(env: Env): Promise<void> {
  // Clean up stale bottles (older than 1 hour)
  const list = await env.FLEET_KV.list({ prefix: 'bottle:' });
  const cutoff = now() - 3600000;
  let cleaned = 0;

  for (const key of list.keys) {
    const raw = await env.FLEET_KV.get(key.name);
    if (raw) {
      const bottle: I2IBottle = JSON.parse(raw);
      if (bottle.timestamp < cutoff) {
        await env.FLEET_KV.delete(key.name);
        cleaned++;
      }
    }
  }

  // Log cleanup
  await env.FLEET_KV.put(
    `cron:cleanup:${now()}`,
    JSON.stringify({ cleaned, checked: list.keys.length }),
    { expirationTtl: 86400 }
  );
}

// ─── Export ────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Health
    if (path === '/health') {
      return json({ status: 'ok', service: 'forge-pi', version: env.VERSION });
    }

    // Status — show fleet overview
    if (path === '/status') {
      const budget = await getBudget(env, 'default');
      return json({
        service: 'forge-pi',
        version: env.VERSION,
        default_budget: budget,
        agents: Object.keys(AGENT_MAP),
        conservation_law: 'γ + η = C',
      });
    }

    // Main forge endpoint
    if (path === '/forge' && request.method === 'POST') {
      const body = await request.json() as ForgeRequest;
      if (!body.query) return error('query required', 400);
      return handleRequest(body, env);
    }

    // Discover capabilities
    if (path === '/discover' && request.method === 'POST') {
      const { query } = await request.json() as { query: string };
      if (!query) return error('query required', 400);
      const caps = await discoverCapabilities(env, query, 10);
      return json({ query, capabilities: caps });
    }

    // Read I2I bottle
    const bottleMatch = path.match(/^\/bottle\/([^/]+)\/([^/]+)$/);
    if (bottleMatch && request.method === 'GET') {
      const bottle = await readBottle(env, bottleMatch[1], bottleMatch[2]);
      if (!bottle) return error('Bottle not found', 404);
      return json(bottle);
    }

    // Drop a raw I2I bottle
    if (path === '/bottle' && request.method === 'POST') {
      const bottle = await request.json() as I2IBottle;
      if (!bottle.type || !bottle.to) return error('type and to required', 400);
      bottle.id = bottle.id || uid();
      bottle.timestamp = bottle.timestamp || now();
      bottle.from = bottle.from || 'forge-pi';
      const id = await dropBottle(env, bottle);
      return json({ ok: true, bottle_id: id }, 201);
    }

    // Budget endpoints
    if (path === '/budget' && request.method === 'GET') {
      const domain = url.searchParams.get('domain') || 'default';
      return json(await getBudget(env, domain));
    }

    // Index
    if (path === '/') {
      return json({
        service: 'forge-pi',
        version: env.VERSION,
        description: 'General-purpose agent runtime at the edge',
        endpoints: [
          'POST /forge {query, domain, mode, budget_limit}',
          'POST /discover {query}',
          'POST /bottle {I2I bottle}',
          'GET  /bottle/:target/:id',
          'GET  /budget?domain=',
          'GET  /status',
          'GET  /health',
        ],
        modes: ['dispatch', 'discover', 'compose', 'offload'],
        conservation: 'γ + η = C',
      });
    }

    return error('Not Found', 404);
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    await handleScheduled(env);
  },
};
