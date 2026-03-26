# Daemon Architecture - Multi-Session Discord Channel Routing

## Problem

The Discord plugin spawns a new MCP server per Claude Code session, and each MCP server connects directly to the Discord gateway. Discord allows only one gateway connection per bot token. This means only one session can receive Discord messages at a time - a second session disconnects the first.

Users want multiple concurrent sessions, each focused on a different Discord channel (e.g., #life, #dev, #work), all using the same bot.

## Solution

Split the plugin into two processes:
1. **Daemon** - A single background process that holds the Discord gateway connection, manages subscriptions, and routes messages to sessions.
2. **MCP Server** - A thin proxy per session that connects to the daemon via Unix socket instead of directly to Discord.

## Architecture

```
Discord Gateway
      |
Daemon (daemon.ts) - single process, runs persistently
      |
Unix Socket (~/.claude/channels/discord/daemon.sock)
      |
  +---+---+---+
  |       |       |
Session A  Session B  Session C
(server.ts) (server.ts) (server.ts)
focus: #life  focus: #dev  focus: #work
```

### Two processes instead of one

| Component | Responsibility |
|---|---|
| **Daemon** (`daemon.ts`) | Holds Discord gateway, listens on Unix socket, manages per-session subscriptions, routes inbound messages, executes outbound tool calls (reply, react, etc.) |
| **MCP Server** (`server.ts`) | MCP protocol handler for Claude Code. Connects to daemon via socket. Translates MCP tool calls to daemon requests. Forwards daemon messages as MCP notifications. |

### Shared module

| Component | Responsibility |
|---|---|
| **Shared** (`shared.ts`) | Access type, loadAccess(), saveAccess(), loadFocusChannels(), channel alias resolution, IPC message types |

## Daemon Lifecycle

### Auto-Start

1. MCP server checks `daemon.pid` - does the PID exist and is the process running?
2. No -> fork daemon as detached child: `Bun.spawn(["bun", "daemon.ts"], { detached: true, stdio: "ignore" })`, unref the child
3. Wait until `daemon.sock` is connectable (max 5s, retry every 200ms)
4. Yes -> connect directly

### Stale Lockfile

`daemon.pid` exists but process is dead -> delete lockfile, start daemon fresh. Check via `process.kill(pid, 0)` (sends no signal, only checks if process exists).

### Daemon Death

- Session detects: socket connection breaks
- MCP server attempts to restart daemon (same auto-start logic)
- Reconnect with previous channel focus
- If restart fails: MCP server returns error to Claude

### Session Disconnect

- Daemon detects: socket connection closed
- Removes all subscriptions for that session
- No cleanup needed - Unix socket handles this automatically

### Daemon Shutdown

- Daemon runs indefinitely (no auto-shutdown)
- Manually killable: `kill $(cat ~/.claude/channels/discord/daemon.pid)`
- Or via skill command: `/discord:access daemon stop`

## IPC Protocol

JSON-Lines over Unix socket. Each message is one JSON object terminated by `\n`.

### Session -> Daemon

```jsonc
// Register with channel focus
{ "type": "subscribe", "sessionId": "abc123", "channels": ["1486695196346548224"] }

// Change focus at runtime
{ "type": "focus", "sessionId": "abc123", "channels": ["1486695261492346921"] }

// Outbound tool call (reply, react, edit_message, fetch_messages, download_attachment)
{ "type": "tool", "sessionId": "abc123", "callId": "call-1", "call": { "name": "reply", "args": { "chat_id": "...", "text": "..." } } }
```

### Daemon -> Session

```jsonc
// Daemon ready (after connect)
{ "type": "ready", "channels": ["1486695196346548224", "1486695261492346921"] }

// Inbound Discord message (same structure as current MCP notification)
{ "type": "message", "content": "Hi", "meta": { "chat_id": "...", "message_id": "...", "user": ".schobi", "user_id": "...", "ts": "..." } }

// Tool result
{ "type": "tool_result", "callId": "call-1", "result": { "text": "sent (id: 123)" } }

// Tool error
{ "type": "tool_error", "callId": "call-1", "error": "channel not in focusChannels" }

// Error
{ "type": "error", "message": "description of what went wrong" }
```

No authentication needed - the socket is only locally accessible with Unix permissions (0700 on the state directory).

## File Structure

### New/modified files

| File | Responsibility | ~Lines |
|---|---|---|
| `daemon.ts` (new) | Discord gateway, socket server, message routing, subscription management | ~300 |
| `server.ts` (modified) | MCP server, thin proxy to daemon | ~400 |
| `shared.ts` (new) | Shared types, IPC protocol, access.json loader, channel aliases | ~150 |

### What moves where

| Current location in server.ts | New location |
|---|---|
| Discord Client, `gate()`, `handleInbound()`, `isMentioned()` | daemon.ts |
| `fetchAllowedChannel()`, `fetchTextChannel()`, outbound tool execution | daemon.ts |
| MCP server setup, `ListToolsRequestSchema`, `CallToolRequestSchema` | server.ts (stays) |
| `Access` type, `loadAccess()`, `saveAccess()`, `loadFocusChannels()` | shared.ts |
| `assertSendable()`, `downloadAttachment()`, `chunk()` | daemon.ts (used by outbound tools) |

### State files

```
~/.claude/channels/discord/
  daemon.sock     <- Unix socket (created by daemon)
  daemon.pid      <- PID lockfile (created by daemon)
  access.json     <- Config (unchanged schema, new optional fields)
  .env            <- Bot token (unchanged)
  inbox/          <- Attachment downloads (unchanged)
  approved/       <- Pairing approvals (unchanged)
```

## New MCP Tool: focus_channels

Added to server.ts tool list:

```typescript
{
  name: 'focus_channels',
  description: 'Set which Discord channels this session listens to. Pass channel IDs or aliases defined in channelAliases.',
  inputSchema: {
    type: 'object',
    properties: {
      channels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Channel IDs or alias names (e.g., ["life", "dev"] or ["1486695196346548224"])'
      }
    },
    required: ['channels']
  }
}
```

When called, the MCP server sends a `focus` message to the daemon, which updates the subscription for that session.

## Channel Aliases

New optional field in access.json:

```jsonc
{
  "channelAliases": {
    "life": "1486695196346548224",
    "dev": "1486695261492346921",
    "work": "1486695281713090761",
    "spaceship": "1486695243708502096"
  }
}
```

Alias resolution happens in shared.ts. Everywhere a channel ID is accepted, an alias name is also accepted. Resolution: if the value is a key in `channelAliases`, replace with the mapped ID; otherwise treat as a literal channel ID.

Works in:
- `focusChannels` array in access.json
- `DISCORD_FOCUS_CHANNELS` env var
- `focus_channels` tool arguments
- `subscribe` and `focus` IPC messages

## Message Routing

When the daemon receives a Discord message:

1. Run `gate()` as before (access control, pairing, mention detection)
2. If `gate()` returns `deliver`: find all sessions subscribed to this channel
3. If no sessions subscribed: drop the message
4. If one or more sessions: send `{ type: "message", ... }` to each subscribed session
5. Each session's MCP server translates this to an MCP notification for Claude

When a session sends an outbound tool call:

1. Daemon receives `{ type: "tool", ... }`
2. Daemon validates: is the target channel in this session's focus? (if focus is set)
3. Daemon executes the Discord API call (reply, react, etc.)
4. Daemon sends result back to the session

## Backwards Compatibility

### Single-session fallback

Set `DISCORD_SINGLE_MODE=1` to bypass the daemon entirely. In this mode, server.ts connects directly to Discord (current behavior). This is the escape hatch for users who don't need multi-session.

Default behavior (no env var): daemon mode.

### Migration

- `access.json` schema is backwards compatible - `channelAliases` is optional
- Existing setups without `channelAliases` or `focusChannels` work as before
- `gate()` and access control logic is unchanged, just lives in daemon.ts
- All existing MCP tools (reply, react, edit_message, fetch_messages, download_attachment) work identically

### For upstream PR

- Feature is opt-in: multiple sessions trigger daemon usage, single session works too
- No breaking changes for existing users
- New `focus_channels` tool is additive
- `channelAliases` is additive

## Testing

- Start two sessions with different focus channels, verify messages route correctly
- Kill daemon, verify session auto-restarts it and reconnects
- Stale lockfile (kill -9 daemon), verify next session cleans up and starts fresh
- `DISCORD_SINGLE_MODE=1`, verify direct connection works (no daemon)
- `focus_channels` tool at runtime, verify subscription changes
- Outbound tool calls (reply) through daemon, verify they work
- Channel aliases in all input points
- No sessions focused on a channel, verify messages are dropped
- Daemon running, no sessions connected, verify daemon stays alive
