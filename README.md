# mcp-ad4m

AD4M MCP server for Claude Code — 13-tool semantic memory and enforcement layer.

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
- Builds the TypeScript server
- Stores your passphrase in macOS Keychain (not plaintext)
- Installs a `launchd` job that auto-unlocks AD4M on every boot
- Creates a `ClaudeMemory` Perspective and saves the UUID
- Prints the `settings.json` snippet to paste into Claude Code

**Requires:** Node.js 18+, AD4M executor running locally, macOS

---

## Tools (13)

| Tool | Description |
|------|-------------|
| `ad4m_agent_status` | DID, initialization state, keystore lock state |
| `ad4m_list_perspectives` | All local Perspectives |
| `ad4m_create_perspective` | Create a new named semantic graph |
| `ad4m_write_memory` | Write a LinkExpression (source → predicate → target) |
| `ad4m_recall` | Query links with optional source/predicate/target filters |
| `ad4m_delete_memory` | Remove links by filter — matched/removed/failed counts |
| `ad4m_classify` | Classify content by layer before writing (env/local/relay/ad4m) |
| `ad4m_config_check` | Detect MCP registration in the wrong config file |
| `ad4m_optimize` | Deduplicate graph, flag stale entries, auto-runs every 10 writes |
| `ad4m_stats` | Total links, duplicate count, breakdown by predicate |
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

**1. Build**
```bash
npm install && npm run build
```

**2. Add to `~/.claude/settings.json`**
```json
"ad4m": {
  "command": "/path/to/mcp-ad4m/bin/mcp-ad4m",
  "args": [],
  "env": {
    "AD4M_GQL_URL": "http://localhost:4000/graphql"
  }
}
```

**3. Unlock the agent before each session**
```bash
curl -s http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { agentUnlock(passphrase: \"YOUR_PASSPHRASE\") { isUnlocked } }"}'
```

Or install the launchd job from `launchd/dev.ad4m.auto-unlock.plist` to auto-unlock on boot.

---

## Error Messages

The server returns actionable errors:

| Situation | What you see |
|-----------|-------------|
| Executor not running | `AD4M executor not reachable. Start it with: ad4m serve --port 4000` |
| Agent locked | `Agent is locked. Unlock with: curl ...` (exact command included) |
| Timeout | `fetch failed` with port and URL |

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
├── src/
│   └── index.ts          TypeScript source (13 tools)
├── dist/                 Compiled output (generated by npm run build)
├── launchd/
│   └── dev.ad4m.auto-unlock.plist
├── setup-claude-code.sh  One-command setup
├── package.json
└── tsconfig.json
```

---

## License

MIT
