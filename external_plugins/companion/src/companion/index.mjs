import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { getPluginRoot } from '../config.mjs';

export function loadCompanion(name) {
  const root = getPluginRoot();

  // Check custom/ first (user overrides)
  const customPath = join(root, 'companions', 'custom', `${name}.yaml`);
  if (existsSync(customPath)) {
    return yaml.load(readFileSync(customPath, 'utf8'));
  }

  const filePath = join(root, 'companions', `${name}.yaml`);
  return yaml.load(readFileSync(filePath, 'utf8'));
}

export function listCompanions() {
  const root = getPluginRoot();
  const results = [];

  // Built-in companions
  const builtinDir = join(root, 'companions');
  for (const f of readdirSync(builtinDir).filter(f => f.endsWith('.yaml'))) {
    const data = yaml.load(readFileSync(join(builtinDir, f), 'utf8'));
    results.push({ name: data.name, style: data.style, file: f });
  }

  // Custom companions
  const customDir = join(root, 'companions', 'custom');
  if (existsSync(customDir)) {
    for (const f of readdirSync(customDir).filter(f => f.endsWith('.yaml'))) {
      const data = yaml.load(readFileSync(join(customDir, f), 'utf8'));
      results.push({ name: data.name, style: data.style, file: `custom/${f}`, custom: true });
    }
  }

  return results;
}

export function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function formatMessage(template, data) {
  return template.replace(/\{(\w+)\}/g, (_, key) => data[key] ?? '');
}
