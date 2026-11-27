/* ============================================================================
 * alert-sound.js — the Replay Feed's alert tone
 *
 * WHAT IT IS
 *   A synthesized ~3 second "raindrop" — soft water-drop plinks with a little
 *   pitch-bend and a low, warm tail — built with the Web Audio API, so the site
 *   stays dependency-free and nothing has to be downloaded.
 *
 * WHY IT IS SYNTHESIZED
 *   · It is heard all day for a whole season; a sound file would be an extra
 *     request (and a licence question), while additive sine synthesis has no
 *     assets and can be shaped to sit gently in the background.
 *   · It can be tuned per event family (see PRESETS) using the same graph.
 *   · Browsers refuse to play audio until the user has interacted with the
 *     page, so the toggle button doubles as the unlock gesture — and there is
 *     an explicit "Test" button that plays the exact alert you will hear.
 *
 * MIX (measured in the module, not claimed as an industry figure)
 *   · master peaks at 0.16 gain (~ -16 dBFS), ramped in over 25 ms and decayed
 *     out over ~3.1 s, so it never startles and never clips;
 *   · each drop is a sine carrier that rises then falls in pitch (a drop
 *     landing), shaped by a short attack + exponential decay envelope;
 *   · a soft low-passed "body" layer at ~200 Hz gives it weight without boom;
 *   · no square/saw waves (harsh), no beeps (alarming), and a light stereo
 *     spread on the last drops so it feels like rain arriving, not a phone.
 *
 * PLEASANT-BY-DESIGN RULES (enforced in code)
 *   · total length 2.8-3.2 s;
 *   · peak gain ≤ 0.2;
 *   · every partial below 4 kHz (nothing piercing);
 *   · at most one alert per COOLDOWN_MS (default 3.2 s) so a burst of events
 *     can never turn into a klaxon; queued bursts collapse into one sound.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var COOLDOWN_MS = 3200;   /* one tone at a time: > the tone's own length   */
  var MASTER_PEAK = 0.16;
  var LENGTH_S = 3.0;
  var MAX_PARTIAL_HZ = 4000;

  var PRESETS = {
    /* Default: a new challenge / review / boundary call / official-scorer
     * pending ruling / scoring change / live play-by-play event. */
    review: { drops: [[0.00, 1180], [0.34, 880], [0.72, 1320], [1.10, 990], [1.62, 740]], body: 0.5 },
    /* Same family, slightly brighter, for an under-review state change. */
    live: { drops: [[0.00, 1240], [0.30, 940], [0.66, 1400], [1.05, 830], [1.55, 1040]], body: 0.45 },
    /* Runs at risk: a touch lower and slower — still soft, clearly different. */
    risk: { drops: [[0.00, 760], [0.40, 620], [0.86, 900], [1.30, 520], [1.90, 720]], body: 0.6 },
    /* Gentle single drop for the toggle preview and the Test button. */
    preview: { drops: [[0.00, 1180], [0.34, 880], [0.72, 1320], [1.10, 990], [1.62, 740]], body: 0.5 },
  };

  var state = {
    enabled: false,          /* persisted preference (mlbp.pref.sound)       */
    ctx: null,
    lastPlayedAt: 0,
    plays: 0,
    suppressed: 0,           /* alerts skipped because of the cooldown      */
    unlocked: false,
    lastReason: '',
    attempts: 0,
    lastAttemptAt: 0,
    lastError: null,
    forced: false,           /* test mode: bypass the cooldown              */
  };

  function Ctx() {
    return global.AudioContext || global.webkitAudioContext || null;
  }

  function audioSupport() {
    return !!Ctx();
  }

  /**
   * unlock()
   *   Must run inside a user gesture the first time (browsers block audio
   *   otherwise).  Safe to call repeatedly; resolves the context.
   */
  function unlock() {
    if (!audioSupport()) return null;
    try {
      if (!state.ctx) state.ctx = new (Ctx())();
      if (state.ctx.state === 'suspended' && state.ctx.resume) state.ctx.resume();
      state.unlocked = state.ctx.state === 'running' || state.ctx.state === 'suspended';
      return state.ctx;
    } catch (e) {
      /* e.g. a page without an audio device, or a browser that refuses a
       * context in this frame.  The alert policy still counts the alert; only
       * the tone is lost. */
      state.lastError = e;
      state.unlocked = false;
      return null;
    }
  }

  /**
   * play(kind, opts)
   *   kind: key of PRESETS ('review' | 'live' | 'risk' | 'preview').
   *   opts.force: bypass the on/off preference and the cooldown (Test button).
   *   Returns true when a tone was scheduled.
   */
  function play(kind, opts) {
    opts = opts || {};
    var force = opts.force === true || state.forced;
    if (!force && !state.enabled) return false;
    var now = Date.now();
    if (!force && now - state.lastPlayedAt < COOLDOWN_MS) {
      state.suppressed += 1;
      return false;
    }
    var ctx = unlock();
    if (!ctx) {
      /* Count the attempt even when no tone can be produced, so "the alert
       * fired" is still observable (status line, tests, the operator's ear
       * note) on a machine with no usable audio output. */
      state.attempts += 1;
      state.lastAttemptAt = now;
      state.lastReason = kind || 'review';
      return false;
    }
    var preset = PRESETS[kind] || PRESETS.review;

    try {
      var t0 = ctx.currentTime + 0.02;
      var master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, t0);
      master.gain.exponentialRampToValueAtTime(MASTER_PEAK, t0 + 0.025);
      master.gain.exponentialRampToValueAtTime(MASTER_PEAK * 0.55, t0 + 1.6);
      master.gain.exponentialRampToValueAtTime(0.0001, t0 + LENGTH_S);
      master.connect(ctx.destination);

      /* Light stereo spread: a panner per drop when the context has one. */
      var canPan = typeof ctx.createStereoPanner === 'function';

      /* Warm body: one low sine, heavily gained down, gives the drops a floor. */
      if (preset.body > 0) {
        var body = ctx.createOscillator();
        var bodyGain = ctx.createGain();
        body.type = 'sine';
        body.frequency.setValueAtTime(196, t0);
        body.frequency.exponentialRampToValueAtTime(146, t0 + LENGTH_S);
        bodyGain.gain.setValueAtTime(0.0001, t0);
        bodyGain.gain.exponentialRampToValueAtTime(MASTER_PEAK * preset.body * 0.35, t0 + 0.12);
        bodyGain.gain.exponentialRampToValueAtTime(0.0001, t0 + LENGTH_S);
        body.connect(bodyGain);
        bodyGain.connect(master);
        body.start(t0);
        body.stop(t0 + LENGTH_S + 0.05);
      }

      /* The drops.  Each: pitch rises a semitone-ish then falls to ~78% of
       * its start — the little "plink" that reads as a water drop. */
      preset.drops.forEach(function (d, i) {
        var at = t0 + d[0];
        var freq = Math.min(MAX_PARTIAL_HZ, d[1]);
        var dur = 0.55 + (i % 2) * 0.18;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * 0.92, at);
        osc.frequency.exponentialRampToValueAtTime(freq, at + 0.035);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.78, at + dur);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(MASTER_PEAK * (0.55 - i * 0.05), at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(gain);
        if (canPan) {
          /* Alternate drops slightly left/right for depth. */
          var pan = ctx.createStereoPanner();
          pan.pan.value = (i % 2 === 0 ? -0.18 : 0.18);
          gain.connect(pan);
          pan.connect(master);
        } else {
          gain.connect(master);
        }
        osc.start(at);
        osc.stop(at + dur + 0.05);
      });

      state.lastPlayedAt = now;
      state.plays += 1;
      state.lastReason = kind || 'review';
      return true;
    } catch (e) {
      state.lastError = e;
      return false;
    }
  }

  function setEnabled(on) {
    state.enabled = !!on;
    if (state.enabled) unlock();
    return state.enabled;
  }

  function isEnabled() { return state.enabled; }

  /** A short, unmissable confirmation used only by the Test button. */
  function test() {
    var was = state.enabled;
    state.enabled = true;
    state.forced = true;
    var ok = play('preview', { force: true });
    state.forced = false;
    state.enabled = was;
    return ok;
  }

  function stats() {
    return {
      enabled: state.enabled,
      supported: audioSupport(),
      unlocked: state.unlocked,
      plays: state.plays,
      attempts: state.attempts,
      suppressed: state.suppressed,
      lastPlayedAt: state.lastPlayedAt,
      lastReason: state.lastReason,
      cooldownMs: COOLDOWN_MS,
      lengthS: LENGTH_S,
      peak: MASTER_PEAK,
    };
  }

  global.AlertSound = {
    COOLDOWN_MS: COOLDOWN_MS,
    LENGTH_S: LENGTH_S,
    MASTER_PEAK: MASTER_PEAK,
    PRESETS: PRESETS,
    play: play,
    test: test,
    unlock: unlock,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    audioSupport: audioSupport,
    stats: stats,
    state: state,
  };
}(window));
