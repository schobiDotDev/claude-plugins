/**
 * Shared types, constants, and utilities for discord-focus.
 * Used by both daemon.ts and server.ts.
 * No Discord.js imports — intentionally framework-agnostic.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'

// ---------------------------------------------------------------------------
// State path constants
// ---------------------------------------------------------------------------

export const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const DAEMON_SOCK = join(STATE_DIR, 'daemon.sock')
export const DAEMON_PID = join(STATE_DIR, 'daemon.pid')

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

/**
 * Load ~/.claude/channels/discord/.env into process.env. Real env wins.
 * Plugin-spawned servers don't get an env block — this is where the token lives.
 */
export function loadEnvFile(): void {
  try {
    // Token is a credential — lock to owner. No-op on Windows (would need ACLs).
    chmodSync(ENV_FILE, 0o600)
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PendingEntry = {
  senderId: string
  chatId: string // DM channel ID — where to send the approval confirm
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  /** Keyed on channel ID (snowflake), not guild ID. One entry per guild channel. */
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  // delivery/UX config — optional, defaults live in the reply handler
  /** Emoji to react with on receipt. Empty string disables. Unicode char or custom emoji ID. */
  ackReaction?: string
  /** Which chunks get Discord's reply reference when reply_to is passed. Default: 'first'. 'off' = never thread. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 2000 (Discord's hard cap). */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: 'length' | 'newline'
  /** Optional list of channel IDs to restrict delivery to. Empty/missing = all channels. */
  focusChannels?: string[]
  /** Maps human-readable aliases to Discord channel IDs. */
  channelAliases?: Record<string, string>
}

// GateResult is NOT shared (daemon-only).

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_CHUNK_LIMIT = 2000
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

// ---------------------------------------------------------------------------
// Access I/O
// ---------------------------------------------------------------------------

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

// In static mode, access is snapshotted at boot and never re-read or written.
// Pairing requires runtime mutation, so it's downgraded to allowlist with a
// startup warning — handing out codes that never get approved would be worse.
export const STATIC = process.env.DISCORD_ACCESS_MODE === 'static'

export function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      focusChannels: parsed.focusChannels,
      channelAliases: parsed.channelAliases,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`discord: access.json is corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

export const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write(
          'discord channel: static mode — dmPolicy "pairing" downgraded to "allowlist"\n',
        )
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

export function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

export function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

// ---------------------------------------------------------------------------
// Channel alias resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single alias or channel ID.
 * If idOrAlias matches a key in access.channelAliases, returns the mapped ID.
 * Otherwise returns idOrAlias unchanged (passthrough for raw snowflakes).
 */
export function resolveAlias(idOrAlias: string, access?: Access): string {
  const aliases = (access ?? loadAccess()).channelAliases ?? {}
  return aliases[idOrAlias] ?? idOrAlias
}

/**
 * Batch version of resolveAlias.
 */
export function resolveAliases(idsOrAliases: string[], access?: Access): string[] {
  const resolved = access ?? loadAccess()
  return idsOrAliases.map(id => resolveAlias(id, resolved))
}

// ---------------------------------------------------------------------------
// Focus channels
// ---------------------------------------------------------------------------

/**
 * Resolve the active focus-channel set. Env var takes priority over access.json.
 * Applies alias resolution so callers can use either IDs or aliases.
 * Returns null when no filter is active (= all allowlisted channels pass).
 */
export function loadFocusChannels(access?: Access): Set<string> | null {
  const resolved = access ?? loadAccess()
  const envVal = process.env.DISCORD_FOCUS_CHANNELS
  if (envVal) {
    const ids = resolveAliases(
      envVal.split(',').map(s => s.trim()).filter(Boolean),
      resolved,
    )
    return ids.length > 0 ? new Set(ids) : null
  }
  const fc = resolved.focusChannels
  if (Array.isArray(fc) && fc.length > 0) {
    return new Set(resolveAliases(fc, resolved))
  }
  return null
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

/**
 * Split text into chunks of at most `limit` chars, preferring paragraph or
 * line boundaries when mode is 'newline'.
 */
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      // Prefer the last double-newline (paragraph), then single newline,
      // then space. Fall back to hard cut.
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/**
 * Guard against sending channel-internal state files (access.json, .env, etc.)
 * as Discord attachments. Inbox files are allowed — everything else in STATE_DIR
 * is refused.
 */
export function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return } // statSync will fail properly; or STATE_DIR absent → nothing to leak
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

// ---------------------------------------------------------------------------
// IPC message types
// ---------------------------------------------------------------------------

/** Messages sent from daemon to a session (server.ts). */
export type IpcToServer =
  | { type: 'ready'; channels: string[] }
  | { type: 'message'; content: string; meta: Record<string, string> }
  | { type: 'permission_reply'; request_id: string; behavior: string }
  | { type: 'tool_result'; callId: string; result: string }
  | { type: 'tool_error'; callId: string; error: string }
  | { type: 'error'; message: string }

/** Messages sent from a session (server.ts) to the daemon. */
export type IpcToDaemon =
  | { type: 'subscribe'; sessionId: string; channels: string[] }
  | { type: 'focus'; sessionId: string; channels: string[] }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'tool'; sessionId: string; callId: string; call: { name: string; args: Record<string, unknown> } }
  | { type: 'permission_request'; sessionId: string; request_id: string; tool_name: string; description: string; input_preview: string }
