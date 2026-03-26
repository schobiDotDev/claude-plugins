#!/usr/bin/env bun
/**
 * Discord gateway daemon for discord-focus.
 *
 * Holds the single Discord gateway connection and multiplexes inbound messages
 * to per-session MCP servers via a Unix socket. Sessions (server.ts instances)
 * connect, subscribe to channels, and request tool execution through JSON-Lines
 * IPC.
 *
 * No MCP SDK dependency - this is a pure Discord + socket server.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type Message,
  type Attachment,
  type Interaction,
} from 'discord.js'
import { randomBytes } from 'crypto'
import {
  writeFileSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
  rmSync,
  readFileSync,
  statSync,
} from 'fs'
import { join } from 'path'

import {
  STATE_DIR,
  APPROVED_DIR,
  INBOX_DIR,
  DAEMON_SOCK,
  DAEMON_PID,
  MAX_CHUNK_LIMIT,
  MAX_ATTACHMENT_BYTES,
  loadEnvFile,
  loadAccess,
  saveAccess,
  loadFocusChannels,
  pruneExpired,
  chunk,
  assertSendable,
  type Access,
  type IpcToServer,
  type IpcToDaemon,
  STATIC,
} from './shared'

// ---------------------------------------------------------------------------
// Env & token
// ---------------------------------------------------------------------------

loadEnvFile()

const TOKEN = process.env.DISCORD_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(
    `discord daemon: DISCORD_BOT_TOKEN required\n` +
    `  set in ~/.claude/channels/discord/.env\n` +
    `  format: DISCORD_BOT_TOKEN=MTIz...\n`,
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// PID file & cleanup
// ---------------------------------------------------------------------------

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
writeFileSync(DAEMON_PID, String(process.pid), { mode: 0o600 })

function cleanup(): void {
  try { unlinkSync(DAEMON_PID) } catch {}
  try { unlinkSync(DAEMON_SOCK) } catch {}
}

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('discord daemon: shutting down\n')
  cleanup()
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(client.destroy()).finally(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('exit', cleanup)

// Safety nets
process.on('unhandledRejection', err => {
  process.stderr.write(`discord daemon: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`discord daemon: uncaught exception: ${err}\n`)
})

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

// ---------------------------------------------------------------------------
// Session tracking
// ---------------------------------------------------------------------------

type Session = {
  sessionId: string
  channels: Set<string>  // channel IDs this session is subscribed to (empty = all)
  send: (msg: IpcToServer) => void
}

const sessions = new Map<string, Session>()

// Reverse map: socket data reference -> sessionId (for cleanup on disconnect)
// We use a Map keyed on a per-socket token stored in socket.data.
const socketToSession = new Map<object, string>()

// ---------------------------------------------------------------------------
// Mention tracking
// ---------------------------------------------------------------------------

const recentSentIds = new Set<string>()
const RECENT_SENT_CAP = 200

function noteSent(id: string): void {
  recentSentIds.add(id)
  if (recentSentIds.size > RECENT_SENT_CAP) {
    const first = recentSentIds.values().next().value
    if (first) recentSentIds.delete(first)
  }
}

// ---------------------------------------------------------------------------
// Permission reply regex (from anthropics/claude-cli-internal)
// ---------------------------------------------------------------------------

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ---------------------------------------------------------------------------
// Stores full permission details for "See more" expansion keyed by request_id.
// ---------------------------------------------------------------------------

const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

// ---------------------------------------------------------------------------
// gate() - access control for inbound messages
// ---------------------------------------------------------------------------

type GateResult =
  | { action: 'deliver'; access: Access; channelId: string }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

async function gate(msg: Message): Promise<GateResult> {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = msg.author.id
  const isDM = msg.channel.type === ChannelType.DM

  if (isDM) {
    if (access.allowFrom.includes(senderId)) {
      // No focus check here - per-session routing handles that
      return { action: 'deliver', access, channelId: msg.channelId }
    }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    // pairing mode - check for existing non-expired code for this sender
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: msg.channelId,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  // Guild message - resolve thread to parent for policy lookup
  const channelId = msg.channel.isThread()
    ? msg.channel.parentId ?? msg.channelId
    : msg.channelId
  const policy = access.groups[channelId]
  if (!policy) return { action: 'drop' }
  const groupAllowFrom = policy.allowFrom ?? []
  const requireMention = policy.requireMention ?? true
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
    return { action: 'drop' }
  }
  if (requireMention && !(await isMentioned(msg, access.mentionPatterns))) {
    return { action: 'drop' }
  }
  // No focus check here - per-session routing handles that
  return { action: 'deliver', access, channelId }
}

// ---------------------------------------------------------------------------
// isMentioned()
// ---------------------------------------------------------------------------

async function isMentioned(msg: Message, extraPatterns?: string[]): Promise<boolean> {
  if (client.user && msg.mentions.has(client.user)) return true

  const refId = msg.reference?.messageId
  if (refId) {
    if (recentSentIds.has(refId)) return true
    try {
      const ref = await msg.fetchReference()
      if (ref.author.id === client.user?.id) return true
    } catch {}
  }

  const text = msg.content
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

// ---------------------------------------------------------------------------
// Attachment helpers
// ---------------------------------------------------------------------------

function safeAttName(att: Attachment): string {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, '_')
}

async function downloadAttachment(att: Attachment): Promise<string> {
  if (att.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`)
  }
  const res = await fetch(att.url)
  const buf = Buffer.from(await res.arrayBuffer())
  const name = att.name ?? `${att.id}`
  const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
  const path = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}

// ---------------------------------------------------------------------------
// fetchTextChannel / fetchAllowedChannel
// ---------------------------------------------------------------------------

async function fetchTextChannel(id: string) {
  const ch = await client.channels.fetch(id)
  if (!ch || !ch.isTextBased()) {
    throw new Error(`channel ${id} not found or not text-based`)
  }
  return ch
}

/**
 * Outbound gate - tools can only target chats the inbound gate would deliver
 * from. Optional sessionFocus restricts to per-session focused channels.
 */
