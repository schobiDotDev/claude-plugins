import { loadConfig } from '../config.mjs';
import { loadCompanion, pickRandom } from '../companion/index.mjs';
import { getSessionCompanion, getLastStopLine, setLastStopLine } from '../session/persistence.mjs';
import { generateStopSummary } from '../companion/summarize.mjs';
import { generateSessionName } from '../companion/namer.mjs';
import { getTranscriptLineCount } from '../session/transcript.mjs';
import { enqueue } from '../tts/queue.mjs';
import { notify } from '../notify/index.mjs';

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  const config = loadConfig();

  let hookData = {};
  try {
    hookData = JSON.parse(input);
  } catch {}

  const sessionId = hookData.session_id || '';
  const companionName = getSessionCompanion(sessionId) || config.companion;
  const companion = loadCompanion(companionName);

  const transcriptPath = hookData.transcript_path || '';
  const lastAssistantMessage = hookData.last_assistant_message || '';

  // Only read transcript lines since last stop (avoid repeating old summaries)
  const sinceLineNumber = getLastStopLine(sessionId);

  // Try smart summary from LLM
  let message = null;
  try {
    message = await generateStopSummary(companion, config, {
      transcriptPath,
      lastAssistantMessage,
      sinceLineNumber,
    });
  } catch {}

  if (!message) {
    message = pickRandom(companion.on_stop);
  }

  // Track current line count for next stop
  if (transcriptPath) {
    const currentLine = getTranscriptLineCount(transcriptPath);
    setLastStopLine(sessionId, currentLine);
  }

  const project = hookData.cwd ? hookData.cwd.split('/').pop() : '';

  // Name the session if not yet named
  try {
    await generateSessionName(sessionId, config, { transcriptPath, sinceLineNumber });
  } catch {}

  // One notification, not both - TTS takes priority when enabled
  if (config.notify.tts_on_stop) {
    await enqueue(message, companion, config);
  } else {
    notify({
      title: companion.name,
      subtitle: project,
      message,
      config,
    });
  }
});
