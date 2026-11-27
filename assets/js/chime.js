/* ============================================================================
 * chime.js — the alert sound, and the scoring-change sound
 *
 * Two independent players, on purpose:
 *
 *   Chime.play()        the alert sound for the replay feed (challenges,
 *                       reviews, boundary calls, official-scorer pending
 *                       rulings, runs at risk, scoring changes)
 *   Chime.playScoring() the sound for the separate scoring log section
 *
 * "Independent" is literal: the scoring log sets its own preference key, its
 * own cooldown clock and its own kind filter, so switching it off — or a bug in
 * it — cannot silence or duplicate the alert chime.  Nothing here touches
 * reviews-feed.js's alert path.
 *
 * The sound is a ~2.6 s rain drop: a soft "plip" (sine body + two short wet
 * noise transients) repeated five times with a slow left/right drift, a
 * lowpassed tail and a gentle stereo echo.  Everything is synthesised with the
 * Web Audio API — no audio file to download, nothing to decode, and the same
 * shape every time, which is what makes it listenable on a loop all season.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var DURATION_MS = 2600;
  var ALERT_COOLDOWN_MS = 2500;   // identical to the feed's own chime cooldown
  var SCORING_COOLDOWN_MS = 4000; // the log may fire more often; keep it gentler

  var contexts = { alert: null, scoring: null };
  var lastPlayed = { alert: 0, scoring: 0 };
  var prefs = {
    alert: false,
    scoring: true, // sound on by default *inside the log section*; it is labelled
  };

  /* Drop schedule: [start s, frequency Hz, body length s, pan, level] */
  var DROPS = [
    [0.00, 1180, 0.30, -0.35, 0.55],
    [0.42, 880, 0.34, 0.30, 0.50],
    [0.86, 1320, 0.28, -0.15, 0.42],
    [1.24, 1040, 0.36, 0.40, 0.46],
    [1.78, 740, 0.46, -0.25, 0.52],
    [2.18, 1560, 0.26, 0.10, 0.30],
  ];

  function AudioCtor() {
    return global.AudioContext || global.webkitAudioContext || null;
  }

  function isSupported() { return !!AudioCtor(); }

  function contextFor(which) {
    var Ctx = AudioCtor();
    if (!Ctx) return null;
    if (!contexts[which]) {
      try { contexts[which] = new Ctx(); } catch (e) { return null; }
    }
    var ctx = contexts[which];
    if (ctx.state === 'suspended' && ctx.resume) {
      try { ctx.resume(); } catch (e) { /* browser will retry on the next gesture */ }
    }
    return ctx;
  }

  /* A short wet-noise burst: the "splash" of the drop, not the pitch. */
  function noiseBuffer(ctx, seconds) {
    var frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    var buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < frames; i += 1) {
      /* Decaying white noise — the envelope does the shaping, this is just the
       * transient's texture. */
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 2.6);
    }
    return buffer;
  }

  function scheduleDrop(ctx, out, drops, at, freq, bodySeconds, pan, level) {
    var panner = null;
    if (ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      panner.connect(out);
    }
    var dest = panner || out;

    /* 1. the body: a sine that falls in pitch as it decays (a drop, not a beep) */
    var osc = ctx.createOscillator();
    var bodyGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.62, at + bodySeconds);
    bodyGain.gain.setValueAtTime(0.0001, at);
    bodyGain.gain.exponentialRampToValueAtTime(level, at + 0.012);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, at + bodySeconds);
    osc.connect(bodyGain);
    bodyGain.connect(dest);
    osc.start(at);
    osc.stop(at + bodySeconds + 0.05);

    /* 2. the splash: filtered noise transient, very short and quiet */
    var splash = ctx.createBufferSource();
    splash.buffer = noiseBuffer(ctx, Math.min(0.09, bodySeconds));
    var splashFilter = ctx.createBiquadFilter();
    splashFilter.type = 'bandpass';
    splashFilter.frequency.value = Math.min(ctx.sampleRate / 2 - 100, freq * 2.4);
    splashFilter.Q.value = 1.1;
    var splashGain = ctx.createGain();
    splashGain.gain.setValueAtTime(level * 0.5, at);
    splashGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
    splash.connect(splashFilter);
    splashFilter.connect(splashGain);
    splashGain.connect(dest);
    splash.start(at);
    splash.stop(at + 0.1);
  }

  function render(ctx, drops, volume) {
    var t0 = ctx.currentTime + 0.02;

    var master = ctx.createGain();
    master.gain.value = Math.max(0.0001, Math.min(1, volume === undefined ? 0.5 : volume));
    master.connect(ctx.destination);

    /* Gentle echo tail, so the drops sit in a space instead of clicking. */
    var delay = ctx.createDelay(0.6);
    delay.delayTime.value = 0.24;
    var feedback = ctx.createGain();
    feedback.gain.value = 0.18;
    var echoLevel = ctx.createGain();
    echoLevel.gain.value = 0.22;
    master.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(echoLevel);
    echoLevel.connect(ctx.destination);

    /* Lowpass smoothing keeps it soft (no harsh highs on a speaker all day). */
    var soft = ctx.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.value = 3400;
    soft.Q.value = 0.4;
    soft.connect(master);

    drops.forEach(function (d) {
      scheduleDrop(ctx, soft, drops, t0 + d[0], d[1], d[2], d[3], d[4]);
    });
  }

  /**
   * play(which) — 'alert' (default) or 'scoring'.
   *   • honours that player's preference and cooldown
   *   • never throws (audio is a nicety, never a failure path)
   *   • the same call from a click handler counts as the user gesture browsers
   *     require before audio may start
   */
  function play(which, opts) {
    var kind = which === 'scoring' ? 'scoring' : 'alert';
    var options = opts || {};
    if (!options.force && prefs[kind] !== true) return false;

    var cooldown = kind === 'scoring' ? SCORING_COOLDOWN_MS : ALERT_COOLDOWN_MS;
    var t = Date.now();
    if (!options.force && t - lastPlayed[kind] < cooldown) return false;

    var ctx = contextFor(kind);
    if (!ctx) return false;
    lastPlayed[kind] = t;
    try {
      render(ctx, options.drops || DROPS, options.volume);
      /* Keep the context around; browsers suspend it when idle. */
      return true;
    } catch (e) {
      return false;
    }
  }

  /* Sound check: always plays, ignores preference + cooldown.  A second press
   * while the sound is still ringing stops it (so it can be compared on/off). */
  function test(which) {
    var kind = which === 'scoring' ? 'scoring' : 'alert';
    var ctx = contextFor(kind);
    if (!ctx) return false;
    if (Date.now() - lastPlayed[kind + ':test'] < DURATION_MS) {
      try { ctx.suspend(); } catch (e) { /* ignore */ }
      lastPlayed[kind + ':test'] = 0;
      return false;
    }
    lastPlayed[kind + ':test'] = Date.now();
    try { if (ctx.resume) ctx.resume(); } catch (e) { /* ignore */ }
    try {
      render(ctx, DROPS, 0.55);
      return true;
    } catch (e) {
      return false;
    }
  }

  function stop(which) {
    var kind = which === 'scoring' ? 'scoring' : 'alert';
    var ctx = contexts[kind];
    if (!ctx) return;
    try { ctx.suspend(); } catch (e) { /* ignore */ }
  }

  function setEnabled(which, on) {
    var kind = which === 'scoring' ? 'scoring' : 'alert';
    prefs[kind] = !!on;
    if (!on) stop(kind);
  }

  function isEnabled(which) {
    var kind = which === 'scoring' ? 'scoring' : 'alert';
    return prefs[kind] === true;
  }

  function isPlaying(which) {
    var kind = which === 'scoring' ? 'scoring' : 'alert';
    return Date.now() - (lastPlayed[kind] || 0) < DURATION_MS;
  }

  global.Chime = {
    play: play,
    test: test,
    stop: stop,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    isPlaying: isPlaying,
    isSupported: isSupported,
    DURATION_MS: DURATION_MS,
    DROPS: DROPS,
    prefs: prefs,
    lastPlayed: lastPlayed,
  };

  /* Fire the preview from a gesture-only context (button): some browsers keep
   * the very first AudioContext suspended until the first real gesture, so the
   * first sound after page load is deliberately routed through the toggle. */
  if (global.document) {
    global.document.addEventListener('pointerdown', function prime() {
      global.document.removeEventListener('pointerdown', prime);
      if (prefs.alert || prefs.scoring) {
        contextFor('alert');
        contextFor('scoring');
      }
    }, { once: true });
  }
}(window));
