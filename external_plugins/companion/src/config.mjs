import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const CONFIG_PATH = join(PLUGIN_ROOT, 'config.yaml');

const DEFAULTS = {
  companion: 'nova',
  tts: {
    engine: 'say',
    local_url: 'http://localhost:7849',
  },
  llm: {
    base_url: 'http://localhost:11434/v1',
    model: 'llama3.2',
    api_key: '',
    summary_detail: 'medium',
  },
  notify: {
    enabled: true,
    sound: true,
    tts_on_stop: true,
    tts_on_error: true,
    summary_after_minutes: 10,
  },
};

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return { ...DEFAULTS };
  }
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const user = yaml.load(raw) || {};
  return {
    companion: user.companion || DEFAULTS.companion,
    tts: { ...DEFAULTS.tts, ...user.tts },
    llm: { ...DEFAULTS.llm, ...user.llm },
    notify: { ...DEFAULTS.notify, ...user.notify },
  };
}

export function getPluginRoot() {
  return PLUGIN_ROOT;
}
