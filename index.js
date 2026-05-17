#!/usr/bin/env node
/**
 * mcp-ad4m — MCP server wrapping the AD4M local GraphQL API
 *
 * Tools (14):
 *   ad4m_agent_status        → local agent DID + init state
 *   ad4m_list_perspectives   → all Perspectives on executor
 *   ad4m_create_perspective  → create a named Perspective
 *   ad4m_write_memory        → write a LinkExpression (auto-optimizes every 10 writes)
 *   ad4m_recall              → query links by source/predicate/target
 *   ad4m_get_neighbourhood   → read a shared Neighbourhood
 *   ad4m_classify            → classify content by layer (ad4m / local / env / relay)
 *   ad4m_config_check        → detect wrong MCP registration file
 *   ad4m_optimize            → audit + deduplicate memory graph
 *   ad4m_stats               → memory graph statistics
 *   ad4m_traverse            → BFS multi-hop graph traversal — returns connected subgraph
 *   relay_write              → write cross-terminal message via AD4M
 *   ad4m_delete_memory       → remove links by source/predicate/target filter
 *   relay_read               → read cross-terminal messages via AD4M
 */

import { readFileSync } from "fs";
import { homedir }      from "os";
import { join }         from "path";

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Config ─────────────────────────────────────────────────────────────────

function getAD4MPort() {
  try {
    return readFileSync(join(homedir(), ".ad4m", "executor-port"), "utf8").trim();
  } catch {
    return "4000";
  }
}

const AD4M_GQL = process.env.AD4M_GQL_URL ?? `http://localhost:${getAD4MPort()}/graphql`;
const HOME     = homedir();

// ── Taxonomy (policy-as-code) ──────────────────────────────────────────────

const TAXONOMY = {
  env: {
    keywords: ["api_key", "api key", "token", "secret", "passphrase", "password",
                "bearer", "credential", "anthropic_api", "openai_api", "access_token",
                "private_key", "auth_key", "webhook_secret"],
    reason: "Credentials and secrets belong in environment variables (~/.zshrc), never in semantic memory.",
    action:  "Store in ~/.zshrc as export KEY=value. Do NOT write to AD4M.",
  },
  local: {
    keywords: ["gate rule", "routing rule", "hook", "permission", "settings.json",
                "claude.md", "autoMemory", "tool allowlist", "pre-execution",
                "session lifecycle", "stop hook", "study archive", "behavior trace"],
    reason: "Config, rules, and session lifecycle belong in CLAUDE.md or settings.json.",
    action:  "Edit CLAUDE.md or settings.json. Do NOT write to AD4M.",
  },
  relay: {
    keywords: ["current task", "in progress", "right now", "this session",
                "terminal a", "terminal b", "live state", "active build",
                "cross-terminal", "real-time"],
    reason: "Ephemeral cross-terminal state belongs in the relay layer (franc://relay predicate).",
    action:  "Use relay_write / relay_read tools instead of ad4m_write_memory.",
  },
  ad4m: {
    keywords: ["decision", "project", "fact", "who is", "what was built",
                "context", "relationship", "remembered", "learned", "history",
                "zuafrique", "franc", "palm", "agent platform",
                "mcp", "memory", "semantic", "knows", "completed", "deployed"],
    reason:  "Semantic facts, decisions, and cross-session context belong in AD4M.",
    action:  "Use ad4m_write_memory with an appropriate predicate.",
  },
};

function classifyContent(content) {
  const lower = content.toLowerCase();
  for (const [layer, cfg] of Object.entries(TAXONOMY)) {
    if (cfg.keywords.some((kw) => lower.includes(kw))) {
      return { layer, reason: cfg.reason, action: cfg.action };
    }
  }
  return {
    layer:  "ad4m",
    reason: "No exclusion pattern matched — defaulting to semantic memory.",
    action: "Use ad4m_write_memory. If uncertain, run ad4m_classify with more specific content.",
  };
}

// ── Config check ───────────────────────────────────────────────────────────

function readClaudeJson() {
  try {
    return JSON.parse(readFileSync(join(HOME, ".claude.json"), "utf8"));
  } catch {
    return null;
  }
}

