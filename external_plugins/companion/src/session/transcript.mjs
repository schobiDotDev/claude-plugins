// Reads the Claude Code session transcript (JSONL) and extracts
// the last N messages for context-aware summaries.

import { readFileSync } from 'node:fs';

export function readTranscript(transcriptPath, lastN = 10, sinceLineNumber = 0) {
  try {
    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);

    // Only read lines since last stop (avoid repeating old content)
    const newLines = sinceLineNumber > 0 ? lines.slice(sinceLineNumber) : lines.slice(-lastN * 2);
    const recent = newLines.length > lastN * 2 ? newLines.slice(-lastN * 2) : newLines;

    const messages = [];
    for (const line of recent) {
      try {
        const entry = JSON.parse(line);

        // Extract assistant messages (what Claude said/did)
        if (entry.type === 'assistant' && entry.message?.content) {
          const content = entry.message.content;
          if (typeof content === 'string') {
            messages.push({ role: 'assistant', text: content.slice(0, 500) });
          } else if (Array.isArray(content)) {
            // Content blocks: text, tool_use, etc.
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                messages.push({ role: 'assistant', text: block.text.slice(0, 500) });
              } else if (block.type === 'tool_use') {
                messages.push({ role: 'tool', name: block.name, input: summarizeInput(block.input) });
              }
            }
          }
        }

        // Extract user messages
        if (entry.type === 'human' && entry.message?.content) {
          const content = entry.message.content;
          if (typeof content === 'string') {
            messages.push({ role: 'user', text: content.slice(0, 300) });
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                messages.push({ role: 'user', text: block.text.slice(0, 300) });
              }
            }
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return messages.slice(-lastN);
  } catch {
    return [];
  }
}

function summarizeInput(input) {
  if (!input) return '';
  // For tools like Edit/Write, show the file path
  if (input.file_path) return input.file_path;
  // For Bash, show the command
  if (input.command) return input.command.slice(0, 100);
  // For search tools, show the pattern
  if (input.pattern) return input.pattern;
  return '';
}

export function getTranscriptLineCount(transcriptPath) {
  try {
    const raw = readFileSync(transcriptPath, 'utf8');
    return raw.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function formatTranscriptForLLM(messages) {
  return messages.map(m => {
    if (m.role === 'tool') return `[Tool: ${m.name}] ${m.input}`;
    if (m.role === 'user') return `[User] ${m.text}`;
    return `[Claude] ${m.text}`;
  }).join('\n');
}