async function fetchAllowedChannel(id: string, sessionFocus?: Set<string>) {
  const ch = await fetchTextChannel(id)
  const access = loadAccess()
  if (ch.type === ChannelType.DM) {
    if (!access.allowFrom.includes(ch.recipientId)) {
      throw new Error(`channel ${id} is not allowlisted - add via /discord:access`)
    }
  } else {
    const key = ch.isThread() ? ch.parentId ?? ch.id : ch.id
    if (!(key in access.groups)) {
      throw new Error(`channel ${id} is not allowlisted - add via /discord:access`)
    }
  }
  // Per-session focus filter
  const focus = sessionFocus ?? loadFocusChannels(access)
  if (focus) {
    const key = ch.type === ChannelType.DM ? ch.id : (ch.isThread() ? ch.parentId ?? ch.id : ch.id)
    if (!focus.has(key)) {
      throw new Error(`channel ${id} is outside focusChannels - update via /discord:access focus`)
    }
  }
  return ch
}

// ---------------------------------------------------------------------------
// checkApprovals() - poll for pairing approvals
// ---------------------------------------------------------------------------

function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch {
    return
  }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    let dmChannelId: string
    try {
      dmChannelId = readFileSync(file, 'utf8').trim()
    } catch {
      rmSync(file, { force: true })
      continue
    }
    if (!dmChannelId) {
      rmSync(file, { force: true })
      continue
    }

    void (async () => {
      try {
        const ch = await fetchTextChannel(dmChannelId)
        if ('send' in ch) {
          await ch.send("Paired! Say hi to Claude.")
        }
        rmSync(file, { force: true })
      } catch (err) {
        process.stderr.write(`discord daemon: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      }
    })()
  }
}

if (!STATIC) setInterval(checkApprovals, 5000).unref()

// ---------------------------------------------------------------------------
// handleInbound() - process gated messages and route to sessions
// ---------------------------------------------------------------------------

async function handleInbound(msg: Message): Promise<void> {
  const result = await gate(msg)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try {
      await msg.reply(
        `${lead} - run in Claude Code:\n\n/discord:access pair ${result.code}`,
      )
    } catch (err) {
      process.stderr.write(`discord daemon: failed to send pairing code: ${err}\n`)
    }
    return
  }

  const chat_id = msg.channelId
  const { access, channelId } = result

  // Permission-reply intercept: forward to ALL sessions
  const permMatch = PERMISSION_REPLY_RE.exec(msg.content)
  if (permMatch) {
    const permMsg: IpcToServer = {
      type: 'permission_reply',
      request_id: permMatch[2]!.toLowerCase(),
      behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
    }
    for (const session of sessions.values()) {
      session.send(permMsg)
    }
    const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '\u2705' : '\u274C'
    void msg.react(emoji).catch(() => {})
    return
  }

  // Typing indicator
  if ('sendTyping' in msg.channel) {
    void msg.channel.sendTyping().catch(() => {})
  }

  // Ack reaction
  if (access.ackReaction) {
    void msg.react(access.ackReaction).catch(() => {})
  }

  // Build attachment listing
  const atts: string[] = []
  for (const att of msg.attachments.values()) {
    const kb = (att.size / 1024).toFixed(0)
    atts.push(`${safeAttName(att)} (${att.contentType ?? 'unknown'}, ${kb}KB)`)
  }

  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

  const ipcMsg: IpcToServer = {
    type: 'message',
    content,
    meta: {
      chat_id,
      message_id: msg.id,
      user: msg.author.username,
      user_id: msg.author.id,
      ts: msg.createdAt.toISOString(),
      ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    },
  }

  // Route to subscribed sessions
  let delivered = false
  for (const session of sessions.values()) {
    // Empty channels set = subscribed to all
    if (session.channels.size === 0 || session.channels.has(channelId)) {
      session.send(ipcMsg)
      delivered = true
    }
  }

  if (!delivered) {
    process.stderr.write(`discord daemon: no session subscribed for channel ${channelId}, dropping message\n`)
  }
}

// ---------------------------------------------------------------------------
// executeTool() - run Discord API calls on behalf of a session
// ---------------------------------------------------------------------------

async function executeTool(
  call: { name: string; args: Record<string, unknown> },
  sessionFocus: Set<string>,
): Promise<string> {
  const { name, args } = call

  switch (name) {
    case 'reply': {
      const chat_id = args.chat_id as string
      const text = args.text as string
      const reply_to = args.reply_to as string | undefined
      const files = (args.files as string[] | undefined) ?? []

      const ch = await fetchAllowedChannel(chat_id, sessionFocus)
      if (!('send' in ch)) throw new Error('channel is not sendable')

      for (const f of files) {
        assertSendable(f)
        const st = statSync(f)
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
        }
      }
      if (files.length > 10) throw new Error('Discord allows max 10 attachments per message')

      const access = loadAccess()
      const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
      const mode = access.chunkMode ?? 'length'
      const replyMode = access.replyToMode ?? 'first'
      const chunks = chunk(text, limit, mode)
      const sentIds: string[] = []

      try {
        for (let i = 0; i < chunks.length; i++) {
          const shouldReplyTo =
            reply_to != null &&
            replyMode !== 'off' &&
            (replyMode === 'all' || i === 0)
          const sent = await ch.send({
            content: chunks[i],
            ...(i === 0 && files.length > 0 ? { files } : {}),
            ...(shouldReplyTo
              ? { reply: { messageReference: reply_to, failIfNotExists: false } }
              : {}),
          })
          noteSent(sent.id)
          sentIds.push(sent.id)
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${errMsg}`)
      }

      return sentIds.length === 1
        ? `sent (id: ${sentIds[0]})`
        : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
    }

    case 'fetch_messages': {
      const ch = await fetchAllowedChannel(args.channel as string, sessionFocus)
      const fetchLimit = Math.min((args.limit as number) ?? 20, 100)
      const msgs = await ch.messages.fetch({ limit: fetchLimit })
      const me = client.user?.id
      const arr = [...msgs.values()].reverse()
      if (arr.length === 0) return '(no messages)'
      return arr
        .map(m => {
          const who = m.author.id === me ? 'me' : m.author.username
          const atts = m.attachments.size > 0 ? ` +${m.attachments.size}att` : ''
          const text = m.content.replace(/[\r\n]+/g, ' \u23CE ')
          return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
        })
        .join('\n')
    }

    case 'react': {
      const ch = await fetchAllowedChannel(args.chat_id as string, sessionFocus)
      const reactMsg = await ch.messages.fetch(args.message_id as string)
      await reactMsg.react(args.emoji as string)
      return 'reacted'
    }

    case 'edit_message': {
      const ch = await fetchAllowedChannel(args.chat_id as string, sessionFocus)
      const editMsg = await ch.messages.fetch(args.message_id as string)
      const edited = await editMsg.edit(args.text as string)
      return `edited (id: ${edited.id})`
    }

    case 'download_attachment': {
      const ch = await fetchAllowedChannel(args.chat_id as string, sessionFocus)
      const dlMsg = await ch.messages.fetch(args.message_id as string)
      if (dlMsg.attachments.size === 0) return 'message has no attachments'
      const lines: string[] = []
      for (const att of dlMsg.attachments.values()) {
        const path = await downloadAttachment(att)
        const kb = (att.size / 1024).toFixed(0)
        lines.push(`  ${path}  (${safeAttName(att)}, ${att.contentType ?? 'unknown'}, ${kb}KB)`)
      }
      return `downloaded ${lines.length} attachment(s):\n${lines.join('\n')}`
    }

    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Permission button handler
// ---------------------------------------------------------------------------

client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isButton()) return
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(interaction.customId)
  if (!m) return
  const access = loadAccess()
  if (!access.allowFrom.includes(interaction.user.id)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
    return
  }
  const [, behavior, request_id] = m

  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id!)
    if (!details) {
      await interaction.reply({ content: 'Details no longer available.', ephemeral: true }).catch(() => {})
      return
    }
    const { tool_name, description, input_preview } = details
    let prettyInput: string
    try {
      prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
    } catch {
      prettyInput = input_preview
    }
    const expanded =
      `\uD83D\uDD10 Permission: ${tool_name}\n\n` +
      `tool_name: ${tool_name}\n` +
      `description: ${description}\n` +
      `input_preview:\n${prettyInput}`
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm:allow:${request_id}`)
        .setLabel('Allow')
        .setEmoji('\u2705')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`perm:deny:${request_id}`)
        .setLabel('Deny')
        .setEmoji('\u274C')
        .setStyle(ButtonStyle.Danger),
    )
    await interaction.update({ content: expanded, components: [row] }).catch(() => {})
    return
  }

  // Forward to all sessions as permission_reply
  const permMsg: IpcToServer = {
    type: 'permission_reply',
    request_id: request_id!,
    behavior: behavior!,
  }
  for (const session of sessions.values()) {
    session.send(permMsg)
  }
  pendingPermissions.delete(request_id!)
  const label = behavior === 'allow' ? '\u2705 Allowed' : '\u274C Denied'
  await interaction
    .update({ content: `${interaction.message.content}\n\n${label}`, components: [] })
    .catch(() => {})
})

// ---------------------------------------------------------------------------
// Permission request handler - receives from sessions, sends Discord DM buttons
// ---------------------------------------------------------------------------

function handlePermissionRequest(params: {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}): void {
  const { request_id, tool_name, description, input_preview } = params
  pendingPermissions.set(request_id, { tool_name, description, input_preview })
  const access = loadAccess()
  const text = `\uD83D\uDD10 Permission: ${tool_name}`
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`perm:more:${request_id}`)
      .setLabel('See more')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`perm:allow:${request_id}`)
      .setLabel('Allow')
      .setEmoji('\u2705')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`perm:deny:${request_id}`)
      .setLabel('Deny')
      .setEmoji('\u274C')
      .setStyle(ButtonStyle.Danger),
  )
  for (const userId of access.allowFrom) {
    void (async () => {
      try {
        const user = await client.users.fetch(userId)
        await user.send({ content: text, components: [row] })
      } catch (e) {
        process.stderr.write(`discord daemon: permission_request send to ${userId} failed: ${e}\n`)
      }
    })()
  }
}

// ---------------------------------------------------------------------------
// IPC message handler
// ---------------------------------------------------------------------------

function handleIpcMessage(data: IpcToDaemon, socketRef: object): void {
  switch (data.type) {
    case 'subscribe': {
      const channelSet = new Set(data.channels)
      const send = (msg: IpcToServer) => {
        const sock = socketForRef.get(socketRef)
        if (sock) {
          sock.write(JSON.stringify(msg) + '\n')
        }
      }
      sessions.set(data.sessionId, {
        sessionId: data.sessionId,
        channels: channelSet,
        send,
      })
      socketToSession.set(socketRef, data.sessionId)
      process.stderr.write(`discord daemon: session ${data.sessionId} subscribed (${channelSet.size || 'all'} channels)\n`)

      // Send ready acknowledgement with current channel list
      const access = loadAccess()
      const channels = [
        ...Object.keys(access.groups),
        ...(access.allowFrom.length > 0 ? ['(DMs)'] : []),
      ]
      send({ type: 'ready', channels })
      break
    }

    case 'focus': {
      const session = sessions.get(data.sessionId)
      if (session) {
        session.channels = new Set(data.channels)
        process.stderr.write(`discord daemon: session ${data.sessionId} focus updated (${session.channels.size || 'all'} channels)\n`)
      }
      break
    }

    case 'unsubscribe': {
      sessions.delete(data.sessionId)
      process.stderr.write(`discord daemon: session ${data.sessionId} unsubscribed\n`)
      break
    }

    case 'tool': {
      const session = sessions.get(data.sessionId)
      if (!session) {
        process.stderr.write(`discord daemon: tool call from unknown session ${data.sessionId}\n`)
        return
      }
      const sessionFocus = session.channels
      void (async () => {
        try {
          const result = await executeTool(data.call, sessionFocus)
          session.send({ type: 'tool_result', callId: data.callId, result })
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          session.send({ type: 'tool_error', callId: data.callId, error: `${data.call.name} failed: ${errMsg}` })
        }
      })()
      break
    }

    case 'permission_request': {
      handlePermissionRequest({
        request_id: data.request_id,
        tool_name: data.tool_name,
        description: data.description,
        input_preview: data.input_preview,
      })
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Unix socket server
// ---------------------------------------------------------------------------

// Map socket reference -> actual Bun socket (for writing back)
const socketForRef = new Map<object, { write: (data: string | Uint8Array) => number }>()

// Per-socket line buffer for JSON-Lines parsing
const socketBuffers = new Map<object, string>()

// Remove stale socket file before listening
try { unlinkSync(DAEMON_SOCK) } catch {}

Bun.listen({
  unix: DAEMON_SOCK,
  socket: {
    open(socket) {
      const ref = {}
      ;(socket as any)._ref = ref
      socketForRef.set(ref, socket)
      socketBuffers.set(ref, '')
      process.stderr.write('discord daemon: socket client connected\n')
    },

    data(socket, raw) {
      const ref = (socket as any)._ref as object
      const buf = (socketBuffers.get(ref) ?? '') + raw.toString()
      const lines = buf.split('\n')
      // Last element is either empty (complete line) or a partial
      socketBuffers.set(ref, lines.pop()!)

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as IpcToDaemon
          handleIpcMessage(parsed, ref)
        } catch (err) {
          process.stderr.write(`discord daemon: invalid IPC message: ${err}\n`)
        }
      }
    },

    close(socket) {
      const ref = (socket as any)._ref as object
      const sessionId = socketToSession.get(ref)
      if (sessionId) {
        sessions.delete(sessionId)
        socketToSession.delete(ref)
        process.stderr.write(`discord daemon: session ${sessionId} disconnected\n`)
      }
      socketForRef.delete(ref)
      socketBuffers.delete(ref)
    },

    error(socket, err) {
      process.stderr.write(`discord daemon: socket error: ${err}\n`)
    },
  },
})

process.stderr.write(`discord daemon: listening on ${DAEMON_SOCK}\n`)

// ---------------------------------------------------------------------------
// Discord event handlers
// ---------------------------------------------------------------------------

client.on('error', err => {
  process.stderr.write(`discord daemon: client error: ${err}\n`)
})

client.on('messageCreate', msg => {
  if (msg.author.bot) return
  handleInbound(msg).catch(e => process.stderr.write(`discord daemon: handleInbound failed: ${e}\n`))
})

client.once('ready', c => {
  process.stderr.write(`discord daemon: gateway connected as ${c.user.tag}\n`)
})

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

client.login(TOKEN).catch(err => {
  process.stderr.write(`discord daemon: login failed: ${err}\n`)
  process.exit(1)
})
