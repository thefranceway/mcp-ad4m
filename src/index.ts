#!/usr/bin/env node
/**
 * mcp-ad4m — MCP server wrapping the AD4M local GraphQL API
 * 13 tools: status, perspectives, memory CRUD, classify, config-check,
 *           optimize, stats, relay, and cross-terminal write counter.
 */

import { McpServer }          from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z }                  from "zod";
import { readFileSync }       from "fs";
import { homedir }            from "os";
import { join }               from "path";

// ── Config ─────────────────────────────────────────────────────────────────

function getAD4MPort(): string {
  try { return readFileSync(join(homedir(), ".ad4m", "executor-port"), "utf8").trim(); }
  catch { return "4000"; }
}

const AD4M_GQL = process.env.AD4M_GQL_URL ?? `http://localhost:${getAD4MPort()}/graphql`;
const HOME     = homedir();

// ── Taxonomy ───────────────────────────────────────────────────────────────

type Layer = "env" | "local" | "relay" | "ad4m";

interface LayerRule {
  keywords: string[];
  reason:   string;
  action:   string;
}

const TAXONOMY: Record<Layer, LayerRule> = {
  env: {
    keywords: ["api_key","api key","token","secret","passphrase","password",
                "bearer","credential","anthropic_api","openai_api","access_token",
                "private_key","auth_key","webhook_secret"],
    reason: "Credentials and secrets belong in environment variables (~/.zshrc), never in semantic memory.",
    action:  "Store in ~/.zshrc as export KEY=value. Do NOT write to AD4M.",
  },
  local: {
    keywords: ["gate rule","routing rule","hook","permission","settings.json",
                "claude.md","autoMemory","tool allowlist","pre-execution",
                "session lifecycle","stop hook","study archive","behavior trace"],
    reason: "Config, rules, and session lifecycle belong in CLAUDE.md or settings.json.",
    action:  "Edit CLAUDE.md or settings.json. Do NOT write to AD4M.",
  },
  relay: {
    keywords: ["current task","in progress","right now","this session",
                "terminal a","terminal b","live state","active build",
                "cross-terminal","real-time"],
    reason: "Ephemeral cross-terminal state belongs in the relay layer (franc://relay predicate).",
    action:  "Use relay_write / relay_read tools instead of ad4m_write_memory.",
  },
  ad4m: {
    keywords: ["decision","project","fact","who is","what was built",
                "context","relationship","remembered","learned","history",
                "zuafrique","franc","palm","aurasci","agent platform",
                "mcp","memory","semantic","knows","completed","deployed"],
    reason:  "Semantic facts, decisions, and cross-session context belong in AD4M.",
    action:  "Use ad4m_write_memory with an appropriate predicate.",
  },
};