function configCheck() {
  const claude = readClaudeJson();
  if (!claude) {
    return {
      status: "missing",
      detail: "~/.claude.json not found.",
      fix_command: `claude mcp add -s user -e AD4M_GQL_URL=${AD4M_GQL} ad4m -- ${HOME}/bin/mcp-ad4m`,
    };
  }

  // Check user scope (top-level mcpServers — correct)
  const topServers = claude?.mcpServers ?? {};
  if (topServers.ad4m) {
    return { status: "ok", detail: "ad4m is registered at user scope — loads from any directory." };
  }

  // Check project scope (loads only from one directory)
  const projServers = claude?.projects?.[HOME]?.mcpServers ?? {};
  if (projServers.ad4m) {
    return {
      status: "wrong_scope",
      detail: "ad4m is registered at project scope. It will only load when Claude Code is opened from " + HOME + ". Re-register at user scope to fix silent failures.",
      fix_command: `claude mcp remove ad4m && claude mcp add -s user -e AD4M_GQL_URL=${AD4M_GQL} ad4m -- ${HOME}/bin/mcp-ad4m`,
    };
  }

  // Check dead-config location
  let inSettingsJson = false;
  try {
    const settings = JSON.parse(readFileSync(join(HOME, ".claude", "settings.json"), "utf8"));
    inSettingsJson = !!settings?.mcpServers?.ad4m;
  } catch { /* ignore */ }

  if (inSettingsJson) {
    return {
      status: "wrong_file",
      detail: "ad4m is in ~/.claude/settings.json which Claude Code IGNORES for MCP registration.",
      fix_command: `claude mcp add -s user -e AD4M_GQL_URL=${AD4M_GQL} ad4m -- ${HOME}/bin/mcp-ad4m`,
    };
  }

  return {
    status: "missing",
    detail: "ad4m is not registered anywhere Claude Code can find it.",
    fix_command: `claude mcp add -s user -e AD4M_GQL_URL=${AD4M_GQL} ad4m -- ${HOME}/bin/mcp-ad4m`,
  };
}

// ── GraphQL helper ─────────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const resp = await fetch(AD4M_GQL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ query, variables }),
    signal:  AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`AD4M HTTP ${resp.status}: ${await resp.text()}`);
  const json = await resp.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

function ok(data)  { return [{ type: "text", text: JSON.stringify(data, null, 2) }]; }
function err(e)    { return [{ type: "text", text: JSON.stringify({ error: String(e) }) }]; }

// ── Optimization loop ──────────────────────────────────────────────────────

const OPTIMIZE_THRESHOLD = 10;
const CTR_SOURCE = "franc://optimizer";
const CTR_PRED   = "franc://write-count";

async function getSharedCount(uuid) {
  const data = await gql(
    `query PerspectiveQueryLinks($uuid: String!, $query: LinkQuery!) {
       perspectiveQueryLinks(uuid: $uuid, query: $query) {
         author timestamp proof { key signature valid invalid }
         data { source predicate target }
       }
     }`,
    { uuid, query: { source: CTR_SOURCE, predicate: CTR_PRED } }
  );
  const links = data.perspectiveQueryLinks;
  return links.length > 0
    ? { link: links[0], count: parseInt(links[0].data.target.replace("literal://", ""), 10) || 0 }
    : { link: null, count: 0 };
}

async function tickWriteCounter(uuid) {
  const { link: old, count } = await getSharedCount(uuid);
  if (old) {
    await gql(
      `mutation PerspectiveRemoveLink($uuid: String!, $link: LinkExpressionInput!) {
         perspectiveRemoveLink(uuid: $uuid, link: $link)
       }`,
      { uuid, link: { author: old.author, timestamp: old.timestamp, proof: old.proof, data: old.data } }
    ).catch(() => {});
  }
  const next = count + 1;
  if (next >= OPTIMIZE_THRESHOLD) {
    optimizePerspective(uuid, false).catch(() => {});
  } else {
    await gql(
      `mutation PerspectiveAddLink($uuid: String!, $link: LinkInput!) {
         perspectiveAddLink(uuid: $uuid, link: $link) { author timestamp }
       }`,
      { uuid, link: { source: CTR_SOURCE, predicate: CTR_PRED, target: `literal://${next}` } }
    ).catch(() => {});
  }
}

