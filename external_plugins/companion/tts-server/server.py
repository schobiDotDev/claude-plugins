"""
Claude TTS Server - Persistent local TTS daemon for Claude Code hooks & skills.

Loads Qwen3-TTS model once into memory and serves requests via HTTP.
Any hook, skill, or script can generate speech with a single curl call:

    curl -s http://localhost:7849/speak -d '{"text":"Hello"}'

Endpoints:
    POST /speak   - Generate and play TTS audio
    GET  /health  - Check server status
    GET  /voices  - List available voices
    POST /config  - Update defaults (voice, lang, speed)
"""

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
HOST = "127.0.0.1"
PORT = 7849
MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
CACHE_DIR = Path(__file__).parent / "cache"
PID_FILE = Path(__file__).parent / "server.pid"
LOG_FILE = Path(__file__).parent / "server.log"

# Mutable defaults - can be changed at runtime via /config
DEFAULTS = {
    "voice": "sohee",
    "lang": "auto",
    "speed": 1.0,
}

# German keyword heuristic for auto language detection
DE_KEYWORDS = (
    "wartet", "benachrichtigung", "bereit", "fertig", "auf dich",
    "braucht", "eingabe", "antwort", "projekt", "zusammenfassung",
    "claude wartet", "erledigt", "fehler", "achtung",
)

# ---------------------------------------------------------------------------
# Model loading (once) + serial generation queue
# ---------------------------------------------------------------------------
model = None
model_lock = threading.Lock()
speak_queue = queue.Queue()
_worker_started = False


def ensure_model():
    global model
    if model is not None:
        return model
    with model_lock:
        if model is not None:
            return model
        log("Loading model...")
        from mlx_audio.tts.utils import load_model
        model = load_model(MODEL_ID)
        log(f"Model loaded: {MODEL_ID}")
        return model


def detect_lang(text: str) -> str:
    lower = text.lower()
    for kw in DE_KEYWORDS:
        if kw in lower:
            return "de"
    return "en"


def generate_and_play(text: str, voice: str, lang: str, speed: float):
    """Generate TTS audio and play it."""
    mdl = ensure_model()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    resolved_lang = detect_lang(text) if lang == "auto" else lang

    from mlx_audio.tts.generate import generate_audio
    result = generate_audio(
        model=mdl,
        text=text,
        voice=voice,
        lang_code=resolved_lang,
        speed=speed,
        output_path=str(CACHE_DIR),
        file_prefix="tts",
        verbose=False,
    )

    # Play the generated wav file
    wav_path = CACHE_DIR / "tts_000.wav"
    if wav_path.exists():
        subprocess.Popen(
            ["afplay", str(wav_path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def log(msg: str):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------
class TTSHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress default request logging
        pass

    def _send_json(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "model": MODEL_ID,
                "model_loaded": model is not None,
                "defaults": DEFAULTS,
            })
        elif self.path == "/voices":
            self._send_json(200, {
                "voices": ["serena", "vivian", "uncle_fu", "ryan",
                           "aiden", "ono_anna", "sohee", "eric", "dylan"],
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/speak":
            self._handle_speak()
        elif self.path == "/config":
            self._handle_config()
        else:
            self._send_json(404, {"error": "not found"})

    def _handle_speak(self):
        try:
            body = self._read_body()
            text = body.get("text", "").strip()
            if not text:
                self._send_json(400, {"error": "text is required"})
                return

            voice = body.get("voice", DEFAULTS["voice"])
            lang = body.get("lang", DEFAULTS["lang"])
            speed = float(body.get("speed", DEFAULTS["speed"]))

            # Enqueue for serial processing (never concurrent GPU access)
            ensure_worker()
            speak_queue.put((text, voice, lang, speed))
            self._send_json(200, {
                "status": "queued",
                "voice": voice,
                "lang": lang,
                "queue_size": speak_queue.qsize(),
            })

        except Exception as e:
            log(f"Error in /speak: {e}")
            self._send_json(500, {"error": str(e)})

    def _handle_config(self):
        try:
            body = self._read_body()
            for key in ("voice", "lang", "speed"):
                if key in body:
                    DEFAULTS[key] = body[key]
            self._send_json(200, {"defaults": DEFAULTS})
        except Exception as e:
            self._send_json(500, {"error": str(e)})


def _safe_generate(text, voice, lang, speed):
    try:
        generate_and_play(text, voice, lang, speed)
    except Exception as e:
        log(f"TTS generation failed: {e}")
        # Fallback to macOS say
        subprocess.Popen(
            ["say", text],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def _queue_worker():
    """Serial worker - processes one TTS request at a time. Never concurrent."""
    while True:
        item = speak_queue.get()
        if item is None:
            break
        text, voice, lang, speed = item
        _safe_generate(text, voice, lang, speed)
        speak_queue.task_done()


def ensure_worker():
    global _worker_started
    if not _worker_started:
        _worker_started = True
        t = threading.Thread(target=_queue_worker, daemon=True)
        t.start()


# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------
def write_pid():
    PID_FILE.write_text(str(os.getpid()))


def cleanup_pid():
    try:
        PID_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def main():
    log(f"Starting TTS server on {HOST}:{PORT}")
    write_pid()

    # Pre-load model in background so first request is fast
    threading.Thread(target=ensure_model, daemon=True).start()

    server = HTTPServer((HOST, PORT), TTSHandler)
    try:
        log("Server ready.")
        server.serve_forever()
    except KeyboardInterrupt:
        log("Shutting down.")
    finally:
        server.server_close()
        cleanup_pid()


if __name__ == "__main__":
    main()
