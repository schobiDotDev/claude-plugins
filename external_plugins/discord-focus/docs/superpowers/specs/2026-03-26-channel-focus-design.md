# Channel Focus - Per-Session Channel Filtering

## Problem

The Discord plugin delivers messages from ALL allowlisted channels to every Claude Code session. When running multiple sessions with different purposes (e.g., #life for personal tasks, #dev for coding, #work for business), there is no way to scope a session to specific channels. Messages from unrelated channels create noise and confusion.

## Solution

A new `focusChannels` field in `access.json` that restricts both inbound delivery and outbound replies to a subset of allowlisted channels. When set, the bot only listens to and writes to those channels. When empty or missing, existing behavior is preserved (backwards compatible).

## Design

### access.json Schema Addition

```jsonc
{
  "dmPolicy": "pairing",
  "allowFrom": ["557884080620830720"],
  "groups": {
    "1486695196346548224": { "requireMention": false, "allowFrom": [] },
    "1486695243708502096": { "requireMention": false, "allowFrom": [] },
    "1486695261492346921": { "requireMention": false, "allowFrom": [] },
    "1486695281713090761": { "requireMention": false, "allowFrom": [] }
  },
  "focusChannels": ["1486695196346548224"]  // NEW - optional
}
```

Rules:
- `focusChannels` is an optional array of channel ID strings
- If missing, undefined, or empty array: all allowlisted channels are active (current behavior)
- If non-empty: only channels in this list receive inbound delivery and allow outbound replies
- Channels in `focusChannels` MUST also be in `groups` (or be a valid DM channel in `allowFrom`) - focus is a subset filter, not a security bypass
- DMs: if `focusChannels` is set, DMs are only delivered if the DM channel ID is in the list. If `focusChannels` is empty/missing, DM behavior is unchanged.

### Environment Variable Override

`DISCORD_FOCUS_CHANNELS=id1,id2` overrides the `access.json` value at runtime. This enables per-session scoping without modifying the shared config file:

```sh
DISCORD_FOCUS_CHANNELS=1486695196346548224 claude --channels plugin:discord@claude-plugins-official
```

Priority: env var > access.json > default (no filter).

### server.ts Changes

Three modification points in the existing codebase:

#### 1. Focus channel loader (new helper)

```typescript
function loadFocusChannels(): Set<string> | null {
  const envVal = process.env.DISCORD_FOCUS_CHANNELS
  if (envVal) {
    const ids = envVal.split(',').map(s => s.trim()).filter(Boolean)
    return ids.length > 0 ? new Set(ids) : null
  }
  const access = loadAccess()
  const fc = access.focusChannels
  if (Array.isArray(fc) && fc.length > 0) return new Set(fc)
  return null
}
```

Returns `null` when no filter is active (preserve current behavior).

#### 2. gate() - Inbound filter (line ~234)

After the existing access checks pass and before returning `{ action: 'deliver' }`, add:

```typescript
// After existing guild channel check (line ~291):
const focus = loadFocusChannels()
if (focus && !focus.has(channelId)) return { action: 'drop' }
```

For DMs, check against the DM channel ID:
```typescript
// After existing DM allowFrom check (line ~245):
const focus = loadFocusChannels()
if (focus && !focus.has(msg.channelId)) return { action: 'drop' }
```

#### 3. fetchAllowedChannel() - Outbound filter (line ~403)

After the existing allowlist check passes:

```typescript
const focus = loadFocusChannels()
if (focus) {
  const key = ch.isThread() ? ch.parentId ?? ch.id : ch.id
  if (!focus.has(ch.type === ChannelType.DM ? ch.id : key)) {
    throw new Error(`channel ${id} is not in focusChannels — update via /discord:access focus ${id}`)
  }
}
```

### /discord:access Skill Extension

New commands in the access skill:

| Command | Effect |
|---|---|
| `focus <id1,id2,...>` | Set `focusChannels` in access.json |
| `focus clear` | Remove `focusChannels` (restore all-channel mode) |

Status display (`/discord:access` with no args) shows active focus channels.

### What Does NOT Change

- Channels must still be in `groups` to work - focus is additive security, not a bypass
- DM handling (pairing, allowlist) is unchanged when focusChannels is empty
- All existing tools (reply, react, edit_message, fetch_messages, download_attachment) work the same
- access.json is still re-read on every inbound message, so focus changes take effect immediately
- The env var override is read on every check (not cached at boot), allowing runtime changes via the env

## Testing

- Set focusChannels to one channel, send messages in another - verify they are dropped
- Set focusChannels, try to reply to a non-focused channel - verify error
- Clear focusChannels - verify all channels work again
- Set env var override - verify it takes priority over access.json
- Leave focusChannels unset - verify backwards compatibility
- Set focusChannels to a channel NOT in groups - verify it still gets dropped by the existing gate
- Thread in a focused channel - verify it works (parent channel lookup)
