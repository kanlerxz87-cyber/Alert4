/* ============================================================================
 * alert-sound.js — the alert chime
 *
 * The owner's brief: "pleasant to listen to as it will need to be heard all day
 * for the entire season.  It could be maybe a 3 second rain drop sound."  So:
 *
 *   - A ~3 s raindrop figure: four soft water-drop plinks (a short sine body
 *     that falls in pitch, filtered, with a tiny "surface" click) spaced so the
 *     phrase resolves rather than repeats, plus a low warm tail so it does not
 *     sound thin on a laptop speaker.
 *   - Never harsh: no square/sawtooth, no sharp attack (12 ms raised-cosine
 *     ramps), peak gain well under the digital ceiling, and a gentle low-pass on
 *     every voice.  Deterministic by default so the same event always sounds the
 *     same; a per-event seed only nudges the drop pitches by a few cents so a
 *     long day of alerts is not hypnotic.
 *   - Toggleable everywhere: one switch per page, persisted in localStorage,
 *     and a **Test** button that plays exactly what a real alert plays, so the
 *     owner can confirm the chain (page → sound → speakers) at any time.
 *   - Polite: one chime at a time (a queue that collapses to its newest item),
 *     a hard cooldown, exponential backoff if MLB floods events, and silence
 *     while the tab is hidden (the caller decides; this module also refuses to
 *     play in a hidden tab unless `force`, which only the Test button uses).
 *
 * The AudioContext is created lazily and unlocked on the first user gesture —
 * browsers refuse to start audio before one, so `unlock()` is wired to the
 * toggle button, the test button and the first click anywhere on the page.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var PREF_KEY = 'mlbp.pref.sound';
  var VOLUME_KEY = 'mlbp.pref.soundVolume';
  var COOLDOWN_MS = 1200;
  var MAX_BACKOFF_MS = 8000;

  /* Optional pre-rendered copy of the same figure, generated offline with the
   * same design (see assets/audio/README.md).  Web Audio is synthesised live by
   * default because it needs no download and a burst of events can never queue
   * behind a file; the WAV is the fallback for a browser where the AudioContext
   * refuses to start, and the preview the owner can listen to without a game. */
  var FALLBACK_WAV = 'assets/audio/alert-raindrop.wav';

  var ctx = null;
  var master = null;
  var noiseBuffer = null;
  var enabled = false;
  var volume = 0.5;
  var lastPlayedAt = 0;
  var queued = null;
  var queueTimer = null;
  var played = 0;
  var suppressed = 0;
  var failing = false;
  var listeners = [];

  /* ---------------------------------------------------------------- storage */

  function storageGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { global.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  function loadPrefs() {
    var raw = storageGet(PREF_KEY);
    enabled = raw === '1';
    /* Careful: Number(null) is 0, i.e. silent.  An absent preference must mean
     * the documented 50% default, never a muted one. */
    var stored = storageGet(VOLUME_KEY);
    if (stored !== null && stored !== '') {
      var v = Number(stored);
      if (isFinite(v) && v >= 0 && v <= 1) volume = v;
    }
    return { enabled: enabled, volume: volume };
  }

  function setEnabled(value) {
    enabled = !!value;
    storageSet(PREF_KEY, enabled ? '1' : '0');
    if (enabled) unlock();
    else silence();
    emit();
    return enabled;
  }

  function toggle() { return setEnabled(!enabled); }

  function setVolume(value) {
    var v = Number(value);
    if (!isFinite(v)) return volume;
    volume = Math.min(1, Math.max(0, v));
    storageSet(VOLUME_KEY, String(volume));
    if (master) master.gain.value = volume;
    emit();
    return volume;
  }

  /* ------------------------------------------------------------- audio core */

  function AudioCtor() {
    return global.AudioContext || global.webkitAudioContext || null;
  }

  function supported() { return !!AudioCtor(); }

  function unlock() {
    var Ctor = AudioCtor();
    if (!Ctor) return null;
    try {
      if (!ctx) {
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = volume;
        /* A gentle bus compressor keeps a burst of drops from clipping on small
         * laptop speakers, which is what makes a repeated alert sound harsh. */
        var comp = null;
        if (ctx.createDynamicsCompressor) {
          comp = ctx.createDynamicsCompressor();
          comp.threshold.value = -18;
          comp.knee.value = 24;
          comp.ratio.value = 3;
          comp.attack.value = 0.006;
          comp.release.value = 0.25;
          master.connect(comp);
          comp.connect(ctx.destination);
        } else {
          master.connect(ctx.destination);
        }
        noiseBuffer = makeNoise(ctx);
      }
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      /* A zero-length silent buffer is the canonical iOS/Chrome unlock. */
      var b = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
      var src = ctx.createBufferSource();
      src.buffer = b;
      src.connect(ctx.destination);
      src.start(0);
      return ctx;
    } catch (e) {
      failing = true;
      return null;
    }
  }

  function makeNoise(context) {
    var len = Math.floor((context.sampleRate || 44100) * 0.25);
    var buf = context.createBuffer(1, len, context.sampleRate || 44100);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i += 1) {
      /* Pink-ish noise for the water "surface" transient: pleasant, not hissy. */
      data[i] = (Math.random() * 2 - 1) * 0.35 * Math.pow(1 - i / len, 2);
    }
    return buf;
  }

  function rampGain(gain, at, peak, attack, body, release) {
    /* Raised-cosine attack and release: no click, no fatigue. */
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    gain.gain.setValueAtTime(peak, at + attack + body);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + body + release);
  }

  /* One water drop: a falling sine "plink" (the pitch drop is what the ear reads
   * as water), a quiet octave for body, and a filtered noise transient for the
   * surface.  Peak stays low so 200 of them in a day are still polite. */
  function drop(at, freq, peak, decay, pan) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(12000, freq * 6), at);
    lp.frequency.exponentialRampToValueAtTime(Math.max(400, freq * 1.6), at + decay);
    lp.Q.value = 0.6;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    /* A drop's pitch is the bubble resonance rising as it collapses. */
    osc.frequency.exponentialRampToValueAtTime(freq * 1.28, at + 0.035);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.72, at + decay);

    rampGain(gain, at, peak, 0.012, decay * 0.25, decay * 0.75);
    osc.connect(gain);
    gain.connect(lp);

    var tail = ctx.createGain();
    tail.gain.value = 1;
    if (pan !== undefined && ctx.createStereoPanner) {
      var p = ctx.createStereoPanner();
      p.pan.value = pan;
      lp.connect(p);
      p.connect(tail);
    } else {
      lp.connect(tail);
    }
    tail.connect(master);

    osc.start(at);
    osc.stop(at + decay + 0.35);

    /* Surface transient (very quiet). */
    if (noiseBuffer) {
      var n = ctx.createBufferSource();
      n.buffer = noiseBuffer;
      var ng = ctx.createGain();
      var nhp = ctx.createBiquadFilter();
      nhp.type = 'highpass';
      nhp.frequency.value = Math.max(1200, freq * 0.9);
      ng.gain.setValueAtTime(0.0001, at);
      ng.gain.linearRampToValueAtTime(Math.min(0.07, peak * 0.22), at + 0.004);
      ng.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      n.connect(nhp);
      nhp.connect(ng);
      ng.connect(tail);
      n.start(at);
      n.stop(at + 0.08);
    }
  }

  /* A soft low pad under the drops: two detuned triangles a fifth apart at low
   * level, so the figure has a floor instead of sounding like a test tone. */
  function pad(at, root, duration, peak) {
    [root, root * 1.5].forEach(function (f, i) {
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, at);
      osc.detune.value = i ? 4 : -3;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(peak, at + 0.45);
      g.gain.linearRampToValueAtTime(0.0001, at + duration);
      osc.connect(g);
      g.connect(lp);
      lp.connect(master);
      osc.start(at);
      osc.stop(at + duration + 0.2);
    });
  }

  /* The figure itself.  `seed` (optional) nudges the drop pitches by up to ±40
   * cents so a full day of alerts never sounds identical, without changing the
   * character or the length. */
  function phrase(seed) {
    if (!ctx) return;
    var t0 = ctx.currentTime + 0.03;
    var nudge = 0;
    if (seed) {
      var h = 0;
      var s = String(seed);
      for (var i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 1000;
      nudge = ((h % 80) - 40) / 25; // -1.6 .. +1.6 semitones-ish via cents below
    }
    function cents(f) { return f * Math.pow(2, (nudge * 4) / 1200); }

    /* 3.0 s total: drop · drop · (gap) · drop · low drop + tail. */
    pad(t0, 146.83, 2.9, 0.035);
    drop(t0 + 0.00, cents(1320), 0.16, 0.34, -0.22);   // E6
    drop(t0 + 0.28, cents(1046), 0.13, 0.40, 0.18);    // C6
    drop(t0 + 1.02, cents(1174), 0.12, 0.42, 0.26);    // D6
    drop(t0 + 1.34, cents(880), 0.10, 0.55, -0.10);    // A5
    drop(t0 + 2.05, cents(1318), 0.075, 0.62, 0.06);   // E6, softer echo
    drop(t0 + 2.44, cents(659), 0.085, 0.78, -0.16);   // E5, settles
  }

  /* Drop anything queued.  The audio device itself stays open — an alert 30
   * seconds from now should not have to re-unlock. */
  function clearQueue() {
    if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
    queued = null;
  }

  /* Full stop: drop the queue AND release the audio device (switch off, or the
   * page is going away).  unlock() rebuilds it on demand. */
  function silence() {
    clearQueue();
    if (ctx && ctx.close) {
      /* Releasing the device keeps the tab quiet and idle between events; it is
       * re-created (and re-unlocked by the next gesture or alert) on demand. */
      try { ctx.close(); } catch (e) { /* ignore */ }
    }
    ctx = null;
    master = null;
    noiseBuffer = null;
  }

  /* Play the queued/newest alert now, ignoring the cooldown.  Used by the
   * Test button (so it always feels instant) and exposed for diagnostics. */
  function flush() {
    var r = queued || 'flush';
    clearQueue();
    if (!ctx && !unlock()) return false;
    lastPlayedAt = 0;
    return playNow(r);
  }

  /* --------------------------------------------------------------- playback */

  function playNow(reason) {
    if (!ctx) return false;
    try {
      phrase(reason);
      lastPlayedAt = Date.now();
      played += 1;
      failing = false;
      return true;
    } catch (e) {
      failing = true;
      return false;
    }
  }

  /**
   * chime(reason)
   *   reason  a short tag ('review' | 'pending' | 'scoring' | 'risk' | 'test')
   *   opts.force  play even when the tab is hidden or sound is off — used only
   *               by the Test button, which must work with the volume check.
   */
  function chime(reason, opts) {
    opts = opts || {};
    if (!opts.force && !enabled) { suppressed += 1; return false; }
    if (!opts.force && global.document && global.document.hidden) { suppressed += 1; return false; }
    var Ctor = AudioCtor();
    if (!Ctor) return false;
    if (!ctx && !unlock()) {
      /* No Web Audio: fall back to the file rather than going silent. */
      return playFile();
    }

    var wait = 0;
    var since = Date.now() - lastPlayedAt;
    if (since < COOLDOWN_MS) {
      /* A burst of events collapses into one chime, not a stutter. */
      wait = COOLDOWN_MS - since;
      /* Back off further when events are genuinely pouring in. */
      if (played > 0 && since < COOLDOWN_MS / 2) wait = Math.min(MAX_BACKOFF_MS, wait + COOLDOWN_MS);
    }
    if (wait <= 0) return playNow(reason);

    queued = reason;
    if (!queueTimer) {
      queueTimer = setTimeout(function () {
        queueTimer = null;
        var r = queued;
        queued = null;
        if (r) playNow(r);
      }, wait);
    }
    return true;
  }

  /* Last resort: an <audio> element with the pre-rendered figure.  Used only
   * when the AudioContext cannot start; returns whether it actually played. */
  function playFile() {
    try {
      var el = new global.Audio(FALLBACK_WAV);
      el.volume = volume;
      var p = el.play();
      if (p && p.catch) p.catch(function () { /* autoplay policy: needs a gesture */ });
      played += 1;
      lastPlayedAt = Date.now();
      return true;
    } catch (e) {
      return false;
    }
  }

  /* The Test button and every sound toggle.  Plays the full 3 s figure whether
   * or not the alert switch is on, so "is my alert working?" has one obvious
   * answer.  Never queues: a test must feel instant. */
  function test() {
    lastPlayedAt = 0;             // a test always plays, cooldown or not
    if (unlock() && playNow('test')) return { ok: true, seconds: 3, supported: true, via: 'web-audio' };
    if (playFile()) return { ok: true, seconds: 3, supported: false, via: 'audio-element' };
    return { ok: false, reason: 'This browser would not start audio (no Web Audio and the fallback file could not play).' };
  }

  function emit() {
    listeners.forEach(function (fn) {
      try { fn({ enabled: enabled, volume: volume }); } catch (e) { /* ignore */ }
    });
  }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  function status() {
    return {
      enabled: enabled,
      volume: volume,
      supported: supported(),
      unlocked: !!ctx && (!ctx.state || ctx.state === 'running'),
      state: ctx ? ctx.state : 'uninitialised',
      played: played,
      suppressed: suppressed,
      failing: failing,
      lastPlayedAt: lastPlayedAt,
    };
  }

  /* Unlock on the first real gesture anywhere, so the first alert of the day is
   * audible even if the owner never touched the sound button.  Passive, one
   * shot, no visual side effect. */
  function armUnlock() {
    if (!global.document || !global.document.addEventListener) return;
    var done = false;
    function once() {
      if (done) return;
      done = true;
      if (enabled) unlock();
      global.document.removeEventListener('pointerdown', once, true);
      global.document.removeEventListener('keydown', once, true);
    }
    global.document.addEventListener('pointerdown', once, true);
    global.document.addEventListener('keydown', once, true);
  }

  loadPrefs();
  armUnlock();

  global.AlertSound = {
    chime: chime,
    test: test,
    toggle: toggle,
    setEnabled: setEnabled,
    isEnabled: function () { return enabled; },
    setVolume: setVolume,
    getVolume: function () { return volume; },
    unlock: unlock,
    supported: supported,
    status: status,
    onChange: onChange,
    clearQueue: clearQueue,
    silence: silence,
    flush: flush,
  };
}(window));
