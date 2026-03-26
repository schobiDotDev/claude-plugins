# Companion

AI session companion for Claude Code with personality, voice (TTS), smart summaries, and notifications.

## Features

- **9 built-in companions** with unique personalities and TTS voices
- **Local TTS** via Qwen3-TTS on Apple Silicon (macOS Say fallback)
- **Smart summaries** powered by local LLM (Ollama) - configurable detail level
- **macOS notifications** with click-to-focus terminal
- **Custom companions** - drop a YAML in `companions/custom/`

## Install

```
/plugin install companion@schobidotdev
```

Then run:

```
/companion setup
```

The setup wizard guides you through companion selection, TTS, LLM, and notifications.

## Companions

| Name | Style | Description |
|------|-------|-------------|
| Nova | Professional | Ruhig, knapp, sachlich |
| Rex | Direct | Direkt, keine Floskeln |
| Aria | Friendly | Ermutigend, warmherzig |
| Kai | Calm | Ruhig, bedacht, zen-artig |
| Hiro | Focused | Konzentriert, effizient |
| Luna | Creative | Kreativ, neugierig |
| Mei | Supportive | Unterstuetzend, geduldig |
| Chen | Analytical | Analytisch, praezise |
| Odin | Stoic | Stoisch, weise |

## Summary Detail Levels

Configure in `config.yaml` under `llm.summary_detail`:

- **brief** - 1-2 Saetze, Thema + Status
- **medium** - 2-3 Saetze, Thema + konkreter Inhalt + Status (default)
- **full** - 3-5 Saetze, volles Briefing mit Entscheidungen

## Custom Companions

Create a YAML file in `companions/custom/`:

```yaml
name: MyCompanion
tts_voice: serena
tts_lang: de
tts_speed: 1.0
macos_voice: Samantha
style: custom
personality: |
  Deine Persoenlichkeitsbeschreibung hier.
introduction: |
  Vorstellungstext beim ersten Treffen.
greetings:
  - "Hallo!"
farewells:
  - "Tschuess!"
on_error:
  - "Fehler passiert."
on_stop:
  - "Warte auf dich."
```

## Requirements

- macOS (Apple Silicon recommended for local TTS)
- Node.js 18+
- Optional: Python 3.12+ (for Qwen3-TTS)
- Optional: Ollama (for smart summaries)
- Optional: terminal-notifier (`brew install terminal-notifier`)

## License

MIT
