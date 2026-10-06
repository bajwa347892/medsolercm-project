"""
MPL ident sound design and score, synthesised from scratch and driven by src/cues.json.

    .venv/bin/python audio/synth.py

Writes public/audio/stems/{ambience,sfx,music}.wav and public/audio/mpl_mix.wav
(48 kHz stereo, loudness-normalised with ffmpeg loudnorm to about -16 LUFS, -1 dBTP).
Every random choice is seeded, so the output is identical on every run.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
FPS = 30
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CUES = json.load(open(os.path.join(ROOT, "src", "cues.json")))
EV = CUES["events"]
SLOW = CUES["slowmo"]
DUR_S = 27.0
N = int(DUR_S * SR)


def fr(frame: float) -> float:
    """frame -> seconds"""
    return frame / FPS


def idx(seconds: float) -> int:
    return int(round(seconds * SR))


# ---------------------------------------------------------------- basics

def rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def white(n: int, seed: int) -> np.ndarray:
    return rng(seed).standard_normal(n)


def pink(n: int, seed: int) -> np.ndarray:
    """Pink-ish noise via a Paul Kellet style IIR on white noise."""
    w = white(n, seed)
    b = [0.049922035, -0.095993537, 0.050612699, -0.004408786]
    a = [1, -2.494956002, 2.017265875, -0.522189400]
    p = signal.lfilter(b, a, w)
    return p / (np.std(p) + 1e-9)


def brown(n: int, seed: int) -> np.ndarray:
    b = np.cumsum(white(n, seed))
    b = signal.sosfilt(signal.butter(2, 15, "hp", fs=SR, output="sos"), b)
    return b / (np.std(b) + 1e-9)


def sos_bp(lo: float, hi: float, order: int = 2):
    return signal.butter(order, [lo, hi], "bandpass", fs=SR, output="sos")


def sos_lp(f: float, order: int = 2):
    return signal.butter(order, f, "lowpass", fs=SR, output="sos")


def sos_hp(f: float, order: int = 2):
    return signal.butter(order, f, "highpass", fs=SR, output="sos")


def filt(x: np.ndarray, sos) -> np.ndarray:
    return signal.sosfilt(sos, x)


def t_axis(n: int) -> np.ndarray:
    return np.arange(n) / SR


def env_decay(n: int, tau: float, attack: float = 0.002) -> np.ndarray:
    t = t_axis(n)
    a = np.clip(t / max(attack, 1e-5), 0, 1)
    return a * np.exp(-t / tau)


def env_ar(n: int, attack: float, release: float) -> np.ndarray:
    t = t_axis(n)
    up = np.clip(t / attack, 0, 1)
    dn = np.clip((t[-1] - t) / release, 0, 1) if release > 0 else 1
    return np.minimum(up, dn) if release > 0 else up


def automation(points: list[tuple[float, float]], n: int = N, in_db: bool = True) -> np.ndarray:
    """Piecewise-linear automation over the whole timeline. points: (seconds, value)."""
    xs = np.array([p[0] for p in points]) * SR
    ys = np.array([p[1] for p in points])
    y = np.interp(np.arange(n), xs, ys)
    return 10 ** (y / 20) if in_db else y


def pan_st(x: np.ndarray, pan: float | np.ndarray) -> np.ndarray:
    """Equal-power pan, pan in [-1, 1]."""
    th = (np.asarray(pan) + 1) * np.pi / 4
    return np.stack([x * np.cos(th), x * np.sin(th)], axis=0)


def place(bus: np.ndarray, clip: np.ndarray, at_s: float, gain_db: float = 0.0):
    """Mix a mono or stereo clip into a stereo bus at time at_s."""
    if clip.ndim == 1:
        clip = np.stack([clip, clip])
    g = 10 ** (gain_db / 20)
    i0 = idx(at_s)
    if i0 >= bus.shape[1]:
        return
    j0 = max(0, -i0)
    i0 = max(0, i0)
    n = min(clip.shape[1] - j0, bus.shape[1] - i0)
    if n > 0:
        bus[:, i0 : i0 + n] += g * clip[:, j0 : j0 + n]


def norm(x: np.ndarray, peak: float = 1.0) -> np.ndarray:
    m = np.max(np.abs(x)) + 1e-12
    return x * (peak / m)


def reverb_ir(seconds: float, seed: int, damp_hz: float = 6000, predelay: float = 0.02) -> np.ndarray:
    """Stereo decorrelated exponentially decaying noise IR with HF damping over time."""
    n = idx(seconds)
    out = []
    for ch in range(2):
        nz = white(n, seed + ch)
        t = t_axis(n)
        decay = np.exp(-6.9 * t / seconds)  # -60 dB at `seconds`
        early = filt(nz, sos_lp(damp_hz)) * decay
        late = filt(nz, sos_lp(damp_hz * 0.35)) * decay
        mix = np.where(t < 0.25, early, early * np.exp(-(t - 0.25) * 3) + late)
        pd = np.zeros(idx(predelay))
        out.append(np.concatenate([pd, mix]))
    ir = np.stack(out)
    return ir / np.sqrt(np.sum(ir**2) / 2)


def convolve(x: np.ndarray, ir: np.ndarray, wet: float) -> np.ndarray:
    if x.ndim == 1:
        x = np.stack([x, x])
    y = np.stack([signal.fftconvolve(x[c], ir[c])[: x.shape[1]] for c in range(2)])
    return x * (1 - wet) + y * wet


def soft_clip(x: np.ndarray, drive: float = 1.0) -> np.ndarray:
    return np.tanh(x * drive) / np.tanh(drive)


# ---------------------------------------------------------------- one-shot sound designs

def thump(freq: float = 60, tau: float = 0.18, sweep: float = 2.2, dur: float = 0.8) -> np.ndarray:
    n = idx(dur)
    t = t_axis(n)
    f = freq * (1 + (sweep - 1) * np.exp(-t / 0.03))
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * env_decay(n, tau, 0.001)


def click(seed: int, lo: float = 2000, hi: float = 9000, dur: float = 0.012) -> np.ndarray:
    n = idx(dur)
    return filt(white(n, seed), sos_bp(lo, hi)) * env_decay(n, dur / 4, 0.0003)


def modal(partials: list[tuple[float, float, float]], dur: float, seed: int = 0, strike: float = 0.002) -> np.ndarray:
    """Sum of damped sinusoids: (freq, amp, decay tau)."""
    n = idx(dur)
    t = t_axis(n)
    r = rng(seed)
    y = np.zeros(n)
    for f, a, tau in partials:
        y += a * np.sin(2 * np.pi * f * t + r.uniform(0, 2 * np.pi)) * np.exp(-t / tau)
    y *= np.clip(t / strike, 0, 1)
    return y


def noise_burst(seed: int, lo: float, hi: float, dur: float, tau: float, attack: float = 0.002) -> np.ndarray:
    n = idx(dur)
    return filt(white(n, seed), sos_bp(lo, hi)) * env_decay(n, tau, attack)


def whoosh(seed: int, dur: float, f0: float, f1: float, peak_at: float = 0.6, q: float = 0.6) -> np.ndarray:
    """Filtered-noise sweep with a swelling envelope (block-wise moving bandpass)."""
    n = idx(dur)
    nz = white(n, seed)
    out = np.zeros(n)
    block = 512
    zi = None
    for b0 in range(0, n, block):
        tt = b0 / n
        fc = f0 * (f1 / f0) ** tt
        lo, hi = max(40, fc * (1 - q)), min(SR / 2 - 100, fc * (1 + q))
        sos = sos_bp(lo, hi)
        if zi is None or zi.shape[0] != sos.shape[0]:
            zi = signal.sosfilt_zi(sos) * 0
        seg, zi = signal.sosfilt(sos, nz[b0 : b0 + block], zi=zi)
        out[b0 : b0 + block] = seg
    t = np.linspace(0, 1, n)
    env = np.where(t < peak_at, (t / peak_at) ** 2, ((1 - t) / (1 - peak_at)) ** 1.5)
    return out * env


def bat_crack(seed: int, bright: float = 1.0) -> np.ndarray:
    """Willow on leather: hard transient, short woody modes, low body thump."""
    n = idx(0.6)
    y = np.zeros(n)
    y[: idx(0.012)] += click(seed, 1500, 12000, 0.012) * 2.2 * bright
    y += modal(
        [(1180, 1.0, 0.035), (1690, 0.8, 0.028), (2410, 0.6, 0.02), (3270, 0.45, 0.015), (620, 0.5, 0.06), (4300, 0.25 * bright, 0.01)],
        0.6,
        seed,
        0.0005,
    )
    y += thump(140, 0.05, 1.6, 0.6) * 0.6
    return soft_clip(y * 0.6, 2.0)


def stump_crack(seed: int) -> np.ndarray:
    n = idx(0.9)
    y = np.zeros(n)
    y[: idx(0.01)] += click(seed, 1200, 10000, 0.01) * 1.6
    y += modal([(640, 1.0, 0.09), (930, 0.7, 0.07), (1480, 0.5, 0.05), (2210, 0.35, 0.03), (305, 0.6, 0.12)], 0.9, seed, 0.0007)
    y += thump(95, 0.09, 1.8, 0.9) * 0.7
    return soft_clip(y * 0.6, 1.8)


def bail_clatter(seed: int, count: int = 7, spread: float = 0.45) -> np.ndarray:
    n = idx(spread + 0.3)
    y = np.zeros(n)
    r = rng(seed)
    for i in range(count):
        at = idx(r.uniform(0, spread) * (i / count) ** 0.7)
        f = r.uniform(2800, 5200)
        tick = modal([(f, 1.0, 0.012), (f * 1.53, 0.5, 0.008), (f * 0.61, 0.4, 0.02)], 0.08, seed + i, 0.0002)
        tick *= r.uniform(0.3, 1.0)
        y[at : at + tick.size] += tick[: max(0, n - at)]
    return y


def footstep_grass(seed: int, weight: float = 1.0) -> np.ndarray:
    n = idx(0.25)
    y = thump(70, 0.05, 1.5, 0.25) * 0.8 * weight
    y += filt(white(n, seed), sos_lp(500)) * env_decay(n, 0.04) * 0.6 * weight
    y += noise_burst(seed + 1, 2500, 7000, 0.25, 0.035) * 0.35
    # spikes biting the turf
    y[: idx(0.01)] += click(seed + 2, 3000, 9000, 0.01)[: idx(0.01)] * 0.3
    return y


def leather_creak(seed: int) -> np.ndarray:
    n = idx(0.35)
    r = rng(seed)
    grains = np.zeros(n)
    for k in range(40):
        at = int(r.uniform(0, 0.28) * SR)
        g = noise_burst(seed + k, 900, 3800, 0.03, 0.006) * r.uniform(0.2, 1)
        grains[at : at + g.size] += g[: max(0, n - at)]
    return grains * env_ar(n, 0.04, 0.12)


def breath(seed: int, dur: float = 0.9) -> np.ndarray:
    n = idx(dur)
    y = filt(white(n, seed), sos_bp(350, 1700))
    t = np.linspace(0, 1, n)
    env = np.sin(np.pi * t) ** 1.6
    return y * env * 0.5


def catch_slap(seed: int) -> np.ndarray:
    n = idx(0.4)
    y = noise_burst(seed, 300, 2400, 0.4, 0.03, 0.0008) * 1.2
    y += thump(110, 0.05, 1.4, 0.4) * 0.7
    return y


def grass_slide(seed: int, dur: float) -> np.ndarray:
    n = idx(dur)
    r = rng(seed)
    nz = filt(white(n, seed), sos_bp(900, 6000))
    grit = np.abs(filt(white(n, seed + 1), sos_lp(35))) * 2 + 0.3
    t = np.linspace(0, 1, n)
    env = np.minimum(t / 0.05, 1) * (1 - t) ** 1.2
    low = filt(white(n, seed + 2), sos_lp(300)) * 0.5
    return (nz * grit + low) * env * r.uniform(0.9, 1.1)


def metal_lock(seed: int, pitch: float = 1.0) -> np.ndarray:
    """Heavy metallic assembly lock: inharmonic ring + mechanical click + low thump."""
    n = idx(1.6)
    y = modal(
        [
            (182 * pitch, 0.9, 0.5),
            (397 * pitch, 0.7, 0.35),
            (671 * pitch, 0.55, 0.25),
            (1103 * pitch, 0.4, 0.18),
            (1789 * pitch, 0.25, 0.1),
            (2741 * pitch, 0.15, 0.06),
        ],
        1.6,
        seed,
        0.0008,
    )
    y[: idx(0.015)] += click(seed + 3, 1800, 9000, 0.015) * 1.4
    y += thump(48, 0.22, 2.0, 1.6) * 1.1
    return soft_clip(y * 0.5, 1.5)


def shimmer(seed: int, dur: float, base: float = 2200, count: int = 9, travel: bool = False) -> np.ndarray:
    n = idx(dur)
    t = t_axis(n)
    r = rng(seed)
    st = np.zeros((2, n))
    for i in range(count):
        f = base * r.uniform(0.8, 2.6)
        trem = 0.6 + 0.4 * np.sin(2 * np.pi * r.uniform(5, 11) * t + r.uniform(0, 6.28))
        tone = np.sin(2 * np.pi * f * t) * trem
        env = env_ar(n, r.uniform(0.01, 0.15), dur * 0.7)
        pan = np.linspace(-0.9, 0.9, n) if travel else r.uniform(-0.8, 0.8)
        st += pan_st(tone * env / count, pan)
    return st


def sub_impact(seed: int, dur: float = 4.5, f0: float = 85, f1: float = 28) -> np.ndarray:
    n = idx(dur)
    t = t_axis(n)
    f = f1 + (f0 - f1) * np.exp(-t / 0.35)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t / 1.4)
    body = soft_clip(body * 1.6, 1.8)
    hit = filt(white(n, seed), sos_lp(900)) * env_decay(n, 0.12, 0.001) * 0.9
    crack = noise_burst(seed + 1, 1500, 9000, dur, 0.04, 0.0005) * 0.5
    return body + hit + crack


# ---------------------------------------------------------------- crowd

def crowd_layer(seed: int, n: int, center: float, width: float, rate: float) -> np.ndarray:
    """One band of crowd: noise in a formant band with syllable-like amplitude motion."""
    nz = filt(white(n, seed), sos_bp(center * (1 - width), center * (1 + width)))
    mod = filt(white(n, seed + 7), sos_lp(rate))
    mod = 0.55 + 0.45 * np.tanh(mod / (np.std(mod) + 1e-9))
    return nz * mod


def build_crowd() -> tuple[np.ndarray, np.ndarray]:
    """Returns (murmur_bed, roar) stereo arrays (unscaled)."""
    bands = [(260, 0.4, 3), (420, 0.35, 4), (650, 0.35, 5), (900, 0.3, 6), (1300, 0.3, 6), (1900, 0.3, 7), (2700, 0.25, 8), (3600, 0.25, 8)]
    murmur = np.zeros((2, N))
    for i, (c, w, r_) in enumerate(bands):
        for ch in range(2):
            murmur[ch] += crowd_layer(1000 + i * 10 + ch, N, c, w, r_) * (1.0 / (1 + i * 0.25))
    roar = np.zeros((2, N))
    for ch in range(2):
        p = pink(N, 2000 + ch)
        r_ = filt(p, sos_bp(250, 4200)) + 0.6 * filt(p, sos_bp(500, 1100)) + 0.4 * filt(p, sos_bp(1400, 2600))
        roar[ch] = r_
    # claps: dense random impulse field
    clap = np.zeros((2, N))
    r = rng(3000)
    for k in range(9000):
        at = int(r.uniform(0, N - 2000))
        ch = r.integers(0, 2)
        c = noise_burst(4000 + (k % 97), 1200, 6000, 0.03, 0.006, 0.0003) * r.uniform(0.2, 1)
        clap[ch, at : at + c.size] += c
    # a few whistles (two-finger, high, short)
    whistles = np.zeros((2, N))
    for k, at_f in enumerate([255, 262, 362, 371, 447, 470, 482, 760, 772]):
        n = idx(0.6)
        t = t_axis(n)
        f = 2900 + 250 * np.sin(2 * np.pi * 6 * t) + 300 * t
        tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_ar(n, 0.05, 0.2) * 0.2
        place(whistles, pan_st(tone, (-0.7 + 0.17 * k) % 1.4 - 0.7), fr(at_f) + 0.1 * (k % 3))
    return murmur / np.std(murmur), (roar / np.std(roar), clap / (np.std(clap) + 1e-9), whistles)


# ---------------------------------------------------------------- music

def midi_hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def saw_stack(freq: float, n: int, detune: float = 0.12, voices: int = 5, seed: int = 0) -> np.ndarray:
    t = t_axis(n)
    r = rng(seed)
    y = np.zeros(n)
    for v in range(voices):
        d = 1 + detune / 100 * (v - (voices - 1) / 2)
        y += signal.sawtooth(2 * np.pi * freq * d * t + r.uniform(0, 6.28))
    return y / voices


def taiko(seed: int, pitch: float = 1.0, dur: float = 1.4) -> np.ndarray:
    n = idx(dur)
    t = t_axis(n)
    f = 58 * pitch * (1 + 1.6 * np.exp(-t / 0.025))
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.42)
    skin = noise_burst(seed, 120, 1800, dur, 0.06, 0.0008) * 0.7
    return soft_clip((body + skin) * 1.2, 1.4)


def tom(seed: int, pitch: float = 1.0) -> np.ndarray:
    n = idx(0.6)
    t = t_axis(n)
    f = 120 * pitch * (1 + 0.8 * np.exp(-t / 0.02))
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.16)
    return body + noise_burst(seed, 400, 4000, 0.6, 0.03, 0.0005) * 0.4


def snare_hit(seed: int) -> np.ndarray:
    n = idx(0.5)
    t = t_axis(n)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.06)
    nz = noise_burst(seed, 1500, 9000, 0.5, 0.12, 0.0005)
    return tone * 0.6 + nz * 0.9


def build_music() -> np.ndarray:
    bus = np.zeros((2, N))
    # Harmony: D minor world, lifting to a bright D5 power resolution at the final hit.
    sections = [  # (start s, end s, root midi, chord intervals)
        (0.0, 4.2, 38, [0, 7]),  # D drone, suspense
        (4.2, 7.2, 38, [0, 3, 7]),  # Dm
        (7.2, 10.6, 34, [0, 4, 7]),  # Bb
        (10.6, 14.0, 41, [0, 4, 7]),  # F
        (14.0, 17.0, 36, [0, 4, 7]),  # C
        (17.0, 19.0, 34, [0, 4, 7, 9]),  # Bb6 (montage push)
        (19.0, 21.0, 33, [0, 4, 7, 10]),  # A7 (vortex, dominant tension)
        (21.0, 24.5, 38, [0, 7, 12]),  # D5 (logo)
        (24.5, 27.0, 38, [0, 7, 12, 14]),  # D5 add9 (hero)
    ]
    pad = np.zeros((2, N))
    for k, (s0, s1, root, chord) in enumerate(sections):
        n = idx(s1 - s0 + 0.6)
        tone = np.zeros(n)
        for j, iv in enumerate(chord):
            tone += saw_stack(midi_hz(root + iv), n, 0.18, 5, 50 + k * 10 + j) * (1.0 if j == 0 else 0.7)
        tone = filt(tone, sos_lp(700 + 300 * min(k, 6)))
        env = env_ar(n, 0.35, 0.6)
        place(pad, pan_st(tone * env, -0.25 + 0.5 * (k % 2)), s0 - 0.2)
    pad_auto = automation([(0, -70), (2.2, -44), (4.2, -30), (7.2, -24), (17, -18), (19, -15), (21, -16), (24.5, -12), (26.4, -14), (27, -40)])
    bus += pad * pad_auto

    # Sub drone under everything (D1 / A1)
    t = t_axis(N)
    drone = (np.sin(2 * np.pi * midi_hz(26) * t) + 0.5 * np.sin(2 * np.pi * midi_hz(33) * t)) * 0.5
    drone_auto = automation([(0, -42), (2.2, -32), (6.2, -26), (19, -20), (21, -14), (24.6, -30), (25, -18), (27, -50)])
    bus += np.stack([drone, drone]) * drone_auto

    # Electronic pulse (8ths at 120 BPM) from the run-up to the vortex, filter opening
    pulse = np.zeros(N)
    beat = 0.5
    t0 = fr(126)
    k = 0
    while t0 + k * beat / 2 < 21.0:
        at = t0 + k * beat / 2
        sec = next((s for s in sections if s[0] <= at < s[1]), sections[-1])
        n = idx(0.22)
        note = saw_stack(midi_hz(sec[2] + 12), n, 0.1, 3, 900 + k) * env_decay(n, 0.07, 0.003)
        pulse[idx(at) : idx(at) + n] += note[: max(0, N - idx(at))]
        k += 1
    pulse_f = np.zeros(N)
    # block-wise opening lowpass
    block = 4096
    for b0 in range(0, N, block):
        tt = b0 / SR
        fc = 300 + 3200 * np.clip((tt - 4.2) / 15, 0, 1)
        pulse_f[b0 : b0 + block] = filt(pulse[b0 : b0 + block], sos_lp(fc))
    pulse_auto = automation([(0, -80), (4.2, -80), (4.4, -24), (17, -16), (20.6, -16), (21.0, -60)])
    bus += pan_st(pulse_f, 0.0) * pulse_auto

    # Percussion: heartbeat in the opening, building patterns, accents on events
    perc = np.zeros((2, N))
    for s in [0.6, 1.6, 2.4, 3.2, 3.9]:
        place(perc, taiko(70, 0.8) * 0.3, s)
    # run-up: drums follow the footsteps and accelerate
    for i, f_ in enumerate(EV["footsteps"]):
        place(perc, tom(80 + i, 0.9 + 0.05 * i) * (0.35 + 0.08 * i), fr(f_))
    accents = [EV["ball_release"], EV["bat_contact"], EV["catch"], EV["throw_release"], EV["stump_hit"], EV["fist_pump"]]
    for i, a in enumerate(accents):
        place(perc, taiko(100 + i, 1.0) * 1.0, fr(a))
        place(perc, taiko(110 + i, 0.5) * 0.7, fr(a) + 0.01)
    # mid-section groove (S5..S10): taiko on beats, toms on off-beats
    t_beat = fr(250)
    while t_beat < 17.0:
        place(perc, taiko(int(t_beat * 100), 1.05) * 0.45, t_beat)
        place(perc, tom(int(t_beat * 97), 1.3) * 0.25, t_beat + 0.25)
        t_beat += 0.5
    # montage: hits on every beat cue plus 16th fills
    for i, f_ in enumerate(EV["montage_hits"]):
        place(perc, taiko(300 + i, 1.0 + 0.04 * i) * 0.9, fr(f_))
        place(perc, snare_hit(320 + i) * 0.45, fr(f_) + 0.1)
        for j in range(2):
            place(perc, tom(340 + i * 3 + j, 1.6 + 0.3 * j) * 0.22, fr(f_) + 0.05 + 0.05 * j)
    # vortex: accelerating drum roll crescendo into the logo
    t_roll = fr(EV["vortex"][0])
    step = 0.16
    i = 0
    while t_roll < fr(EV["vortex"][1]):
        level = 0.15 + 0.6 * (t_roll - fr(EV["vortex"][0])) / 2.0
        place(perc, tom(500 + i, 1.0 + 0.3 * (i % 3)) * level, t_roll)
        t_roll += step
        step = max(0.045, step * 0.94)
        i += 1
    # logo locks and logo play
    for i, f_ in enumerate(EV["logo_locks"]):
        place(perc, taiko(600 + i, 0.9) * 0.8, fr(f_))
    for f_ in [EV["logo_bat_hit"], EV["logo_wicket_hit"]]:
        place(perc, taiko(700 + f_, 1.1) * 0.9, fr(f_))
    # final resolution
    place(perc, taiko(800, 0.7, 3.0) * 1.4, fr(EV["final_hit"]))
    place(perc, taiko(801, 0.45, 3.0) * 1.2, fr(EV["final_hit"]))
    bus += perc * 0.9

    # Brass-like stab on the final hit (D5 power chord), long swell out
    n = idx(4.0)
    stab = np.zeros(n)
    for m in [38, 45, 50, 57, 62]:
        stab += saw_stack(midi_hz(m), n, 0.2, 5, 900 + m)
    stab = filt(stab, sos_lp(1800)) * env_decay(n, 1.6, 0.01)
    place(bus, pan_st(stab, 0.0), fr(EV["final_hit"]), -6)
    return bus


# ---------------------------------------------------------------- sfx

def build_sfx() -> np.ndarray:
    bus = np.zeros((2, N))
    # S1: floodlight contactors, electrical sizzle and hum onset, panned around the bowl
    hum_total = np.zeros(N)
    for i, f_ in enumerate(EV["flood_on"]):
        pan = np.cos(i / len(EV["flood_on"]) * 2 * np.pi) * 0.8
        clunk = thump(55, 0.22, 2.4, 0.9) * 0.9 + np.pad(click(20 + i, 1500, 8000, 0.02), (0, idx(0.88))) * 1.2
        place(bus, pan_st(clunk, pan), fr(f_), -4)
        place(bus, pan_st(noise_burst(40 + i, 3500, 9000, 0.35, 0.08), pan), fr(f_) + 0.01, -16)
        # hum onset: each bank adds a 100 Hz-ish buzz
        n0 = idx(fr(f_))
        t = t_axis(N - n0)
        buzz = (np.sin(2 * np.pi * 100 * t) + 0.4 * np.sin(2 * np.pi * 200 * t) + 0.2 * np.sin(2 * np.pi * 300 * t)) * 0.06
        hum_total[n0:] += buzz * np.clip(t / 0.05, 0, 1)
    hum_auto = automation([(0, 0), (2.2, 0), (2.6, -18), (27, -30)])
    bus += np.stack([hum_total, hum_total]) * hum_auto * 0.5
    # LED sweep: airy rising sweep panned L->R plus digital shimmer
    sw = whoosh(60, 0.7, 600, 6000, 0.7)
    place(bus, pan_st(sw, np.linspace(-0.8, 0.8, sw.size)), fr(EV["led_sweep"]), -14)
    place(bus, shimmer(61, 0.9, 3000, 7, travel=True), fr(EV["led_sweep"]), -18)

    # S2: leather handling, breaths
    for i, f_ in enumerate(EV["ball_handle"]):
        place(bus, pan_st(leather_creak(80 + i), 0.1), fr(f_), -6)
    for i, f_ in enumerate(EV["breath"]):
        place(bus, pan_st(breath(90 + i, 1.0), -0.05), fr(f_) - 0.1, -10)

    # S3-S4: footsteps, delivery
    for i, f_ in enumerate(EV["footsteps"]):
        place(bus, pan_st(footstep_grass(100 + i, 0.8 + 0.06 * i), 0.15 * (-1) ** i), fr(f_), -8 + i * 0.6)
    place(bus, footstep_grass(120, 1.6), fr(EV["front_foot_land"]), -2)
    arm = whoosh(121, 0.45, 300, 3200, 0.55)
    place(bus, pan_st(arm, 0.1), fr(EV["ball_release"]) - 0.25, -6)
    # slow-motion release: pitched-down low whoosh
    place(bus, pan_st(whoosh(122, 0.9, 80, 500, 0.5), 0.0), fr(SLOW["release"][0]), -8)
    # ball rush toward the batsman
    rush = whoosh(123, 0.7, 900, 2500, 0.8, 0.4)
    place(bus, pan_st(rush, np.linspace(0.6, -0.4, rush.size)), fr(200), -12)

    # S5: bat contact, with a pitched-down slow-motion layer and stadium echo
    crack = bat_crack(130)
    place(bus, crack, fr(EV["bat_contact"]), 0)
    slow = signal.resample(bat_crack(131), int(bat_crack(131).size / 0.45))
    place(bus, filt(slow, sos_lp(2500)), fr(EV["bat_contact"]) + 0.01, -8)
    place(bus, sub_impact(132, 1.6, 70, 32) * 0.8, fr(EV["bat_contact"]), -6)
    place(bus, pan_st(whoosh(133, 0.9, 500, 4000, 0.3), np.linspace(-0.3, 0.6, idx(0.9))), fr(258), -10)

    # S6: flight whoosh
    place(bus, pan_st(whoosh(140, 1.4, 300, 1800, 0.5, 0.5), 0.0), fr(276), -12)

    # S7: fielder steps, dive, catch, slide, wipe
    for i, f_ in enumerate(EV["fielder_steps"]):
        place(bus, footstep_grass(150 + i, 1.0), fr(f_), -7)
    place(bus, whoosh(155, 0.5, 250, 2000, 0.5), fr(EV["dive_launch"]), -8)
    place(bus, catch_slap(156), fr(EV["catch"]), -1)
    place(bus, sub_impact(157, 1.2, 65, 30) * 0.6, fr(EV["catch"]), -9)
    s0, s1 = EV["slide"]
    place(bus, pan_st(grass_slide(158, fr(s1 - s0) + 0.3), 0.1), fr(s0), -4)
    wipe = whoosh(159, 0.6, 400, 7000, 0.6)
    place(bus, pan_st(wipe, np.linspace(-0.7, 0.7, wipe.size)), fr(368), -8)

    # S8: collect, throw, batsman sprint
    place(bus, catch_slap(160) * 0.6, fr(EV["collect"]), -8)
    thr = whoosh(161, 0.55, 300, 3500, 0.55)
    place(bus, pan_st(thr, 0.2), fr(EV["throw_release"]) - 0.25, -4)
    place(bus, pan_st(whoosh(162, 0.8, 1200, 2600, 0.7, 0.4), np.linspace(0.6, -0.6, idx(0.8))), fr(396), -10)
    for i, f_ in enumerate(EV["batsman_steps"]):
        st = footstep_grass(170 + i, 1.3) + noise_burst(175 + i, 200, 1500, 0.25, 0.05) * 0.3  # pads
        place(bus, pan_st(st, -0.2), fr(f_), -6)

    # S9: stumps, bails (in slow motion), splinters
    place(bus, stump_crack(180), fr(EV["stump_hit"]), 0)
    slow_st = signal.resample(stump_crack(181), int(stump_crack(181).size / 0.4))
    place(bus, filt(slow_st, sos_lp(2000)), fr(EV["stump_hit"]) + 0.01, -6)
    clat = bail_clatter(182, 8, 0.6)
    place(bus, pan_st(signal.resample(clat, int(clat.size / 0.55)), 0.2), fr(EV["stump_hit"]) + 0.03, -6)
    place(bus, sub_impact(183, 2.2, 75, 28), fr(EV["stump_hit"]), -3)
    # the bail spinning toward camera: a close airy flutter into the transition
    flutter = whoosh(184, 0.9, 1500, 5000, 0.85, 0.3) * (0.6 + 0.4 * np.sin(2 * np.pi * 18 * t_axis(idx(0.9))))
    place(bus, pan_st(flutter, np.linspace(0.3, -0.3, flutter.size)), fr(456), -10)

    # S10: celebration footsteps on the turf
    for i in range(6):
        place(bus, footstep_grass(190 + i, 1.0), fr(468) + i * 0.17, -12)
    place(bus, whoosh(197, 0.5, 300, 2500, 0.4), fr(EV["fist_pump"]) - 0.1, -10)

    # S11: montage SFX keyed to each beat
    montage = [bat_crack(200), whoosh(201, 0.3, 400, 3000, 0.5), catch_slap(202), grass_slide(203, 0.3), footstep_grass(204, 1.4),
               noise_burst(205, 300, 1800, 0.3, 0.05), stump_crack(206), bail_clatter(207, 6, 0.25), whoosh(208, 0.3, 300, 2000, 0.4),
               whoosh(209, 0.4, 200, 1500, 0.4)]
    for i, f_ in enumerate(EV["montage_hits"]):
        place(bus, pan_st(montage[i], 0.4 * ((-1) ** i)), fr(f_), -5)

    # S12: vortex riser, metallic swirl
    v0, v1 = EV["vortex"]
    rise_len = fr(v1 - v0) + 0.2
    riser = whoosh(220, rise_len, 150, 9000, 0.92, 0.5)
    t = t_axis(riser.size)
    swirl_pan = np.sin(2 * np.pi * (0.6 + 2.2 * t / rise_len) * t)
    place(bus, pan_st(riser, swirl_pan * 0.8), fr(v0), -4)
    # shepard-ish rising tones
    n = idx(rise_len)
    tt = t_axis(n)
    tone = np.zeros(n)
    for o in range(4):
        f = 110 * 2 ** (o + 1.2 * tt / rise_len)
        tone += np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * ((o + tt / rise_len) / 4)) ** 2
    place(bus, pan_st(tone * env_ar(n, 0.3, 0.05) * 0.25, 0.0), fr(v0), -10)

    # S13: metallic assembly locks
    for i, f_ in enumerate(EV["logo_locks"]):
        place(bus, pan_st(metal_lock(240 + i, 1.0 + 0.06 * i), (-0.5 + 0.25 * i)), fr(f_), -2)

    # S14: logo play
    place(bus, bat_crack(260, 1.1), fr(EV["logo_bat_hit"]), -1)
    through = whoosh(261, 0.6, 700, 5000, 0.75, 0.4)
    place(bus, pan_st(through, np.linspace(-0.8, 0.4, through.size)), fr(EV["ball_through_p"]) - 0.35, -6)
    place(bus, shimmer(262, 0.8, 2600, 6), fr(EV["ball_through_p"]), -14)
    place(bus, stump_crack(263), fr(EV["logo_wicket_hit"]), -1)
    place(bus, metal_lock(264, 1.3), fr(EV["logo_wicket_hit"]), -6)
    place(bus, shimmer(265, 1.2, 1800, 10, travel=True), fr(EV["logo_wicket_hit"]) + 0.03, -8)

    # S15: final cinematic impact + metallic shimmer, title sparkle
    place(bus, sub_impact(280, 5.0, 90, 26), fr(EV["final_hit"]), 2)
    place(bus, metal_lock(281, 0.8), fr(EV["final_hit"]), -5)
    place(bus, shimmer(282, 2.5, 2400, 12), fr(EV["final_hit"]) + 0.05, -10)
    place(bus, shimmer(283, 1.4, 3400, 6), fr(EV["title_in"]), -16)

    return bus


# ---------------------------------------------------------------- ambience

def build_ambience() -> np.ndarray:
    bus = np.zeros((2, N))
    # Cinematic rumble
    rum = brown(N, 10)
    rum = filt(rum, sos_lp(110, 4))
    rum_auto = automation([(0, -30), (1.0, -22), (2.2, -20), (4, -26), (17, -28), (19, -18), (21, -16), (24.6, -30), (27, -60)])
    bus += np.stack([rum, filt(brown(N, 11), sos_lp(110, 4))]) * rum_auto

    murmur, (roar, clap, whistles) = build_crowd()
    E = lambda name: fr(EV[name])  # noqa: E731
    crowd_db = [
        (0, -55), (0.4, -40), (1.6, -30), (2.2, -28), (4.2, -24), (6.2, -20), (E("bat_contact") - 0.1, -19),
        (E("bat_contact") + 0.6, -12), (10.6, -12), (E("catch"), -14), (E("catch") + 0.4, -7), (12.6, -9), (14.0, -10),
        (E("stump_hit") - 0.1, -12), (E("stump_hit") + 0.9, -5), (16.0, -6), (17.0, -9), (19.0, -10), (20.5, -22),
        (21.0, -30), (23.5, -26), (E("final_hit"), -18), (E("final_hit") + 0.8, -6), (26.0, -10), (27, -40),
    ]
    roar_db = [(p[0], p[1] - 4) for p in crowd_db]
    murmur_g = automation([(p[0], p[1] + 2) for p in crowd_db])
    roar_g = automation(roar_db) * automation([(0, -30), (7.6, -30), (8.2, 0), (27, 0)])
    clap_g = automation([(0, -60), (8.0, -60), (8.6, -14), (10.0, -24), (11.8, -12), (13.5, -22), (15.0, -10), (17.0, -16), (20, -40), (24.8, -14), (27, -40)])
    crowd = murmur * murmur_g + roar * roar_g + clap * clap_g + whistles * automation([(0, -8), (27, -8)])
    # Distance: lowpass the crowd early (heard from far above), and in slow-motion windows
    far = np.stack([filt(crowd[c], sos_lp(700)) for c in range(2)])
    near_amt = automation([(0, 0), (1.4, 0), (2.2, 1), (27, 1)], in_db=False)
    for a, b in SLOW.values():
        near_amt *= 1 - 0.85 * automation([(0, 0), (fr(a) - 0.05, 0), (fr(a) + 0.1, 1), (fr(b) - 0.1, 1), (fr(b) + 0.15, 0), (27, 0)], in_db=False)
    # vortex: the stadium drains away as the cricket becomes graphics
    near_amt *= 1 - 0.8 * automation([(0, 0), (19.2, 0), (20.8, 1), (24.6, 1), (25.0, 0), (27, 0)], in_db=False)
    crowd = crowd * near_amt + far * (1 - near_amt)
    bus += crowd
    return bus


# ---------------------------------------------------------------- master

def compress(x: np.ndarray, thresh_db: float = -14, ratio: float = 2.5, attack: float = 0.01, release: float = 0.25) -> np.ndarray:
    level = np.max(np.abs(x), axis=0)
    a_a = np.exp(-1 / (attack * SR))
    a_r = np.exp(-1 / (release * SR))
    env = signal.lfilter([1 - a_r], [1, -a_r], level)  # smooth (release-ish)
    env = np.maximum(env, signal.lfilter([1 - a_a], [1, -a_a], level))
    env_db = 20 * np.log10(env + 1e-9)
    gr_db = np.minimum(0, (thresh_db - env_db) * (1 - 1 / ratio))
    return x * 10 ** (gr_db / 20)


def limit(x: np.ndarray, ceiling: float = 0.89, look: float = 0.004) -> np.ndarray:
    la = idx(look)
    peak = np.max(np.abs(x), axis=0)
    # running max over the lookahead window
    pk = signal.convolve(peak, np.ones(la), mode="same") / la
    pk = np.maximum(pk, peak)
    gain = np.minimum(1, ceiling / (pk + 1e-9))
    gain = signal.lfilter([1 - np.exp(-1 / (0.05 * SR))], [1, -np.exp(-1 / (0.05 * SR))], gain)
    gain = np.minimum(gain, ceiling / (peak + 1e-9))
    return x * gain


def write(path: str, x: np.ndarray):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    y = np.clip(x, -1, 1)
    wavfile.write(path, SR, (y.T * 32767).astype(np.int16))


def main():
    out = os.path.join(ROOT, "public", "audio")
    print("ambience...", flush=True)
    amb = build_ambience()
    print("sfx...", flush=True)
    sfx = build_sfx()
    print("music...", flush=True)
    mus = build_music()

    stadium_ir = reverb_ir(2.6, 900, 5500, 0.035)
    small_ir = reverb_ir(0.9, 950, 7000, 0.01)
    sfx = convolve(sfx, stadium_ir, 0.22)
    mus = convolve(mus, small_ir, 0.18)
    amb = convolve(amb, stadium_ir, 0.12)

    amb = norm(amb, 0.5)
    sfx = norm(sfx, 0.9)
    mus = norm(mus, 0.8)
    write(os.path.join(out, "stems", "ambience.wav"), amb)
    write(os.path.join(out, "stems", "sfx.wav"), sfx)
    write(os.path.join(out, "stems", "music.wav"), mus)

    mix = amb * 1.9 + sfx * 0.95 + mus * 0.55
    mix = compress(mix, -12, 1.8)
    mix = limit(norm(mix, 0.98), 0.9)
    # gentle fade-in from silence and tail fade at the very end
    fade = automation([(0, 0), (0.15, 1), (26.6, 1), (27, 0)], in_db=False)
    mix *= fade
    raw = os.path.join(out, "stems", "_premaster.wav")
    write(raw, mix)

    final = os.path.join(out, "mpl_mix.wav")
    # Two-pass loudnorm in linear mode: one static gain, so the quiet-to-loud build survives.
    target = "I=-16:TP=-1.5:LRA=20"
    probe = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", raw, "-af", f"loudnorm={target}:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    ).stderr
    m = json.loads(probe[probe.rindex("{") : probe.rindex("}") + 1])
    second = (
        f"loudnorm={target}:linear=true:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
        f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}"
    )
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-af", second, "-ar", str(SR), final], check=True)
    print("wrote", final, flush=True)


if __name__ == "__main__":
    sys.exit(main())
