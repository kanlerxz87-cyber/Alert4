#!/usr/bin/env python3
"""Render the alert figure to assets/audio/alert-raindrop.wav.

The parameters here mirror phrase() in assets/js/alert-sound.js so the fallback
file and the live synthesiser sound like the same alert.  No dependencies.
"""
import math, os, struct, wave

SR = 44100
DUR = 3.0
N = int(SR * DUR)
buf = [0.0] * N


def env(t, attack, body, release):
    if t < 0:
        return 0.0
    if t < attack:
        return 0.5 - 0.5 * math.cos(math.pi * t / attack)
    if t < attack + body:
        return 1.0
    r = t - (attack + body)
    if r < release:
        return 0.5 + 0.5 * math.cos(math.pi * r / release)
    return 0.0


def drop(t0, freq, peak, decay, pan=0.0):
    """One water drop: pitch rises for 35 ms then falls; quiet surface click."""
    start = int(t0 * SR)
    phase = 0.0
    for i in range(int((decay + 0.35) * SR)):
        t = i / SR
        idx = start + i
        if idx >= N:
            break
        if t < 0.035:
            f = freq + (freq * 0.28) * (t / 0.035)
        else:
            k = (t - 0.035) / max(1e-6, decay - 0.035)
            f = freq * 1.28 * ((0.72 / 1.28) ** k)
        phase += 2 * math.pi * f / SR
        e = env(t, 0.012, decay * 0.25, decay * 0.75)
        s = math.sin(phase) * peak * e + 0.18 * math.sin(2 * phase) * peak * e
        buf[idx] += s * (0.5 + 0.5 * pan)
        if t < 0.05:
            buf[idx] += math.sin(2 * math.pi * 3300 * t) * 0.05 * peak * env(t, 0.004, 0.0, 0.046)


def pad(t0, root, dur, peak):
    start = int(t0 * SR)
    for mult, det in ((1.0, -3), (1.5, 4)):
        f = root * mult * (2 ** (det / 1200))
        phase = 0.0
        for i in range(int(dur * SR)):
            idx = start + i
            if idx >= N:
                break
            t = i / SR
            phase += 2 * math.pi * f / SR
            buf[idx] += math.sin(phase) * peak * env(t, 0.45, max(0, dur - 0.75), 0.3)


def main():
    pad(0.0, 146.83, 2.9, 0.035)  # low E3/A3 floor
    for args in ((0.00, 1320, 0.160, 0.34, -0.22),
                 (0.28, 1046, 0.130, 0.40, 0.18),
                 (1.02, 1174, 0.120, 0.42, 0.26),
                 (1.34, 880, 0.100, 0.55, -0.10),
                 (2.05, 1318, 0.075, 0.62, 0.06),
                 (2.44, 659, 0.085, 0.78, -0.16)):
        drop(*args)

    peak = max(abs(x) for x in buf) or 1.0
    scale = 0.55 / peak
    data = b''.join(struct.pack('<h', int(max(-1, min(1, x * scale)) * 32767)) for x in buf)
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       'assets', 'audio', 'alert-raindrop.wav')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with wave.open(out, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data)
    print('wrote', out, len(data), 'bytes')


if __name__ == '__main__':
    main()