async function optimizePerspective(uuid, dryRun = true) {
  const data = await gql(
    `query PerspectiveQueryLinks($uuid: String!, $query: LinkQuery!) {
       perspectiveQueryLinks(uuid: $uuid, query: $query) {
         author timestamp
         proof { key signature valid invalid }
         data { source predicate target }
       }
     }`,
    { uuid, query: {} }
  );

  const links = data.perspectiveQueryLinks;
  const seen  = new Map();
  const duplicates = [];
  const staleFlags = [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (const link of links) {
    const key = `${link.data.source}|${link.data.predicate}|${link.data.target}`;
    if (seen.has(key)) {
      duplicates.push(link);
    } else {
      seen.set(key, link);
      const age = new Date(link.timestamp).getTime();
      if (age < thirtyDaysAgo && link.data.predicate !== "franc://relay") {
        staleFlags.push(link);
      }
    }
  }

  let removed = 0;
  if (!dryRun) {
    for (const link of duplicates) {
      try {
        await gql(
          `mutation PerspectiveRemoveLink($uuid: String!, $link: LinkExpressionInput!) {
             perspectiveRemoveLink(uuid: $uuid, link: $link)
           }`,
          {
            uuid,
            link: {
              author:    link.author,
              timestamp: link.timestamp,
              data:      link.data,
              proof:     link.proof ?? { valid: true, invalid: false },
            },
          }
        );
        removed++;
      } catch { /* skip if removal fails */ }
    }

    if (removed > 0) {
      await gql(
        `mutation PerspectiveAddLink($uuid: String!, $link: LinkInput!) {
           perspectiveAddLink(uuid: $uuid, link: $link) { author timestamp }
         }`,
        {
          uuid,
          link: {
            source:    "franc://optimizer",
            predicate: "franc://ran",
            target:    `literal://Removed ${removed} duplicates on ${new Date().toISOString()}`,
          },
        }
      ).catch(() => {});
    }
  }

  return {
    total:             links.length,
    duplicates_found:  duplicates.length,
    duplicates_removed: removed,
    stale_flagged:     staleFlags.length,
    dry_run:           dryRun,
    report: [
      `Total links: ${links.length}`,
      `Duplicates: ${duplicates.length} ${dryRun ? "(dry run — not removed)" : `(${removed} removed)`}`,
      `Stale (>30 days, non-relay): ${staleFlags.length} flagged`,
    ],
  };
}

// ── Tool handlers ──────────────────────────────────────────────────────────

async function agentStatus() {
  const data = await gql("{ agentStatus { isInitialized isUnlocked did } }");
  return ok(data.agentStatus);
}

async function listPerspectives() {
  const data = await gql("{ perspectives { uuid name sharedUrl state } }");
  return ok(data.perspectives);
}

async function createPerspective({ name }) {
  const data = await gql(
    `mutation PerspectiveAdd($name: String!) {
       perspectiveAdd(name: $name) { uuid name }
     }`,
    { name }
  );
  return ok(data.perspectiveAdd);
}

async function writeMemory({ perspective_uuid, source, predicate = "ad4m://relates", target }) {
  const data = await gql(
    `mutation PerspectiveAddLink($uuid: String!, $link: LinkInput!) {
       perspectiveAddLink(uuid: $uuid, link: $link) {
         author timestamp data { source predicate target }
       }
     }`,
    { uuid: perspective_uuid, link: { source, predicate, target } }
  );

  tickWriteCounter(perspective_uuid).catch(() => {});

  return ok(data.perspectiveAddLink);
}

async function recall({ perspective_uuid, source, predicate, target }) {
  const query = {};
  if (source)    query.source    = source;
  if (predicate) query.predicate = predicate;
  if (target)    query.target    = target;

  const data = await gql(
    `query PerspectiveQueryLinks($uuid: String!, $query: LinkQuery!) {
       perspectiveQueryLinks(uuid: $uuid, query: $query) {
         author timestamp data { source predicate target }
       }
     }`,
    { uuid: perspective_uuid, query }
  );
  return ok(data.perspectiveQueryLinks);
}

async function getNeighbourhood({ uuid }) {
  const data = await gql(
    `query Perspective($uuid: String!) {
       perspective(uuid: $uuid) {
         uuid name sharedUrl neighbourhood { author timestamp }
       }
     }`,
    { uuid }
  );
  return ok(data.perspective);
}

async function classify({ content }) {
  const result = classifyContent(content);
  return ok(result);
}

async function runConfigCheck() {
  return ok(configCheck());
}

async function optimize({ perspective_uuid, dry_run = true }) {
  const result = await optimizePerspective(perspective_uuid, dry_run);
  return ok(result);
}

async function stats({ perspective_uuid }) {
  const data = await gql(
    `query PerspectiveQueryLinks($uuid: String!, $query: LinkQuery!) {
       perspectiveQueryLinks(uuid: $uuid, query: $query) {
         author timestamp data { source predicate target }
       }
     }`,
    { uuid: perspective_uuid, query: {} }
  );

  const links = data.perspectiveQueryLinks;
  const byPredicate = {};
  const seen = new Set();
  let duplicates = 0;

  for (const link of links) {
    const p = link.data.predicate;
    byPredicate[p] = (byPredicate[p] ?? 0) + 1;
    const key = `${link.data.source}|${p}|${link.data.target}`;
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }

  const sorted = [...links].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return ok({
    total:      links.length,
    duplicates,
    by_predicate: byPredicate,
    oldest:     sorted[0]?.timestamp ?? null,
    newest:     sorted[sorted.length - 1]?.timestamp ?? null,
  });
}

async function traverse({ perspective_uuid, node, depth = 2 }) {
  const MAX_DEPTH = Math.min(Math.max(1, depth), 4); // clamp 1–4
  const visited  = new Set([node]);
  const allEdges = new Map(); // deduped by source|predicate|target key
  let   frontier = [node];

  for (let d = 0; d < MAX_DEPTH && frontier.length > 0; d++) {
    const nextFrontier = [];

    for (const current of frontier) {
      // Fetch both directions in parallel
      const [bySource, byTarget] = await Promise.all([
        gql(
          `query Q($uuid: String!, $query: LinkQuery!) {
             perspectiveQueryLinks(uuid: $uuid, query: $query) {
               author timestamp data { source predicate target }
             }
           }`,
          { uuid: perspective_uuid, query: { source: current } }
        ),
        gql(
          `query Q($uuid: String!, $query: LinkQuery!) {
             perspectiveQueryLinks(uuid: $uuid, query: $query) {
               author timestamp data { source predicate target }
             }
           }`,
          { uuid: perspective_uuid, query: { target: current } }
        ),
      ]);

      const links = [
        ...bySource.perspectiveQueryLinks,
        ...byTarget.perspectiveQueryLinks,
      ];

      for (const link of links) {
        const { source, predicate, target } = link.data;
        const key = `${source}|${predicate}|${target}`;
        if (!allEdges.has(key)) {
          allEdges.set(key, { source, predicate, target, timestamp: link.timestamp });
        }
        for (const neighbor of [source, target]) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
          }
        }
      }
    }

    frontier = nextFrontier;
  }

  const edges = [...allEdges.values()];

  // Group by predicate for LLM readability
  const byPredicate = {};
  for (const edge of edges) {
    if (!byPredicate[edge.predicate]) byPredicate[edge.predicate] = [];
    byPredicate[edge.predicate].push({ from: edge.source, to: edge.target });
  }

  return ok({
    root:         node,
    depth:        MAX_DEPTH,
    node_count:   visited.size,
    edge_count:   edges.length,
    subgraph:     edges,
    by_predicate: byPredicate,
    summary: `${visited.size} connected nodes, ${edges.length} edges — ${MAX_DEPTH}-hop subgraph from ${node}`,
  });
}

