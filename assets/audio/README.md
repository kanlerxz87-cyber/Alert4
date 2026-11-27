# assets/audio/

`alert-raindrop.wav` — the pre-rendered copy of the alert figure.

- **What it is:** the same ~3 s six-drop raindrop the site synthesises live in
  `assets/js/alert-sound.js`, rendered offline with identical design parameters
  (drop pitches E6 1318 · C6 1046 · D6 1174 · A5 880 · E6 1318 · E5 659, 12 ms
  raised-cosine attacks, a low E3/A3 pad underneath, a quiet 3.3 kHz surface
  transient per drop, master scaled to −5 dBFS).
- **Why it exists:** (1) it is the fallback when a browser refuses to start a
  Web Audio context (`playFile()` in `alert-sound.js`), and (2) it lets you
  listen to the alert without waiting for a game — open it directly, or press
  **▶ Test sound** on the scoreboard/replay feed/game page.
- **Regenerate:** `python3 tools/make-alert-wav.py` (no dependencies; the
  parameters in that script are the single source of truth and match `phrase()`
  in `alert-sound.js`).
- **License:** generated for this project; no third-party samples.

The live path is the synthesiser, not this file: a file would have to finish
loading before it could ring, and Web Audio needs no network at all.
