// TTS Queue - ensures messages play sequentially, never overlapping.
// Hooks call enqueue() instead of speak() directly.

import { speak } from './index.mjs';

const queue = [];
let playing = false;
const MAX_QUEUE = 5;

export async function enqueue(text, companion, config) {
  if (!text) return;

  // If queue is full, batch remaining into summary
  if (queue.length >= MAX_QUEUE) {
    queue.push({ text: `${queue.length + 1} Nachrichten warten.`, companion, config, batched: true });
    // Remove individual entries, keep the batch summary
    queue.splice(0, queue.length - 1);
    return;
  }

  queue.push({ text, companion, config });

  if (!playing) {
    await processQueue();
  }
}

async function processQueue() {
  playing = true;

  while (queue.length > 0) {
    const item = queue.shift();
    try {
      await speak(item.text, item.companion, item.config);
    } catch {
      // Never block on TTS failure
    }
  }

  playing = false;
}

export function getQueueLength() {
  return queue.length;
}

export function isPlaying() {
  return playing;
}