async function deleteMemory({ perspective_uuid, source, predicate, target }) {
  const query = {};
  if (source)    query.source    = source;
  if (predicate) query.predicate = predicate;
  if (target)    query.target    = target;

  const data = await gql(
    `query PerspectiveQueryLinks($uuid: String!, $query: LinkQuery!) {
       perspectiveQueryLinks(uuid: $uuid, query: $query) {
         author timestamp
         proof { key signature valid invalid }
         data { source predicate target }
       }
     }`,
    { uuid: perspective_uuid, query }
  );

  const links = data.perspectiveQueryLinks;
  let removed = 0;
  let failed  = 0;

  for (const link of links) {
    try {
      const result = await gql(
        `mutation PerspectiveRemoveLink($uuid: String!, $link: LinkExpressionInput!) {
           perspectiveRemoveLink(uuid: $uuid, link: $link)
         }`,
        {
          uuid: perspective_uuid,
          link: {
            author:    link.author,
            timestamp: link.timestamp,
            proof:     link.proof,
            data:      link.data,
          },
        }
      );
      if (result.perspectiveRemoveLink) removed++;
      else failed++;
    } catch {
      failed++;
    }
  }

  return ok({ matched: links.length, removed, failed });
}

async function relayWrite({ perspective_uuid, message, session_id = "default" }) {
  const data = await gql(
    `mutation PerspectiveAddLink($uuid: String!, $link: LinkInput!) {
       perspectiveAddLink(uuid: $uuid, link: $link) {
         author timestamp data { source predicate target }
       }
     }`,
    {
      uuid: perspective_uuid,
      link: {
        source:    `franc://relay/${session_id}`,
        predicate: "franc://relay",
        target:    `literal://${message}`,
      },
    }
  );
  return ok(data.perspectiveAddLink);
}