function classifyContent(content: string): { layer: Layer; reason: string; action: string } {
  const lower = content.toLowerCase();
  for (const [layer, cfg] of Object.entries(TAXONOMY) as [Layer, LayerRule][]) {
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

interface ClaudeJson {
  projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
  mcpServers?: Record<string, unknown>;
}

function configCheck(): { status: string; detail: string; fix_command?: string } {
  let claude: ClaudeJson | null = null;
  try { claude = JSON.parse(readFileSync(join(HOME, ".claude.json"), "utf8")); }
  catch { /* missing */ }

  if (!claude) {
    return {
      status: "missing",
      detail: "~/.claude.json not found.",
      fix_command: `claude mcp add -e AD4M_GQL_URL=${AD4M_GQL} ad4m -- ${HOME}/bin/mcp-ad4m`,
    };
  }
  if (claude.projects?.[HOME]?.mcpServers?.["ad4m"]) {
    return { status: "ok", detail: "ad4m is registered in the correct project-scoped location." };
  }
  if (claude.mcpServers?.["ad4m"]) {
    return { status: "ok", detail: "ad4m is registered at user scope (top-level)." };
  }
  let inSettingsJson = false;
  try {
    const s = JSON.parse(readFileSync(join(HOME, ".claude", "settings.json"), "utf8"));
    inSettingsJson = !!(s?.mcpServers?.["ad4m"]);
  } catch { /* ignore */ }
  if (inSettingsJson) {
    return {
      status: "wrong_file",
      detail: "ad4m is in ~/.claude/settings.json which Claude Code IGNORES for MCP registration.",
      fix_command: `claude mcp add -e AD4M_GQL_URL=${AD4M_GQL} ad4m -- ${HOME}/bin/mcp-ad4m`,
    };
  }
  return {
    status: "missing",
    detail: "ad4m is not registered anywhere Claude Code can find it.",
    fix_command: `claude mcp add -e AD4M_GQL_URL=${AD4M_GQL} ad4m -- ${HOME}/bin/mcp-ad4m`,
  };
}

// ── GraphQL helper ─────────────────────────────────────────────────────────

interface LinkData   { source: string; predicate: string; target: string; }
interface LinkProof  { key: string; signature: string; valid: boolean; invalid: boolean; }
interface LinkExpr   { author: string; timestamp: string; data: LinkData; proof: LinkProof; }
interface GqlResult  { [key: string]: unknown; }

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<GqlResult> {
  const resp = await fetch(AD4M_GQL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ query, variables }),
    signal:  AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`AD4M HTTP ${resp.status}: ${await resp.text()}`);
  const json = await resp.json() as { data?: GqlResult; errors?: { message: string }[] };
  if (json.errors?.length) {
    const msg = json.errors[0].message;
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      throw new Error("AD4M executor not reachable. Start it with: ad4m serve --port 4000");
    }
    if (msg.includes("Unauthorized") || msg.includes("not unlocked")) {
      throw new Error(`Agent is locked. Unlock with:\ncurl -X POST ${AD4M_GQL} -H 'Content-Type: application/json' -d '{"query":"mutation { agentUnlock(passphrase: \\"YOUR_PASSPHRASE\\") { isUnlocked } }"}'`);
    }
    throw new Error(msg);
  }
  return json.data ?? {};
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ── Shared cross-terminal write counter ────────────────────────────────────

const OPTIMIZE_THRESHOLD = 10;
const CTR_SOURCE = "franc://optimizer";
const CTR_PRED   = "franc://write-count";

const LINKS_WITH_PROOF = `
  author timestamp
  proof { key signature valid invalid }
  data { source predicate target }
`;

async function getSharedCount(uuid: string): Promise<{ link: LinkExpr | null; count: number }> {
  const data = await gql(
    `query Q($uuid: String!, $q: LinkQuery!) {
       perspectiveQueryLinks(uuid: $uuid, query: $q) { ${LINKS_WITH_PROOF} }
     }`,
    { uuid, q: { source: CTR_SOURCE, predicate: CTR_PRED } }
  );
  const links = data.perspectiveQueryLinks as LinkExpr[];
  if (!links?.length) return { link: null, count: 0 };
  const count = parseInt((links[0].data.target ?? "").replace("literal://", ""), 10) || 0;
  return { link: links[0], count };
}

async function removeLink(uuid: string, link: LinkExpr): Promise<boolean> {
  const result = await gql(
    `mutation R($uuid: String!, $link: LinkExpressionInput!) {
       perspectiveRemoveLink(uuid: $uuid, link: $link)
     }`,
    { uuid, link: { author: link.author, timestamp: link.timestamp, proof: link.proof, data: link.data } }
  );
  return !!(result.perspectiveRemoveLink);
}

async function tickWriteCounter(uuid: string): Promise<void> {
  const { link: old, count } = await getSharedCount(uuid);
  if (old) await removeLink(uuid, old).catch(() => {});
  const next = count + 1;
  if (next >= OPTIMIZE_THRESHOLD) {
    optimizePerspective(uuid, false).catch(() => {});
  } else {
    await gql(
      `mutation A($uuid: String!, $link: LinkInput!) {
         perspectiveAddLink(uuid: $uuid, link: $link) { author timestamp }
       }`,
      { uuid, link: { source: CTR_SOURCE, predicate: CTR_PRED, target: `literal://${next}` } }
    ).catch(() => {});
  }
}

