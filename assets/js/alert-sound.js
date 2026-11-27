/* ============================================================================
 * alert-sound.js — isolated alert-sound system for the Replay Feed
 *
 * A single, pleasant 3-second "raindrop" chime (pure WebAudio synthesis, no
 * audio files) that fires for every event that appears in the alert feed:
 * manager challenges, umpire/crew-chief reviews, instant-replay reviews,
 * boundary calls, ABS pitch challenges, official-scorer pending rulings,
 * official scoring changes, and runs-at-risk warnings.
 *
 * Design goals (from the latency / alert-sound / live-state brief):
 *   - Pleasant enough to hear all day for an entire season: soft sine
 *     raindrops on a warm pentatonic ladder, a low warm pad, gentle rain
 *     ambience and a light echo. No harsh transients, no loud peaks.
 *   - Exactly ~3 seconds per chime, with a short cooldown so a burst of
 *     simultaneous events cannot stack into a wall of sound.
 *   - Toggle on/off to test the system (the toggle itself plays a preview
 *     chime when switched on, and a dedicated Test button replays it).
 *   - Fully isolated: this module owns its AudioContext, its preference
 *     storage and its cooldown. It imports nothing from the feed, the
 *     scoring log or the game-state capture, and nothing in those modules
 *     imports it except the feed's `chime()` bridge. A change here cannot
 *     break persistence, and a persistence failure cannot silence alerts.
 *   - No DOM lookups: the page binds its own buttons and calls
 *     AlertSound.setEnabled()/test()/play(). This keeps the module usable
 *     from any page and keeps the contract-check id audit trivial.
 *
 * TOS / browser notes: audio is synthesized locally; no network, no files.
 * Browsers block audio until a user gesture, so the first chime after page
 * load may be silent until the user clicks — the toggle/test button is the
 * gesture that unlocks the context. If WebAudio is unavailable the module
 * is a silent no-op (alerts still appear visually).
 * ==========================================================================*/
