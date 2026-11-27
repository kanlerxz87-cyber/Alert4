# The alert sound

A gentle rain drop, about **2.6 seconds**, synthesised in the browser with the
Web Audio API. No audio file to download, nothing to decode, and the same shape
every time — which is what makes it bearable on a loop for a whole season.

## 1. What it sounds like

Six drops over 2.6 s, each one a soft "plip": a sine body that falls in pitch as
it decays, plus a very short band-passed noise transient for the splash. A slow
left/right drift, a 240 ms echo and a 3.4 kHz lowpass keep it soft rather than
clicky.

| Drop | At | Pitch | Body | Pan | Level |
|---|---|---|---|---|---|
| 1 | 0.00 s | 1180 Hz | 0.30 s | −0.35 | 0.55 |
| 2 | 0.42 s | 880 Hz | 0.34 s | +0.30 | 0.50 |
| 3 | 0.86 s | 1320 Hz | 0.28 s | −0.15 | 0.42 |
| 4 | 1.24 s | 1040 Hz | 0.36 s | +0.40 | 0.46 |
| 5 | 1.78 s | 740 Hz | 0.46 s | −0.25 | 0.52 |
| 6 | 2.18 s | 1560 Hz | 0.26 s | +0.10 | 0.30 |

Design constraints that shaped it: no beeps or sirens (they fatigue within
minutes), nothing above ~3.5 kHz (it stops being pleasant on laptop speakers),
a long enough gap between drops that it reads as rain rather than an alarm, and
a 2.5 s cooldown so a flurry of events cannot stack into noise.

## 2. The controls

| Control | What it does |
|---|---|
| **🔇 Sound Off / 🔊 Sound On** | The feed's alert sound. Turning it **on** plays the rain drop once, so the switch doubles as a check. |
| **▶ Test sound** | Plays the drop once, **regardless of the toggle**, then you decide. A second press while it is ringing stops it. |
| **⚪ Run Alerts Off / 🔴 Run Alerts On** | Desktop notifications for runs at risk (unchanged). |
| **🔊 Scoring sound on/off** + **▶ Test** | The *separate* player used by the Official Scoring section. |

Both preferences persist (`mlbp.pref.sound`, `mlbp.scoring.sound`).

The first sound of a session needs a user gesture (every browser's autoplay
policy). Clicking any of the buttons counts, so the very first thing you do —
turning sound on, or pressing Test — is what unlocks audio.

## 3. When it sounds

| Event | Alert sound |
|---|---|
| New manager challenge | ✅ |
| New crew chief / umpire review / instant replay | ✅ |
| New boundary call (home run / fair-foul at the wall) | ✅ |
| New ABS pitch challenge | ❌ (tracked, but routine; excluded by design) |
| Official scorer ruling pending | ✅ |
| Official scoring change | ✅ |
| Active review that could remove a run already on the scoreboard | ✅ once per review |
| Official scoring log: new pending ruling / new change | 🔊 *scoring player only* |

All alert chimes share one 2.5 s cooldown (`SOUND_COOLDOWN_MS`), so several
events landing in the same second produce one sound and several rows.

## 4. Why it cannot break the feed

`chime.js` is a leaf module: it takes no dependency except `window`, never
throws (every path is wrapped), and returns `false` when audio is unavailable
rather than erroring. If a browser has no `AudioContext`, the feed runs exactly
as before with sound off — the toggle reports that audio is unsupported.

## 5. Tuning it

`Chime.DROPS` is a plain array; `Chime.play('alert')` renders it. To change the
character, edit the array (start, pitch, body, pan, level) — no rebuild step.
`Chime.DURATION_MS` and the cooldowns in `chime.js` are the other two knobs.
