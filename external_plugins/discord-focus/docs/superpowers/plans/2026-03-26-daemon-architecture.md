# Daemon Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the monolithic Discord MCP server into a persistent daemon (holds Discord gateway) and thin MCP proxy (per-session), enabling multiple concurrent Claude Code sessions with different channel focuses.

**Architecture:** Daemon process holds the Discord gateway and listens on a Unix socket. Each session's MCP server connects to the daemon, subscribes to channels, and proxies tool calls. Shared types and access.json logic live in a common module.

**Tech Stack:** TypeScript, Bun (Unix socket server/client), discord.js, MCP SDK

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `shared.ts` | Types (Access, IPC messages), constants, loadAccess/saveAccess, channel alias resolution | New |
| `daemon.ts` | Discord gateway, gate(), handleInbound(), outbound tool execution, Unix socket server, subscription management | New |
| `server.ts` | MCP server, thin proxy to daemon via socket, focus_channels tool | Rewrite |

---

### Task 0: Create shared.ts - Types and Access Loader

**Files:**
- Create: `shared.ts`

This extracts shared code from server.ts into a module used by both daemon.ts and server.ts.

- [ ] **Step 1: Create shared.ts with types, constants, and access loader**

Create `shared.ts` with:
- All state path constants (STATE_DIR, ACCESS_FILE, APPROVED_DIR, ENV_FILE, INBOX_DIR, DAEMON_SOCK, DAEMON_PID)
- loadEnvFile() helper
- All Access-related types (PendingEntry, GroupPolicy, Access)
- defaultAccess(), readAccessFile(), loadAccess(), saveAccess()
- Channel alias resolution: resolveAlias(), resolveAliases()
- loadFocusChannels() with alias support
- IPC message types: IpcToServer, IpcToDaemon
- Utility functions: pruneExpired(), chunk(), assertSendable()
- channelAliases field added to Access type

See the design spec for the full Access type including the new `channelAliases?: Record<string, string>` field.

The IPC types encode the full protocol:

IpcToDaemon (session to daemon):
- subscribe: register session with channel focus
- focus: change channel focus at runtime
- unsubscribe: disconnect session
- tool: proxy a tool call (reply, react, edit_message, fetch_messages, download_attachment)
- permission_request: forward permission request from Claude to Discord

IpcToServer (daemon to session):
- ready: daemon connected, lists available channels
- message: inbound Discord message
- permission_reply: user responded to permission request
- tool_result: successful tool call result
- tool_error: failed tool call error
- error: general error

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/SpaceShipOS/dev/claude-plugins/external_plugins/discord-focus && bun build --target=bun shared.ts --outdir=/tmp/bun-build-test
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add shared.ts
git commit -m "refactor: extract shared types, access loader, and IPC protocol to shared.ts"
```

---

### Task 1: Create daemon.ts - Discord Gateway and Socket Server

**Files:**
- Create: `daemon.ts`

The daemon holds the Discord gateway connection, manages per-session subscriptions via Unix socket, routes inbound messages to subscribed sessions, and runs outbound tool calls on behalf of sessions.

Key responsibilities:
1. Write PID file on start, clean up PID + socket on exit
2. Connect Discord client (same gateway setup as today)
3. Listen on Unix socket at DAEMON_SOCK
4. Track sessions: Map of sessionId to { channels: Set, send: function }
5. gate() and handleInbound() - same logic as today, but instead of MCP notification, route to subscribed sessions
6. gate() returns channelId in deliver result so daemon can match against session subscriptions
7. executeTool() - same tool execution as today's CallToolRequestSchema handler, but takes sessionFocus as parameter for outbound filtering
8. fetchAllowedChannel() takes optional sessionFocus parameter instead of using global loadFocusChannels()
9. Permission request handling (button interactions) forwarded to all sessions
10. Socket disconnect removes session subscriptions

Important implementation details:
- Track socket-to-sessionId mapping for cleanup on socket close
- Buffer partial JSON lines on socket (messages are newline-delimited JSON)
- resolveAliases() called on subscribe/focus messages
- Daemon logs to stderr (same convention as current server.ts)

The gate() function is identical to today except:
- It does NOT check focusChannels (that's per-session now, handled during routing)
- It returns channelId in the deliver result for routing

Message routing after gate():
1. gate() returns deliver with channelId
2. Iterate all sessions
3. For each session where session.channels.has(channelId): send message
4. If no session matched: log and drop

- [ ] **Step 1: Create daemon.ts with all Discord logic and socket server**

The implementer should read the current server.ts lines 1-929 and the design spec, then create daemon.ts moving all Discord-specific code there. The Unix socket server uses Bun.listen with unix option.

- [ ] **Step 2: Verify it compiles**

```bash
cd ~/SpaceShipOS/dev/claude-plugins/external_plugins/discord-focus && bun build --target=bun daemon.ts --outdir=/tmp/bun-build-test
```

- [ ] **Step 3: Commit**

```bash
git add daemon.ts
git commit -m "feat: add daemon.ts - Discord gateway with socket-based session routing"
```

---

### Task 2: Rewrite server.ts - MCP Proxy to Daemon

**Files:**
- Rewrite: `server.ts`

The MCP server becomes a thin proxy. On start it ensures the daemon is running (auto-start if needed), connects via Unix socket, subscribes with initial focus channels, and proxies all tool calls through the daemon.

Key responsibilities:
1. Generate random SESSION_ID on start
2. ensureDaemon(): check PID file, start daemon if needed, wait for socket
3. connectToDaemon(): connect to Unix socket, subscribe with focus channels
4. MCP tool handler: for each tool call, send IPC message to daemon, wait for result
5. New focus_channels tool: sends IPC focus message to daemon
6. Forward permission_request notifications to daemon
7. On shutdown: send unsubscribe to daemon

Daemon auto-start logic:
1. Check daemon.pid exists and process is alive (process.kill(pid, 0))
2. If not: spawn daemon.ts as detached child, wait up to 10s for socket
3. Connect to socket, send subscribe message

Initial focus channel resolution (in priority order):
1. DISCORD_FOCUS_CHANNELS env var (comma-separated, alias-resolved)
2. access.json focusChannels (alias-resolved)
3. Empty array (no focus = daemon drops messages for this session)

Tool call proxying:
1. Generate unique callId
2. Send { type: 'tool', sessionId, callId, call: { name, args } } to daemon
3. Wait for { type: 'tool_result', callId } or { type: 'tool_error', callId }
4. Timeout after 30s
5. Return MCP response

focus_channels tool:
1. Resolve aliases
2. Send { type: 'focus', sessionId, channels } to daemon
3. Return confirmation text

The MCP server setup (capabilities, instructions) stays the same. Add one line to instructions mentioning focus_channels tool.

- [ ] **Step 1: Rewrite server.ts as daemon proxy**

The implementer should create the new server.ts importing from shared.ts, with daemon connection management, IPC client, and MCP proxy logic as described above.

- [ ] **Step 2: Verify both files compile**

```bash
cd ~/SpaceShipOS/dev/claude-plugins/external_plugins/discord-focus && bun build --target=bun server.ts --outdir=/tmp/bun-build-test && bun build --target=bun daemon.ts --outdir=/tmp/bun-build-test2
```

Expected: no errors for either.

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "feat: rewrite server.ts as thin MCP proxy to daemon with focus_channels tool"
```

