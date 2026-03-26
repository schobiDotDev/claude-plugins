# Channel Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-session channel filtering to the Discord plugin so the bot only listens to and writes to configured channels.

**Architecture:** New `focusChannels` field in access.json, checked in `gate()` (inbound) and `fetchAllowedChannel()` (outbound). Env var `DISCORD_FOCUS_CHANNELS` overrides the config value. `/discord:access` skill gets `focus` and `focus clear` commands.

**Tech Stack:** TypeScript, Bun, discord.js, MCP SDK

---

### Task 0: Fork the plugin

**Files:**
- Copy: entire `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord/` to `~/SpaceShipOS/dev/claude-channel-discord/`

- [ ] **Step 1: Copy the plugin source**

```bash
cp -r ~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord/* ~/SpaceShipOS/dev/claude-channel-discord/
```

Don't copy `node_modules/` or `bun.lock` - we'll regenerate them.

```bash
rm -rf ~/SpaceShipOS/dev/claude-channel-discord/node_modules ~/SpaceShipOS/dev/claude-channel-discord/bun.lock
```

- [ ] **Step 2: Init git repo**

```bash
cd ~/SpaceShipOS/dev/claude-channel-discord
git init
git add -A
git commit -m "chore: fork discord plugin from claude-plugins-official"
```

- [ ] **Step 3: Install dependencies and verify the server compiles**

```bash
cd ~/SpaceShipOS/dev/claude-channel-discord
bun install
bun build --target=bun server.ts --outdir=/dev/null
```

Expected: no errors.

---

### Task 1: Add `focusChannels` to the Access type and loader

**Files:**
- Modify: `server.ts:105-121` (Access type)
- Modify: `server.ts:151-172` (readAccessFile)

- [ ] **Step 1: Add `focusChannels` to the Access type**

In `server.ts`, add to the `Access` type (after `chunkMode` at line 120):

```typescript
  /** Optional list of channel IDs to restrict delivery to. Empty/missing = all channels. */
  focusChannels?: string[]
```

- [ ] **Step 2: Parse focusChannels in readAccessFile()**

In `readAccessFile()` at line 151, add to the return object (after `chunkMode: parsed.chunkMode,` at line 164):

```typescript
      focusChannels: parsed.focusChannels,
```

- [ ] **Step 3: Add the loadFocusChannels() helper**

Add this new function after `saveAccess()` (after line 201):

```typescript
/**
 * Resolve the active focus-channel set. Env var takes priority over access.json.
 * Returns null when no filter is active (= all allowlisted channels pass).
 */
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

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "feat: add focusChannels to Access type and loader"
```

---

### Task 2: Add focus filter to gate() - inbound

**Files:**
- Modify: `server.ts:234-292` (gate function)

The focus check goes at the end of `gate()`, right before each `return { action: 'deliver' }`. There are two deliver paths: one for DMs (line 245) and one for guild channels (line 291).

- [ ] **Step 1: Add focus check to the DM deliver path**

In `gate()`, replace line 245:

```typescript
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
```

with:

```typescript
    if (access.allowFrom.includes(senderId)) {
      const focus = loadFocusChannels()
      if (focus && !focus.has(msg.channelId)) return { action: 'drop' }
      return { action: 'deliver', access }
    }
```

- [ ] **Step 2: Add focus check to the guild channel deliver path**

In `gate()`, replace the final return at line 291:

```typescript
  return { action: 'deliver', access }
```

with:

```typescript
  const focus = loadFocusChannels()
  if (focus && !focus.has(channelId)) return { action: 'drop' }
  return { action: 'deliver', access }
```

Note: `channelId` is already computed at line 278-280 (thread -> parent lookup). The focus check uses the same resolved ID.

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "feat: filter inbound messages by focusChannels in gate()"
```

---

### Task 3: Add focus filter to fetchAllowedChannel() - outbound

**Files:**
- Modify: `server.ts:403-413` (fetchAllowedChannel function)

- [ ] **Step 1: Add focus check after the existing allowlist validation**

Replace the `fetchAllowedChannel` function (lines 403-413):

```typescript
async function fetchAllowedChannel(id: string) {
  const ch = await fetchTextChannel(id)
  const access = loadAccess()
  if (ch.type === ChannelType.DM) {
    if (access.allowFrom.includes(ch.recipientId)) return ch
  } else {
    const key = ch.isThread() ? ch.parentId ?? ch.id : ch.id
    if (key in access.groups) return ch
  }
  throw new Error(`channel ${id} is not allowlisted — add via /discord:access`)
}
```

with:

```typescript
async function fetchAllowedChannel(id: string) {
  const ch = await fetchTextChannel(id)
  const access = loadAccess()
  if (ch.type === ChannelType.DM) {
    if (!access.allowFrom.includes(ch.recipientId)) {
      throw new Error(`channel ${id} is not allowlisted — add via /discord:access`)
    }
  } else {
    const key = ch.isThread() ? ch.parentId ?? ch.id : ch.id
    if (!(key in access.groups)) {
      throw new Error(`channel ${id} is not allowlisted — add via /discord:access`)
    }
  }
  // Focus filter — if set, restrict outbound to focused channels only.
  const focus = loadFocusChannels()
  if (focus) {
    const key = ch.type === ChannelType.DM ? ch.id : (ch.isThread() ? ch.parentId ?? ch.id : ch.id)
    if (!focus.has(key)) {
      throw new Error(`channel ${id} is outside focusChannels — update via /discord:access focus`)
    }
  }
  return ch
}
```

- [ ] **Step 2: Verify the server still compiles**

```bash
cd ~/SpaceShipOS/dev/claude-channel-discord
bun build --target=bun server.ts --outdir=/dev/null
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "feat: filter outbound replies by focusChannels"
```

---

### Task 4: Update /discord:access skill for focus commands

**Files:**
- Modify: `skills/access/SKILL.md`

- [ ] **Step 1: Add focus dispatch to the skill**

In `skills/access/SKILL.md`, add the following sections after the `### group rm <channelId>` section:

