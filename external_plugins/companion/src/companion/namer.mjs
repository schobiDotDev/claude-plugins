import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { complete } from '../llm/index.mjs';
import { readTranscript, formatTranscriptForLLM } from '../session/transcript.mjs';
import { loadState, saveState } from '../session/persistence.mjs';

const SESSIONS_DIR = join(process.env.HOME, '.claude', 'sessions');
const MIN_LINES_TO_NAME = 6;

function findSessionFile(sessionId) {
  try {
    for (const f of readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8'));
      if (data.sessionId === sessionId) return join(SESSIONS_DIR, f);
    }
  } catch {}
  return null;
}

function writeNameToSessionFile(sessionId, name) {
  const file = findSessionFile(sessionId);
  if (!file) return;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.name = name;
  writeFileSync(file, JSON.stringify(data));
}

export async function generateSessionName(sessionId, config, { transcriptPath, sinceLineNumber = 0 }) {
  if (!transcriptPath || !config.llm?.base_url) return;

  const state = loadState();
  const session = state.sessions?.[sessionId];
  if (!session) return;

  // Already named? Just make sure the session file has it too
  if (session.sessionName) {
    writeNameToSessionFile(sessionId, session.sessionName);
    return;
  }

  // Wait until there's enough context
  const transcript = readTranscript(transcriptPath, 12);
  if (transcript.length < MIN_LINES_TO_NAME) return;

  const context = formatTranscriptForLLM(transcript);

  const messages = [
    {
      role: 'system',
      content: `Generate a short kebab-case session name (2-4 words) that describes what this coding session is about. Examples: companion-marketplace-plugin, discord-daemon-refactor, fix-tts-queue-blocking, vault-task-system-v2. Reply with ONLY the name, nothing else.`,
    },
    {
      role: 'user',
      content: context,
    },
  ];

  const name = await complete(messages, config, { maxTokens: 30 });
  if (!name) return;

  // Clean: lowercase, kebab-case, no quotes/spaces
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
  if (!clean || clean.length < 3) return;

  // Persist in companion state (survives session restart)
  session.sessionName = clean;
  saveState(state);

  // Also write to Claude's session file
  writeNameToSessionFile(sessionId, clean);
}
