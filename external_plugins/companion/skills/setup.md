# Companion Setup

Interactive setup wizard for the Companion plugin. Walk through each step, ask the user at each decision point, and generate `config.yaml`.

## Prerequisites

This skill file lives in the plugin root at `skills/setup.md`. The plugin root is the parent of the `skills/` directory.

## Steps

### Step 1: Choose Companion

Show the user this table and ask which companion they want:

| Name | Style | Voice | Description |
|------|-------|-------|-------------|
| **Nova** | Professional | serena | Ruhig, knapp, sachlich |
| **Rex** | Direct | ryan | Direkt, keine Floskeln, leicht sarkastisch |
| **Aria** | Friendly | vivian | Ermutigend, warmherzig, feiert Erfolge |
| **Kai** | Calm | uncle_fu | Ruhig, bedacht, zen-artig |
| **Hiro** | Focused | aiden | Konzentriert, effizient, aufgabenorientiert |
| **Luna** | Creative | ono_anna | Kreativ, neugierig, inspirierend |
| **Mei** | Supportive | sohee | Unterstuetzend, geduldig, ermutigend |
| **Chen** | Analytical | eric | Analytisch, datengetrieben, praezise |
| **Odin** | Stoic | dylan | Stoisch, weise, wenig Worte |

Default: Nova

Also mention: "Du kannst eigene Companions erstellen - leg einfach eine YAML-Datei in `companions/custom/` ab."

Save the choice as `$COMPANION`.

### Step 2: TTS Engine

Ask the user which TTS engine they want:

**a) Local TTS (Qwen3-TTS)** - Beste Qualitaet, braucht Apple Silicon + ~3GB
**b) macOS Say** - Sofort ready, keine Installation
**c) Skip** - Kein TTS

**If Local TTS chosen:**

1. Check Python 3.12+:
   ```bash
   python3 --version
   ```
   If not found or < 3.12: "Python 3.12+ wird benoetigt. Installiere mit `brew install python@3.12` oder waehle macOS Say als Alternative."

2. Check Apple Silicon:
   ```bash
   uname -m
   ```
   Must be `arm64`. If not: "MLX benoetigt Apple Silicon (M1/M2/M3/M4). Fallback auf macOS Say."

3. Create venv and install dependencies:
   ```bash
   python3 -m venv "$PLUGIN_ROOT/tts-server/.venv"
   "$PLUGIN_ROOT/tts-server/.venv/bin/pip" install -r "$PLUGIN_ROOT/tts-server/requirements.txt"
   ```
   This takes 2-5 minutes. Tell the user.

4. Start the TTS server:
   ```bash
   "$PLUGIN_ROOT/tts-server/.venv/bin/python" "$PLUGIN_ROOT/tts-server/server.py" &
   ```
   Wait up to 10s for health check:
   ```bash
   curl -s http://localhost:7849/health
   ```

5. Test TTS:
   ```bash
   curl -s http://localhost:7849/speak -d '{"text":"Setup erfolgreich. Ich bin bereit.","voice":"serena","lang":"de"}'
   ```
   Ask user: "Hast du die Stimme gehoert?"

If any step fails: explain what went wrong, offer to skip to macOS Say or abort.

Save: `$TTS_ENGINE` = `local` or `say`, `$TTS_URL` = `http://localhost:7849`

### Step 3: LLM for Summaries

Ask the user:

**a) Ollama (lokal)** - Empfohlen, laeuft komplett offline
**b) OpenAI-compatible API** - Cloud-basiert, braucht API Key
**c) Skip** - Keine Summaries, nur statische Companion-Messages

**If Ollama chosen:**

1. Check if Ollama is installed:
   ```bash
   which ollama
   ```
   If not found: "Ollama nicht gefunden. Installiere mit `brew install ollama`" and run the install.

2. Check if Ollama is running:
   ```bash
   curl -s http://localhost:11434/api/tags
   ```
   If not responding: "Starte Ollama mit `ollama serve`" or `brew services start ollama`.

3. Pull recommended model:
   ```bash
   ollama pull qwen3.5:9b
   ```
   Ask user first: "Empfohlenes Model: qwen3.5:9b (~5GB). Oder gib ein anderes Model an."

4. Test completion:
   ```bash
   curl -s http://localhost:11434/api/chat -d '{"model":"qwen3.5:9b","messages":[{"role":"user","content":"Sag hallo in einem Satz."}],"stream":false,"think":false,"options":{"num_predict":50}}'
   ```

Save: `$LLM_BASE_URL` = `http://localhost:11434/v1`, `$LLM_MODEL` = chosen model, `$LLM_API_KEY` = ""

**If OpenAI-compatible chosen:**

Ask for: base_url, model name, api_key. Test with a simple completion request.

Save the values.

**If Skip chosen:**

Save: `$LLM_BASE_URL` = "", `$LLM_MODEL` = ""

### Step 4: Summary Detail Level

Only ask if LLM was configured (not skipped).

"Wie detailliert sollen die Summaries sein?"

- **brief** - 1-2 Saetze, nur Thema + Status
- **medium** (empfohlen) - 2-3 Saetze, Thema + konkreter Inhalt + Status
- **full** - 3-5 Saetze, volles Briefing mit Entscheidungen und naechsten Schritten

Default: medium

Save: `$SUMMARY_DETAIL`

### Step 5: Notifications

1. Check terminal-notifier:
   ```bash
   which terminal-notifier
   ```
   If not found: "terminal-notifier wird fuer macOS Notifications benoetigt. Installiere mit `brew install terminal-notifier`" and run the install.

2. Ask: "Sound bei Notifications? (ja/nein)" Default: ja

3. Test notification:
   ```bash
   terminal-notifier -title "Companion" -subtitle "Setup" -message "Test Notification!" -sound default
   ```

Save: `$NOTIFY_SOUND` = true/false

### Step 6: Write config.yaml

Summarize all choices to the user and ask for confirmation. Then write `config.yaml` in the plugin root:

```yaml
companion: $COMPANION

tts:
  engine: $TTS_ENGINE
  local_url: $TTS_URL

llm:
  base_url: $LLM_BASE_URL
  model: $LLM_MODEL
  api_key: "$LLM_API_KEY"
  summary_detail: $SUMMARY_DETAIL

notify:
  enabled: true
  sound: $NOTIFY_SOUND
  tts_on_stop: true
  tts_on_error: true
  summary_after_minutes: 10
```

If LLM was skipped, set `tts_on_stop: true` but summaries will gracefully fall back to static companion messages (existing fallback behavior in stop.mjs).

### Step 7: Finish

Tell the user: "Setup abgeschlossen! Dein Companion **$COMPANION** begruesst dich bei der naechsten Session."

If TTS is active, speak the farewell message using the chosen companion's voice.