---

### Task 3: Add channelAliases to access skill and docs

**Files:**
- Modify: `skills/access/SKILL.md`
- Modify: `ACCESS.md`
- Modify: `README.md`

- [ ] **Step 1: Update skills/access/SKILL.md**

Add after the `focus clear` section:

```markdown
### `alias <name> <channelId>`

1. Read `~/.claude/channels/discord/access.json` (create default if missing).
2. Validate the channel ID looks like a snowflake (numeric string).
3. Set `channelAliases[name] = channelId`.
4. Write back.
5. Confirm: "Alias set: name -> channelId"

### `alias rm <name>`

1. Read `~/.claude/channels/discord/access.json`.
2. Delete `channelAliases[name]`.
3. Write back.
4. Confirm: "Alias removed: name"
```

Add daemon commands:

```markdown
### `daemon stop`

1. Read `~/.claude/channels/discord/daemon.pid`.
2. Send SIGTERM to the PID.
3. Confirm: "Daemon stopped."

### `daemon status`

1. Check if `daemon.pid` exists and process is alive.
2. Show: running/stopped, PID, connected sessions count (if available).
```

Update status display to include channelAliases and daemon status.

- [ ] **Step 2: Update ACCESS.md**

Add "## Channel aliases" section (alias commands, config example).
Add "## Multi-session (daemon mode)" section (how it works, management commands).
Add `channelAliases` to the config file example.
Add alias and daemon rows to the skill reference table.

- [ ] **Step 3: Update README.md**

Add brief "## Multi-session" section linking to ACCESS.md.

- [ ] **Step 4: Commit**

```bash
git add skills/access/SKILL.md ACCESS.md README.md
git commit -m "docs: add channelAliases, daemon mode, and multi-session documentation"
```

---

### Task 4: Update package.json and plugin version

**Files:**
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 1: Update package.json**

Add daemon script, bump version to 0.2.0:

```json
{
  "name": "claude-channel-discord",
  "version": "0.2.0",
  "license": "Apache-2.0",
  "type": "module",
  "bin": "./server.ts",
  "scripts": {
    "start": "bun install --no-summary && bun server.ts",
    "daemon": "bun install --no-summary && bun daemon.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "discord.js": "^14.14.0"
  }
}
```

- [ ] **Step 2: Update plugin.json version**

```json
{
  "name": "discord-focus",
  "description": "Discord channel for Claude Code with multi-session support and per-session channel focus filtering.",
  "version": "0.2.0",
  "author": { "name": "Felix Schoberwalter" },
  "repository": "https://github.com/schobiDotDev/claude-channel-discord",
  "license": "Apache-2.0",
  "keywords": ["discord", "messaging", "channel", "mcp", "focus", "multi-session"]
}
```

- [ ] **Step 3: Commit**

```bash
git add package.json .claude-plugin/plugin.json
git commit -m "chore: bump version to 0.2.0 for daemon architecture"
```

---

### Task 5: Integration testing

No automated test framework. Testing is manual against a real Discord bot.

- [ ] **Step 1: Test basic daemon auto-start**

Start a session. Verify daemon.pid appears and daemon.sock exists. Verify Discord gateway connects (check stderr logs).

- [ ] **Step 2: Test single session with focus**

Start one session with `DISCORD_FOCUS_CHANNELS=<life-id>`. Send messages in #life and #dev. Verify only #life arrives.

- [ ] **Step 3: Test two sessions with different focus**

Start session A with focus on #life, session B with focus on #dev. Send messages in both channels. Verify routing is correct.

- [ ] **Step 4: Test focus_channels tool**

In a running session, tell Claude to focus on a different channel. Verify the subscription changes and new messages route correctly.

- [ ] **Step 5: Test daemon resilience**

Kill the daemon process. Verify next session interaction auto-restarts it.

- [ ] **Step 6: Test channel aliases**

Add aliases to access.json, use alias names in DISCORD_FOCUS_CHANNELS and focus_channels tool.

- [ ] **Step 7: Commit any fixes**

```bash
git add -A && git commit -m "fix: address issues found during integration testing"
```