(function (global) {
  'use strict';

  var PREF_KEY = 'mlbp.pref.sound';
  var VOLUME_KEY = 'mlbp.pref.soundVolume';
  var DURATION_MS = 3000;
  var COOLDOWN_MS = 1500;

  var state = {
    enabled: false,
    volume: 0.5,
    audioCtx: null,
    master: null,
    lastPlayedAt: 0,
    playCount: 0,
    playing: false,
  };

  function loadPref() {
    try {
      var raw = global.localStorage.getItem(PREF_KEY);
      state.enabled = raw === '1';
    } catch (e) { state.enabled = false; }
    try {
      var rawVol = global.localStorage.getItem(VOLUME_KEY);
      if (rawVol !== null && rawVol !== undefined && rawVol !== '') {
        var v = Number(rawVol);
        if (isFinite(v) && v >= 0 && v <= 1) state.volume = v;
      }
    } catch (e) { /* keep default */ }
  }

  function savePref() {
    try { global.localStorage.setItem(PREF_KEY, state.enabled ? '1' : '0'); } catch (e) { /* ignore */ }
    try { global.localStorage.setItem(VOLUME_KEY, String(state.volume)); } catch (e) { /* ignore */ }
  }

  function Ctx() {
    return global.AudioContext || global.webkitAudioContext || null;
  }

  function ensureContext() {
    var AC = Ctx();
    if (!AC) return null;
    if (!state.audioCtx) {
      try { state.audioCtx = new AC(); } catch (e) { return null; }
    }
    if (state.audioCtx.state === 'suspended' && state.audioCtx.resume) {
      try { state.audioCtx.resume(); } catch (e) { /* ignore */ }
    }
    return state.audioCtx;
  }

  /* One raindrop: a sine that starts bright and falls a perfect fifth,
   * with a soft attack and a long exponential decay. `peak` is 0..1. */
  function drop(ctx, dest, at, freqStart, freqEnd, dur, peak) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freqStart, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), at + dur);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(at);
    osc.stop(at + dur + 0.05);
    /* A faint octave-up shimmer so the drop feels like water, not a bell. */
    var shimmer = ctx.createOscillator();
    var shimmerGain = ctx.createGain();
    shimmer.type = 'sine';
    shimmer.frequency.setValueAtTime(freqStart * 2, at);
    shimmer.frequency.exponentialRampToValueAtTime(Math.max(80, freqEnd * 2), at + dur * 0.7);
    shimmerGain.gain.setValueAtTime(0.0001, at);
    shimmerGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.18), at + 0.012);
    shimmerGain.gain.exponentialRampToValueAtTime(0.0001, at + dur * 0.7);
    shimmer.connect(shimmerGain);
    shimmerGain.connect(dest);
    shimmer.start(at);
    shimmer.stop(at + dur * 0.7 + 0.05);
  }

  /* Warm pad note: triangle + sine sub, slow attack, long release. */
  function pad(ctx, dest, at, freq, dur, peak) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + dur * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  /* Filtered-noise rain ambience for the full 3s, very quiet. */
  function rain(ctx, dest, at, dur, peak) {
    var len = Math.floor(ctx.sampleRate * dur);
    var buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * 0.5;
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.4;
    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    src.start(at);
    src.stop(at + dur + 0.05);
  }

  /**
   * Play the 3-second raindrop chime.
   * kind: 'review' | 'risk' | 'pending' | 'scoring' | 'abs' | 'live' | 'preview'
   * Variations are gentle pitch shifts on the same pleasant ladder so the
   * whole season stays one recognisable sound, with runs-at-risk a touch
   * brighter. Returns true when a chime was scheduled.
   */
  function play(kind) {
    if (!state.enabled && kind !== 'preview') return false;
    var now = Date.now();
    if (kind !== 'preview' && now - state.lastPlayedAt < COOLDOWN_MS) return false;
    var ctx = ensureContext();
    if (!ctx) return false;
    state.lastPlayedAt = now;
    state.playCount += 1;
    state.playing = true;

    try {
      var t0 = ctx.currentTime + 0.02;
      var master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, t0);
      master.gain.exponentialRampToValueAtTime(0.0001 + state.volume * 0.35, t0 + 0.06);
      master.gain.setValueAtTime(0.0001 + state.volume * 0.35, t0 + DURATION_MS / 1000 - 0.6);
      master.gain.exponentialRampToValueAtTime(0.0001, t0 + DURATION_MS / 1000);
      master.connect(ctx.destination);

      /* Light echo: one tap at 0.28s, low feedback, so drops bloom. */
      var delay = ctx.createDelay(1);
      delay.delayTime.value = 0.28;
      var feedback = ctx.createGain();
      feedback.gain.value = 0.22;
      var wet = ctx.createGain();
      wet.gain.value = 0.18;
      master.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(ctx.destination);

      var dur = DURATION_MS / 1000;
      var bright = kind === 'risk' ? 1.12 : kind === 'scoring' ? 0.94 : kind === 'pending' ? 1.0 : 1.0;

      /* Three raindrops on a C-major pentatonic ladder (C6, A5, E6, G5). */
      drop(ctx, master, t0 + 0.00, 1568 * bright, 1175 * bright, 0.45, 0.55);
      drop(ctx, master, t0 + 0.38, 1319 * bright, 988 * bright, 0.50, 0.48);
      drop(ctx, master, t0 + 0.78, 1760 * bright, 1319 * bright, 0.55, 0.42);
      drop(ctx, master, t0 + 1.25, 1047 * bright, 784 * bright, 0.60, 0.30);

      /* Warm pad underneath: C5 + E5, fading over the full 3s. */
      pad(ctx, master, t0, 523.25 * bright, dur, 0.10);
      pad(ctx, master, t0 + 0.1, 659.25 * bright, dur - 0.1, 0.08);

      /* Rain ambience. */
      rain(ctx, master, t0, dur, 0.035);

      setTimeout(function () { state.playing = false; }, DURATION_MS + 100);
      return true;
    } catch (e) {
      state.playing = false;
      return false;
    }
  }

  function setEnabled(on) {
    state.enabled = !!on;
    savePref();
    if (state.enabled) {
      /* Unlock + preview so the user hears the exact sound they just enabled. */
      ensureContext();
      play('preview');
    }
    return state.enabled;
  }

  function toggle() {
    return setEnabled(!state.enabled);
  }

  function test() {
    /* Test always plays (even if the toggle is off) so the user can verify
     * the sound without changing their alert preference. It also unlocks
     * the AudioContext from this user gesture. */
    var wasEnabled = state.enabled;
    state.enabled = true;
    var ok = play('preview');
    state.enabled = wasEnabled;
    return ok;
  }

  function setVolume(v) {
    var n = Number(v);
    if (!isFinite(n)) return state.volume;
    state.volume = Math.min(1, Math.max(0, n));
    savePref();
    return state.volume;
  }

  loadPref();

  global.AlertSound = {
    DURATION_MS: DURATION_MS,
    COOLDOWN_MS: COOLDOWN_MS,
    isEnabled: function () { return state.enabled; },
    setEnabled: setEnabled,
    toggle: toggle,
    test: test,
    play: play,
    setVolume: setVolume,
    getVolume: function () { return state.volume; },
    isPlaying: function () { return state.playing; },
    stats: function () {
      return {
        enabled: state.enabled,
        volume: state.volume,
        playCount: state.playCount,
        lastPlayedAt: state.lastPlayedAt,
        durationMs: DURATION_MS,
        cooldownMs: COOLDOWN_MS,
        hasAudio: !!Ctx(),
      };
    },
    state: state,
  };
}(window));
