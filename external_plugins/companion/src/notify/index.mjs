import { execFile } from 'node:child_process';

function detectTerminalBundleId() {
  const bundleId = process.env.__CFBundleIdentifier || '';
  if (bundleId) return bundleId;

  switch (process.env.TERM_PROGRAM) {
    case 'iTerm.app':     return 'com.googlecode.iterm2';
    case 'Apple_Terminal': return 'com.apple.Terminal';
    case 'ghostty':       return 'com.mitchellh.ghostty';
    case 'vscode':        return 'com.microsoft.VSCode';
    default:              return 'com.apple.Terminal';
  }
}

export function notify({ title, subtitle, message, config }) {
  if (!config.notify.enabled) return;

  const bundleId = detectTerminalBundleId();
  const args = [
    '-title', title || 'Companion',
    '-subtitle', subtitle || '',
    '-message', message || '',
    '-group', `companion-${process.pid}`,
    '-execute', `open -b ${bundleId}`,
  ];

  if (config.notify.sound) {
    args.push('-sound', 'default');
  }

  execFile('terminal-notifier', args, () => {});
}

export function isTerminalNotifierInstalled() {
  return new Promise((resolve) => {
    execFile('which', ['terminal-notifier'], (err) => {
      resolve(!err);
    });
  });
}
