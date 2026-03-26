export async function speak(text, config, companion) {
  const url = config.tts.local_url || 'http://localhost:7849';
  try {
    const body = { text };
    if (companion?.tts_voice) body.voice = companion.tts_voice;
    if (companion?.tts_lang) body.lang = companion.tts_lang;
    if (companion?.tts_speed) body.speed = companion.tts_speed;

    await fetch(`${url}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return true;
  } catch {
    return false;
  }
}
