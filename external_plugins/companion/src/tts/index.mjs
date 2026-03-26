import { speak as macOSSay } from './macos-say.mjs';
import { speak as localTTS } from './local.mjs';

export async function speak(text, companion, config) {
  if (!text) return;

  switch (config.tts.engine) {
    case 'local':
      return localTTS(text, config, companion);
    case 'say':
    default:
      return macOSSay(text, companion?.macos_voice || companion?.voice || 'Samantha');
  }
}
