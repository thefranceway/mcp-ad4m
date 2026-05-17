# mcp-ad4m

AD4M MCP server for Claude Code — 14-tool semantic memory and enforcement layer.

Gives Claude Code persistent memory, cross-session context, and memory hygiene via a locally hosted [AD4M](https://ad4m.dev) executor. All data stays on your machine.

---

## The Problem

Getting AD4M working with Claude Code requires:

- Figuring out the executor port (it reads from `~/.ad4m/executor-port`, not a fixed value)
- Writing a custom MCP server from scratch — none existed
- Re-unlocking the agent on every reboot (no persistence)
- No documented integration path for Claude Code specifically

This server solves all of it. One command sets everything up.

---

## One-Command Install

```bash
git clone https://github.com/thefranceway/mcp-ad4m.git
cd mcp-ad4m
./setup-claude-code.sh --passphrase YOUR_AD4M_PASSPHRASE
```

The script:
- Installs dependencies
- Stores your passphrase in macOS Keychain (not plaintext)
- Installs a `launchd` job that auto-unlocks AD4M on every boot
- Creates a `ClaudeMemory` Perspective and saves the UUID
- Registers the MCP server at user scope via `claude mcp add -s user`

**Requires:** Node.js 18+, AD4M executor running locally, macOS

---

## Tools (14)

| Tool | Description |
|------|-------------|
| `ad4m_agent_status` | DID, initialization state, keystore lock state |
| `ad4m_list_perspectives` | All local Perspectives |
| `ad4m_create_perspective` | Create a new named semantic graph |
| `ad4m_write_memory` | Write a LinkExpression (source → predicate → target) |
| `ad4m_recall` | Query links with optional source/predicate/target filters |
| `ad4m_delete_memory` | Remove links by filter — matched/removed/failed counts |
| `ad4m_classify` | Classify content by layer before writing (env/local/relay/ad4m) |
| `ad4m_config_check` | Detect MCP registration in the wrong config file or scope |
| `ad4m_optimize` | Deduplicate graph, flag stale entries, auto-runs every 10 writes |
| `ad4m_stats` | Total links, duplicate count, breakdown by predicate |
| `ad4m_traverse` | BFS multi-hop graph traversal — returns connected subgraph |
| `ad4m_get_neighbourhood` | Inspect a shared AD4M Neighbourhood |
| `relay_write` | Write cross-terminal live state via AD4M |
| `relay_read` | Read cross-terminal relay messages |

---

## Memory Architecture

AD4M stores information as signed links: `source → predicate → target`.

```
memory://project/zuafrique  →  ad4m://has-content  →  literal://Deployed CF Pages 2026-03-15
franc://session-log         →  franc://closed       →  literal://Session ended
franc://relay/terminal-a    →  franc://relay        →  literal://Build in progress
```

### Layer Taxonomy (enforced by `ad4m_classify`)

| Layer | Where it belongs | Examples |
|-------|-----------------|---------|
| `ad4m` | AD4M semantic graph | Decisions, project facts, cross-session context |
| `env` | `~/.zshrc` | API keys, tokens, credentials |
| `local` | `CLAUDE.md` / `settings.json` | Rules, hooks, permissions |
| `relay` | AD4M relay predicate | Live cross-terminal state |

Run `ad4m_classify` before `ad4m_write_memory` if unsure which layer to use.

---

## Graph Traversal and Reasoning

`ad4m_traverse` exposes the semantic graph structure so Claude can reason over connected facts — not just retrieve individual entries.

**How it works:** Given a starting node URI, it runs a bidirectional BFS, following all links where the node appears as source or target. It expands outward hop by hop up to the requested depth, deduplicates edges, and returns the full subgraph grouped by predicate.

```
ad4m_traverse({
  perspective_uuid: "...",
  node: "memory://feedback/feedback_cloudflare_d1_builds",
  depth: 2
})
```

**Returns:**
```json
{
  "root": "memory://feedback/feedback_cloudflare_d1_builds",
  "depth": 2,
  "node_count": 3,
  "edge_count": 2,
  "by_predicate": {
    "ad4m://has-name": [{ "from": "memory://...", "to": "literal://Cloudflare Worker + D1 build patterns" }],
    "ad4m://has-content": [{ "from": "memory://...", "to": "literal://Always use prepare().run()..." }]
  },
  "summary": "3 connected nodes, 2 edges — 2-hop subgraph"
}
```

**Why this matters:** `ad4m_recall` retrieves flat matches. `ad4m_traverse` returns the connected graph — Claude reads the full subgraph in one call and can derive conclusions, spot conflicts, and surface implications from graph structure alone. No formal logic engine required.

**Depth guidance:**
- `depth: 1` — direct neighbors only (fast)
- `depth: 2` — default, covers most use cases
- `depth: 3–4` — broad context retrieval (more queries, richer output)

---

## Self-Optimization

The graph self-prunes automatically. Every 10 writes from any terminal increments a shared counter stored in AD4M (`franc://optimizer → franc://write-count`). When it hits 10, `ad4m_optimize` runs and removes exact duplicates.

To run manually:

```
ad4m_optimize({ perspective_uuid: "...", dry_run: true })   // report only
ad4m_optimize({ perspective_uuid: "...", dry_run: false })  // remove duplicates
```

---

## Cross-Terminal Relay

Two Claude Code terminals sharing the same AD4M executor can exchange live messages:

**Terminal A:**
```
relay_write({ perspective_uuid: "...", message: "build done", session_id: "terminal-a" })
```

**Terminal B:**
```
relay_read({ perspective_uuid: "...", since: "2026-05-16T00:00:00Z" })
```

---

## Manual Setup (without the script)

**1. Install**

```bash
npm install
```

**2. Register with Claude Code (user scope)**

```bash
claude mcp add -s user ad4m /path/to/mcp-ad4m/index.js \
  --env AD4M_GQL_URL=http://localhost:4000/graphql
```

> **Important:** Always use `-s user`. Without it, `claude mcp add` defaults to project scope and registers the server only for the current directory. Opening Claude Code from any other directory causes the server to silently disappear from `claude mcp list` with no error. See [coasys/ad4m#822](https://github.com/coasys/ad4m/issues/822).

**3. Unlock the agent before each session**

```bash
curl -s http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { agentUnlock(passphrase: \"YOUR_PASSPHRASE\") { isUnlocked } }"}'
```

Or install the launchd job from `launchd/dev.ad4m.auto-unlock.plist` to auto-unlock on boot.

---

## Troubleshooting

**Server missing from `claude mcp list`**

Run `ad4m_config_check` inside Claude Code. It reads `~/.claude.json`, detects whether the server is registered at project scope instead of user scope, and returns the exact command to fix it.

Or check manually:

```bash
claude mcp list   # should show ad4m: ✓ Connected from any directory
```

If it only appears from one directory, re-register at user scope:

```bash
claude mcp remove ad4m
claude mcp add -s user ad4m /path/to/mcp-ad4m/index.js \
  --env AD4M_GQL_URL=http://localhost:4000/graphql
```

---

## Error Messages

The server returns actionable errors:

| Situation | What you see |
|-----------|-------------|
| Executor not running | `AD4M executor not reachable. Start it with: ad4m serve --port 4000` |
| Agent locked | `Agent is locked. Unlock with: curl ...` (exact command included) |
| Server missing from any directory | Registered at project scope — see Troubleshooting above |

---

## Tested On

- macOS 13.3 ARM64 (Apple M1)
- AD4M executor v0.12.x
- Claude Code CLI (Sonnet 4.6)
- Node.js v24

---

## Project Structure

```
mcp-ad4m/
├── index.js              MCP server (14 tools, runs directly with Node)
├── dist/                 Runtime copy (used by wrapper binary)
├── launchd/
│   └── dev.ad4m.auto-unlock.plist
├── setup-claude-code.sh  One-command setup
└── package.json
```

---

## License

MIT
