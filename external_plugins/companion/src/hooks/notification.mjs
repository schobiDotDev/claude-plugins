import { loadConfig } from '../config.mjs';
import { loadCompanion } from '../companion/index.mjs';
import { getSessionCompanion } from '../session/persistence.mjs';
import { enqueue } from '../tts/queue.mjs';
import { notify } from '../notify/index.mjs';

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  const config = loadConfig();

  let hookData = {};
  try {
    hookData = JSON.parse(input);
  } catch {
    hookData = { message: input.trim() };
  }

  // Load companion from session persistence, fallback to config
  const sessionId = hookData.session_id || '';
  const companionName = getSessionCompanion(sessionId) || config.companion;
  const companion = loadCompanion(companionName);

  const message = hookData.message || 'Notification';
  const title = hookData.title || companion.name;

  notify({
    title,
    subtitle: hookData.notification_type || '',
    message,
    config,
  });

  if (config.notify.tts_on_stop) {
    await enqueue(message, companion, config);
  }
});
