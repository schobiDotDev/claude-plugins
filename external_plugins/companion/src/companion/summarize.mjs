import { complete } from '../llm/index.mjs';
import { readTranscript, formatTranscriptForLLM } from '../session/transcript.mjs';

const SUMMARY_LEVELS = {
  brief: {
    maxTokens: 200,
    prompt: (lang) => `Fasse in 1-2 kurzen Saetzen zusammen: Was wurde gemacht? Worauf wartet Claude?
Sprich den User direkt an. Keine Formalitaeten. Sprache: ${lang}.`,
  },
  medium: {
    maxTokens: 350,
    prompt: (lang) => `Fasse zusammen was gerade passiert ist. Nenne das Thema UND erklaere kurz den konkreten Inhalt - was wurde besprochen, gebaut oder designed? 2-3 Saetze. Technische Details sind okay wenn sie den Kern der Sache treffen. Am Ende: worauf wartet Claude jetzt?
Sprich den User direkt an. Keine Formalitaeten. Sprache: ${lang}.`,
  },
  full: {
    maxTokens: 500,
    prompt: (lang) => `Gib ein kurzes Briefing ueber die letzte Aktivitaet. Was war das Ziel? Was wurde konkret besprochen, designed oder implementiert - nenne die wichtigsten Entscheidungen oder Aenderungen. Wie ist der aktuelle Stand? 3-5 Saetze, technische Details erwuenscht. Am Ende: worauf wartet Claude und was sind die naechsten Schritte?
Sprich den User direkt an. Keine Formalitaeten. Sprache: ${lang}.`,
  },
};

function getLevel(config) {
  const level = config.llm?.summary_detail || 'medium';
  return SUMMARY_LEVELS[level] || SUMMARY_LEVELS.medium;
}

function bumpLevel(level) {
  if (level === 'brief') return 'medium';
  return 'full';
}

export async function generateStopSummary(companion, config, { transcriptPath, lastAssistantMessage, sinceLineNumber = 0 }) {
  const context = transcriptPath
    ? formatTranscriptForLLM(readTranscript(transcriptPath, 8, sinceLineNumber))
    : lastAssistantMessage || '';

  if (!context) return null;

  const level = getLevel(config);
  const lang = companion.tts_lang === 'de' ? 'Deutsch' : 'English';

  const messages = [
    {
      role: 'system',
      content: `${companion.personality}\n\nDu bist ein Session-Companion. Claude Code hat gerade gestoppt und wartet auf den User.\n${level.prompt(lang)}`,
    },
    {
      role: 'user',
      content: `Letzte Session-Aktivitaet:\n\n${context}`,
    },
  ];

  return complete(messages, config, { maxTokens: level.maxTokens });
}

export async function generateSessionSummary(companion, config, { transcriptPath }) {
  const context = transcriptPath
    ? formatTranscriptForLLM(readTranscript(transcriptPath, 15))
    : '';

  if (!context) return null;

  const configLevel = config.llm?.summary_detail || 'medium';
  const boostedLevel = SUMMARY_LEVELS[bumpLevel(configLevel)];
  const lang = companion.tts_lang === 'de' ? 'Deutsch' : 'English';

  const messages = [
    {
      role: 'system',
      content: `${companion.personality}\n\nFasse die gesamte Session zusammen.\n${boostedLevel.prompt(lang)}`,
    },
    {
      role: 'user',
      content: `Session-Verlauf:\n\n${context}`,
    },
  ];

  return complete(messages, config, { maxTokens: boostedLevel.maxTokens });
}