Under "## Dispatch on arguments", add:

```markdown
### `focus <id1,id2,...>`

1. Read `~/.claude/channels/discord/access.json` (create default if missing).
2. Parse the argument as a comma-separated list of channel IDs. Trim whitespace.
3. Validate each ID looks like a snowflake (numeric string).
4. Set `focusChannels` to the parsed array.
5. Write back.
6. Confirm: list the focused channel IDs.

### `focus clear`

1. Read `~/.claude/channels/discord/access.json`.
2. Delete the `focusChannels` key (or set to empty array).
3. Write back.
4. Confirm: "Focus cleared — all allowlisted channels are now active."
```

- [ ] **Step 2: Update the status display section**

In the `### No args — status` section, add after the groups count line:

```markdown
3. Show: dmPolicy, allowFrom count and list, pending count with codes +
   sender IDs + age, groups count, **focusChannels (if set: list IDs, otherwise "all channels")**.
```

- [ ] **Step 3: Commit**

```bash
git add skills/access/SKILL.md
git commit -m "feat: add focus/unfocus commands to access skill"
```

---

### Task 5: Update documentation

**Files:**
- Modify: `ACCESS.md`
- Modify: `README.md`

- [ ] **Step 1: Add focus section to ACCESS.md**

Add the following section after the "## Delivery" section in `ACCESS.md`:

```markdown
## Channel focus

`focusChannels` restricts which channels the bot listens to and replies in. When set, messages from other allowlisted channels are silently dropped and outbound tool calls to them are rejected.

```
/discord:access focus 846209781206941736,123456789012345678
/discord:access focus clear
```

Channels in `focusChannels` must also be in `groups` (or be a valid DM) — focus is a subset filter, not a security bypass.

### Environment variable override

Set `DISCORD_FOCUS_CHANNELS` to a comma-separated list of channel IDs. This takes priority over `access.json` and enables per-session scoping:

```sh
DISCORD_FOCUS_CHANNELS=846209781206941736 claude --channels plugin:discord@claude-plugins-official
```
```

- [ ] **Step 2: Add focusChannels to the config file example in ACCESS.md**

In the `access.json` jsonc example at the end of ACCESS.md, add after the `chunkMode` line:

```jsonc
  // Restrict to these channels. Empty/missing = all.
  "focusChannels": ["846209781206941736"]
```

- [ ] **Step 3: Update the skill reference table in ACCESS.md**

Add to the skill reference table:

```markdown
| `/discord:access focus 846...` | Set `focusChannels`. Comma-separated IDs. |
| `/discord:access focus clear` | Remove focus filter — all allowlisted channels active. |
```

- [ ] **Step 4: Add a note to README.md**

Add after the "## Access control" section:

```markdown
## Channel focus

Scope a session to specific channels with `focusChannels` in `access.json`, or the `DISCORD_FOCUS_CHANNELS` environment variable. See **[ACCESS.md](./ACCESS.md)** for details.
```

- [ ] **Step 5: Commit**

```bash
git add ACCESS.md README.md
git commit -m "docs: document focusChannels feature"
```

---

### Task 6: Manual integration test

No automated test framework exists in this plugin. Testing is manual against a real Discord bot.

- [ ] **Step 1: Install the fork as a local plugin**

Point Claude Code at the fork instead of the marketplace plugin. In `~/.claude/settings.json` or project settings, configure the MCP server to point to the fork's directory. Or install as a local plugin:

```bash
claude /plugin install ~/SpaceShipOS/dev/claude-channel-discord
```

- [ ] **Step 2: Test focus via access.json**

Edit `~/.claude/channels/discord/access.json` and add:

```json
"focusChannels": ["<life-channel-id>"]
```

Start a Claude Code session with `--channels`. Send a message in #life - verify it arrives. Send a message in #dev - verify it is silently dropped. Try replying to #dev - verify an error is returned.

- [ ] **Step 3: Test focus clear**

Run `/discord:access focus clear`. Send a message in #dev - verify it now arrives.

- [ ] **Step 4: Test env var override**

```bash
DISCORD_FOCUS_CHANNELS=<dev-channel-id> claude --channels plugin:discord@claude-plugins-official
```

Verify only #dev messages arrive, regardless of what `access.json` says.

- [ ] **Step 5: Test backwards compatibility**

Remove `focusChannels` from `access.json`, unset the env var. Verify all channels work as before.

- [ ] **Step 6: Commit any fixes**

If any issues were found and fixed during testing:

```bash
git add -A
git commit -m "fix: address issues found during integration testing"
```