async function relayRead({ perspective_uuid, session_id, since }) {
  const query = { predicate: "franc://relay" };
  if (session_id) query.source = `franc://relay/${session_id}`;

  const data = await gql(
    `query PerspectiveQueryLinks($uuid: String!, $query: LinkQuery!) {
       perspectiveQueryLinks(uuid: $uuid, query: $query) {
         author timestamp data { source predicate target }
       }
     }`,
    { uuid: perspective_uuid, query }
  );

  let links = data.perspectiveQueryLinks;
  if (since) {
    const cutoff = new Date(since).getTime();
    links = links.filter((l) => new Date(l.timestamp).getTime() > cutoff);
  }
  links.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return ok(
    links.map((l) => ({
      session_id: l.data.source.replace("franc://relay/", ""),
      message:    l.data.target.replace("literal://", ""),
      timestamp:  l.timestamp,
      author:     l.author,
    }))
  );
}

// ── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "mcp-ad4m", version: "2.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ad4m_agent_status",
      description: "Get the local AD4M agent status: DID, initialization state, keystore lock state.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ad4m_list_perspectives",
      description: "List all Perspectives on the local AD4M executor, including joined Neighbourhoods.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ad4m_create_perspective",
      description: "Create a new named Perspective. Returns its UUID for subsequent link operations.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Human-readable name" },
        },
        required: ["name"],
      },
    },
    {
      name: "ad4m_write_memory",
      description: "Write a signed LinkExpression (source → predicate → target) to a Perspective. Use for semantic memories, decisions, and cross-session facts. Auto-optimizes the graph every 10 writes.",
      inputSchema: {
        type: "object",
        properties: {
          perspective_uuid: { type: "string", description: "Target Perspective UUID" },
          source:           { type: "string", description: "Source URI (e.g. 'agent://session/2026-03-22')" },
          predicate:        { type: "string", description: "Predicate URI (e.g. 'ad4m://knows', 'franc://holds')" },
          target:           { type: "string", description: "Target URI or literal (e.g. 'literal://decision text')" },
        },
        required: ["perspective_uuid", "source", "target"],
      },
    },
    {
      name: "ad4m_recall",
      description: "Query links from a Perspective by source, predicate, or target. Omit any field to match all. Returns author DID + timestamp for each match.",
      inputSchema: {
        type: "object",
        properties: {
          perspective_uuid: { type: "string", description: "Perspective UUID to query" },
          source:           { type: "string", description: "Filter by source URI (optional)" },
          predicate:        { type: "string", description: "Filter by predicate URI (optional)" },
          target:           { type: "string", description: "Filter by target URI (optional)" },
        },
        required: ["perspective_uuid"],
      },
    },
    {
      name: "ad4m_get_neighbourhood",
      description: "Read a shared AD4M Neighbourhood by URL. Use to inspect semantic graphs shared with other agents or communities.",
      inputSchema: {
        type: "object",
        properties: {
          uuid: { type: "string", description: "Perspective UUID" },
        },
        required: ["uuid"],
      },
    },
    {
      name: "ad4m_classify",
      description: "Classify a piece of information by which layer it belongs to: ad4m (semantic memory), local (CLAUDE.md/settings), env (credentials), or relay (cross-terminal). Run this BEFORE ad4m_write_memory if unsure where something belongs.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The information or description to classify" },
        },
        required: ["content"],
      },
    },
    {
      name: "ad4m_config_check",
      description: "Check whether the mcp-ad4m server is registered at user scope in ~/.claude.json. Detects project-scope and wrong-file registrations that cause silent failures. Run at session start to verify correct setup.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ad4m_optimize",
      description: "Audit the memory graph for duplicates and stale entries. With dry_run: true (default), reports without deleting. With dry_run: false, removes exact duplicates and logs the optimization as a meta-memory.",
      inputSchema: {
        type: "object",
        properties: {
          perspective_uuid: { type: "string", description: "Perspective UUID to audit" },
          dry_run:          { type: "boolean", description: "If true (default), report only — do not delete" },
        },
        required: ["perspective_uuid"],
      },
    },
    {
      name: "ad4m_stats",
      description: "Memory graph statistics: total links, duplicates, breakdown by predicate, oldest and newest entries.",
      inputSchema: {
        type: "object",
        properties: {
          perspective_uuid: { type: "string", description: "Perspective UUID to inspect" },
        },
        required: ["perspective_uuid"],
      },
    },
    {
      name: "ad4m_traverse",
      description: "Multi-hop graph traversal starting from a node URI. Follows all links where the node appears as source or target, expanding outward to the given depth (default 2, max 4). Returns the full connected subgraph — nodes, edges, and edges grouped by predicate — so Claude can reason over connected facts without requiring formal logic.",
      inputSchema: {
        type: "object",
        properties: {
          perspective_uuid: { type: "string", description: "Perspective UUID to traverse" },
          node:             { type: "string", description: "Starting node URI (e.g. 'memory://feedback/feedback_cloudflare_d1_builds')" },
          depth:            { type: "number", description: "Traversal depth — 1 to 4 hops (default: 2)" },
        },
        required: ["perspective_uuid", "node"],
      },
    },
    {
      name: "ad4m_delete_memory",
      description: "Remove links from a Perspective by source, predicate, and/or target filter. Returns count of matched and removed links. Use to clean up outdated or incorrect memory entries.",
      inputSchema: {
        type: "object",
        properties: {
          perspective_uuid: { type: "string", description: "Perspective UUID to delete from" },
          source:           { type: "string", description: "Filter by source URI (optional)" },
          predicate:        { type: "string", description: "Filter by predicate URI (optional)" },
          target:           { type: "string", description: "Filter by target URI (optional)" },
        },
        required: ["perspective_uuid"],
      },
    },
    {
      name: "relay_write",
      description: "Write a cross-terminal relay message to AD4M. Both Claude Code sessions connect to the same AD4M executor, so this enables real-time state sharing between terminals.",
      inputSchema: {
        type: "object",
        properties: {
          perspective_uuid: { type: "string", description: "Perspective UUID (use ClaudeMemory UUID)" },
          message:          { type: "string", description: "Message to relay" },
          session_id:       { type: "string", description: "Identifier for this terminal/session (default: 'default')" },
        },
        required: ["perspective_uuid", "message"],
      },
    },
    {
      name: "relay_read",
      description: "Read cross-terminal relay messages from AD4M. Optionally filter by session_id or since a timestamp.",
      inputSchema: {
        type: "object",
        properties: {
          perspective_uuid: { type: "string", description: "Perspective UUID (use ClaudeMemory UUID)" },
          session_id:       { type: "string", description: "Filter to a specific terminal/session (optional)" },
          since:            { type: "string", description: "ISO timestamp — only return messages after this time (optional)" },
        },
        required: ["perspective_uuid"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "ad4m_agent_status":       return { content: await agentStatus() };
      case "ad4m_list_perspectives":  return { content: await listPerspectives() };
      case "ad4m_create_perspective": return { content: await createPerspective(args) };
      case "ad4m_write_memory":       return { content: await writeMemory(args) };
      case "ad4m_recall":             return { content: await recall(args) };
      case "ad4m_get_neighbourhood":  return { content: await getNeighbourhood(args) };
      case "ad4m_classify":           return { content: await classify(args) };
      case "ad4m_config_check":       return { content: await runConfigCheck() };
      case "ad4m_optimize":           return { content: await optimize(args) };
      case "ad4m_stats":              return { content: await stats(args) };
      case "ad4m_traverse":           return { content: await traverse(args) };
      case "ad4m_delete_memory":      return { content: await deleteMemory(args) };
      case "relay_write":             return { content: await relayWrite(args) };
      case "relay_read":              return { content: await relayRead(args) };
      default:
        return { content: err(`Unknown tool: ${name}`) };
    }
  } catch (e) {
    return { content: err(e) };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
