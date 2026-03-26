import { loadConfig } from '../config.mjs';
import { loadCompanion, listCompanions, pickRandom } from '../companion/index.mjs';
import { getCompanionForSession } from '../session/persistence.mjs';
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

  const sessionId = hookData.session_id || `fallback-${Date.now()}`;
  const project = hookData.cwd ? hookData.cwd.split('/').pop() : '';

  // Get all available companion names
  const available = listCompanions().map(c => c.file.replace('.yaml', ''));

  // Assign or retrieve persistent companion for this session
  const assignment = getCompanionForSession(sessionId, available);
  const companion = loadCompanion(assignment.name);

  // First time meeting this companion? Play introduction
  if (assignment.needsIntroduction && companion.introduction) {
    notify({
      title: `Neuer Companion: ${companion.name}`,
      subtitle: project,
      message: companion.introduction,
      config,
    });

    if (config.notify.tts_on_stop) {
      await enqueue(companion.introduction, companion, config);
    }
  } else {
    // Regular greeting
    const greeting = pickRandom(companion.greetings);

    notify({
      title: companion.name,
      subtitle: project ? `Session in ${project}` : 'Session gestartet',
      message: greeting,
      config,
    });

    if (config.notify.tts_on_stop) {
      await enqueue(greeting, companion, config);
    }
  }
});