// ── Optimize ───────────────────────────────────────────────────────────────

async function optimizePerspective(uuid: string, dryRun: boolean): Promise<{
  total: number; duplicates_found: number; duplicates_removed: number;
  stale_flagged: number; dry_run: boolean; report: string[];
}> {
  const data = await gql(
    `query Q($uuid: String!, $q: LinkQuery!) {
       perspectiveQueryLinks(uuid: $uuid, query: $q) { ${LINKS_WITH_PROOF} }
     }`,
    { uuid, q: {} }
  );
  const links = data.perspectiveQueryLinks as LinkExpr[];
  const seen  = new Map<string, LinkExpr>();
  const duplicates: LinkExpr[] = [];
  const staleFlags: LinkExpr[] = [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (const link of links) {
    const key = `${link.data.source}|${link.data.predicate}|${link.data.target}`;
    if (seen.has(key)) {
      duplicates.push(link);
    } else {
      seen.set(key, link);
      if (new Date(link.timestamp).getTime() < thirtyDaysAgo && link.data.predicate !== "franc://relay") {
        staleFlags.push(link);
      }
    }
  }

  let removed = 0;
  if (!dryRun) {
    for (const link of duplicates) {
      try { if (await removeLink(uuid, link)) removed++; } catch { /* skip */ }
    }
    if (removed > 0) {
      await gql(
        `mutation A($uuid: String!, $link: LinkInput!) {
           perspectiveAddLink(uuid: $uuid, link: $link) { author timestamp }
         }`,
        { uuid, link: { source: "franc://optimizer", predicate: "franc://ran",
            target: `literal://Removed ${removed} duplicates on ${new Date().toISOString()}` } }
      ).catch(() => {});
    }
  }

  return {
    total: links.length, duplicates_found: duplicates.length,
    duplicates_removed: removed, stale_flagged: staleFlags.length, dry_run: dryRun,
    report: [
      `Total links: ${links.length}`,
      `Duplicates: ${duplicates.length} ${dryRun ? "(dry run — not removed)" : `(${removed} removed)`}`,
      `Stale (>30 days, non-relay): ${staleFlags.length} flagged`,
    ],
  };
}

// ── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({ name: "mcp-ad4m", version: "2.0.0" });

// 1. ad4m_agent_status
server.tool("ad4m_agent_status",
  "Get the local AD4M agent status: DID, initialization state, keystore lock state.",
  {},
  async () => {
    const data = await gql("{ agentStatus { isInitialized isUnlocked did } }");
    return ok(data.agentStatus);
  }
);

// 2. ad4m_list_perspectives
server.tool("ad4m_list_perspectives",
  "List all Perspectives on the local AD4M executor.",
  {},
  async () => {
    const data = await gql("{ perspectives { uuid name sharedUrl state } }");
    return ok(data.perspectives);
  }
);

// 3. ad4m_create_perspective
server.tool("ad4m_create_perspective",
  "Create a new named Perspective. Returns its UUID for subsequent link operations.",
  { name: z.string().describe("Human-readable name for the Perspective") },
  async ({ name }) => {
    const data = await gql(
      `mutation M($name: String!) { perspectiveAdd(name: $name) { uuid name } }`,
      { name }
    );
    return ok(data.perspectiveAdd);
  }
);

// 4. ad4m_write_memory
server.tool("ad4m_write_memory",
  "Write a signed LinkExpression (source → predicate → target) to a Perspective. Auto-optimizes the graph every 10 writes across all terminals.",
  {
    perspective_uuid: z.string().describe("Target Perspective UUID"),
    source:           z.string().describe("Source URI — e.g. 'agent://session/2026-03-22'"),
    predicate:        z.string().optional().describe("Predicate URI — e.g. 'ad4m://knows' (default: ad4m://relates)"),
    target:           z.string().describe("Target URI or literal — e.g. 'literal://decision text'"),
  },
  async ({ perspective_uuid, source, predicate = "ad4m://relates", target }) => {
    const data = await gql(
      `mutation M($uuid: String!, $link: LinkInput!) {
         perspectiveAddLink(uuid: $uuid, link: $link) {
           author timestamp data { source predicate target }
         }
       }`,
      { uuid: perspective_uuid, link: { source, predicate, target } }
    );
    tickWriteCounter(perspective_uuid).catch(() => {});
    return ok(data.perspectiveAddLink);
  }
);

// 5. ad4m_recall
server.tool("ad4m_recall",
  "Query links from a Perspective by source, predicate, or target. Omit any field to match all.",
  {
    perspective_uuid: z.string().describe("Perspective UUID to query"),
    source:           z.string().optional().describe("Filter by source URI"),
    predicate:        z.string().optional().describe("Filter by predicate URI"),
    target:           z.string().optional().describe("Filter by target URI"),
  },
  async ({ perspective_uuid, source, predicate, target }) => {
    const query: Record<string, string> = {};
    if (source)    query.source    = source;
    if (predicate) query.predicate = predicate;
    if (target)    query.target    = target;
    const data = await gql(
      `query Q($uuid: String!, $q: LinkQuery!) {
         perspectiveQueryLinks(uuid: $uuid, query: $q) {
           author timestamp data { source predicate target }
         }
       }`,
      { uuid: perspective_uuid, q: query }
    );
    return ok(data.perspectiveQueryLinks);
  }
);

// 6. ad4m_get_neighbourhood
server.tool("ad4m_get_neighbourhood",
  "Read a shared AD4M Neighbourhood by Perspective UUID.",
  { uuid: z.string().describe("Perspective UUID") },
  async ({ uuid }) => {
    const data = await gql(
      `query Q($uuid: String!) {
         perspective(uuid: $uuid) {
           uuid name sharedUrl neighbourhood { author timestamp }
         }
       }`,
      { uuid }
    );
    return ok(data.perspective);
  }
);

// 7. ad4m_classify
server.tool("ad4m_classify",
  "Classify a piece of information by which layer it belongs to: ad4m, local, env, or relay. Run this BEFORE ad4m_write_memory if unsure.",
  { content: z.string().describe("The information or description to classify") },
  async ({ content }) => ok(classifyContent(content))
);

// 8. ad4m_config_check
server.tool("ad4m_config_check",
  "Check whether mcp-ad4m is registered in the correct config file. Detects the wrong-file misconfiguration that causes silent connection failures.",
  {},
  async () => ok(configCheck())
);

// 9. ad4m_optimize
server.tool("ad4m_optimize",
  "Audit the memory graph for duplicates and stale entries. dry_run: true (default) reports without deleting.",
  {
    perspective_uuid: z.string().describe("Perspective UUID to audit"),
    dry_run:          z.boolean().optional().describe("If true (default), report only — do not delete"),
  },
  async ({ perspective_uuid, dry_run = true }) => {
    const result = await optimizePerspective(perspective_uuid, dry_run);
    return ok(result);
  }
);

// 10. ad4m_stats
server.tool("ad4m_stats",
  "Memory graph statistics: total links, duplicates, breakdown by predicate, oldest and newest entries.",
  { perspective_uuid: z.string().describe("Perspective UUID to inspect") },
  async ({ perspective_uuid }) => {
    const data = await gql(
      `query Q($uuid: String!, $q: LinkQuery!) {
         perspectiveQueryLinks(uuid: $uuid, query: $q) {
           author timestamp data { source predicate target }
         }
       }`,
      { uuid: perspective_uuid, q: {} }
    );
    const links = data.perspectiveQueryLinks as LinkExpr[];
    const byPredicate: Record<string, number> = {};
    const seen = new Set<string>();
    let duplicates = 0;
    for (const link of links) {
      const p = link.data.predicate;
      byPredicate[p] = (byPredicate[p] ?? 0) + 1;
      const key = `${link.data.source}|${p}|${link.data.target}`;
      if (seen.has(key)) duplicates++;
      else seen.add(key);
    }
    const sorted = [...links].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return ok({
      total: links.length, duplicates, by_predicate: byPredicate,
      oldest: sorted[0]?.timestamp ?? null,
      newest: sorted[sorted.length - 1]?.timestamp ?? null,
    });
  }
);

// 11. ad4m_delete_memory
server.tool("ad4m_delete_memory",
  "Remove links from a Perspective by source, predicate, and/or target filter. Returns matched/removed/failed counts.",
  {
    perspective_uuid: z.string().describe("Perspective UUID to delete from"),
    source:           z.string().optional().describe("Filter by source URI"),
    predicate:        z.string().optional().describe("Filter by predicate URI"),
    target:           z.string().optional().describe("Filter by target URI"),
  },
  async ({ perspective_uuid, source, predicate, target }) => {
    const query: Record<string, string> = {};
    if (source)    query.source    = source;
    if (predicate) query.predicate = predicate;
    if (target)    query.target    = target;
    const data = await gql(
      `query Q($uuid: String!, $q: LinkQuery!) {
         perspectiveQueryLinks(uuid: $uuid, query: $q) { ${LINKS_WITH_PROOF} }
       }`,
      { uuid: perspective_uuid, q: query }
    );
    const links = data.perspectiveQueryLinks as LinkExpr[];
    let removed = 0, failed = 0;
    for (const link of links) {
      try { if (await removeLink(perspective_uuid, link)) removed++; else failed++; }
      catch { failed++; }
    }
    return ok({ matched: links.length, removed, failed });
  }
);

// 12. relay_write
server.tool("relay_write",
  "Write a cross-terminal relay message to AD4M. Both terminals share the same AD4M executor so state is immediately visible.",
  {
    perspective_uuid: z.string().describe("Perspective UUID (use ClaudeMemory UUID)"),
    message:          z.string().describe("Message to relay"),
    session_id:       z.string().optional().describe("Terminal/session identifier (default: 'default')"),
  },
  async ({ perspective_uuid, message, session_id = "default" }) => {
    const data = await gql(
      `mutation M($uuid: String!, $link: LinkInput!) {
         perspectiveAddLink(uuid: $uuid, link: $link) {
           author timestamp data { source predicate target }
         }
       }`,
      { uuid: perspective_uuid, link: {
          source:    `franc://relay/${session_id}`,
          predicate: "franc://relay",
          target:    `literal://${message}`,
        }
      }
    );
    return ok(data.perspectiveAddLink);
  }
);

// 13. relay_read
server.tool("relay_read",
  "Read cross-terminal relay messages from AD4M. Optionally filter by session_id or since a timestamp.",
  {
    perspective_uuid: z.string().describe("Perspective UUID (use ClaudeMemory UUID)"),
    session_id:       z.string().optional().describe("Filter to a specific terminal/session"),
    since:            z.string().optional().describe("ISO timestamp — only return messages after this time"),
  },
  async ({ perspective_uuid, session_id, since }) => {
    const query: Record<string, string> = { predicate: "franc://relay" };
    if (session_id) query.source = `franc://relay/${session_id}`;
    const data = await gql(
      `query Q($uuid: String!, $q: LinkQuery!) {
         perspectiveQueryLinks(uuid: $uuid, query: $q) {
           author timestamp data { source predicate target }
         }
       }`,
      { uuid: perspective_uuid, q: query }
    );
    let links = data.perspectiveQueryLinks as LinkExpr[];
    if (since) {
      const cutoff = new Date(since).getTime();
      links = links.filter((l) => new Date(l.timestamp).getTime() > cutoff);
    }
    links.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return ok(links.map((l) => ({
      session_id: l.data.source.replace("franc://relay/", ""),
      message:    l.data.target.replace("literal://", ""),
      timestamp:  l.timestamp,
      author:     l.author,
    })));
  }
);

// ── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
