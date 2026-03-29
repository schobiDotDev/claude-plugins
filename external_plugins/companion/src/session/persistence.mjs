import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const STATE_PATH = join(process.env.HOME, '.companion-sessions.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function loadState() {
  if (!existsSync(STATE_PATH)) return { sessions: {}, introduced: [] };
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { sessions: {}, introduced: [] };
  }
}

export function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// Clean up sessions older than 7 days
function cleanup(state) {
  const now = Date.now();
  for (const [id, entry] of Object.entries(state.sessions)) {
    if (now - entry.timestamp > MAX_AGE_MS) {
      delete state.sessions[id];
    }
  }
  return state;
}

// Get companion for a session. If session is known, return same companion.
// If new session, assign a random companion from available list.
export function getCompanionForSession(sessionId, availableCompanions) {
  const state = cleanup(loadState());

  // Known session -> return same companion
  if (state.sessions[sessionId]) {
    state.sessions[sessionId].timestamp = Date.now();
    saveState(state);
    return {
      name: state.sessions[sessionId].companion,
      isNew: false,
      needsIntroduction: false,
    };
  }

  // New session -> pick a companion not currently in use by other sessions
  const inUse = new Set(Object.values(state.sessions).map(s => s.companion));
  const available = availableCompanions.filter(c => !inUse.has(c));
  const pick = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : availableCompanions[Math.floor(Math.random() * availableCompanions.length)];

  // Check if this companion was ever introduced to this user
  const needsIntroduction = !state.introduced.includes(pick);
  if (needsIntroduction) {
    state.introduced.push(pick);
  }

  state.sessions[sessionId] = {
    companion: pick,
    timestamp: Date.now(),
  };

  saveState(state);
  return {
    name: pick,
    isNew: true,
    needsIntroduction,
  };
}

// Get companion name for a known session (for stop/notification hooks)
export function getSessionCompanion(sessionId) {
  const state = loadState();
  return state.sessions[sessionId]?.companion || null;
}

// Track how many transcript lines were read at last stop
// so next stop only reads NEW lines since then.
export function getLastStopLine(sessionId) {
  const state = loadState();
  return state.sessions[sessionId]?.lastStopLine || 0;
}

export function setLastStopLine(sessionId, lineNumber) {
  const state = loadState();
  if (state.sessions[sessionId]) {
    state.sessions[sessionId].lastStopLine = lineNumber;
    saveState(state);
  }
}
