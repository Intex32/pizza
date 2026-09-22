/**
 * Alerts for a LOUD kitchen: extractor fan, music, thirty people talking.
 *
 * The design is deliberately unsubtle, and every part of it is chosen to survive noise:
 *
 *  - SQUARE waves, not sine. A sine is a single frequency with no harmonics and is trivially
 *    masked by broadband noise. A square wave puts energy across the whole spectrum, so some
 *    of it always gets through.
 *  - ~3 kHz. That is where the ear canal resonates and human hearing is most sensitive - it
 *    is why smoke alarms sit there rather than somewhere more pleasant.
 *  - WARBLING between two pitches rather than holding one. A steady tone fades into the
 *    background of a noisy room within seconds; a changing one does not, and it also dodges
 *    any narrowband noise (a fan whine) that would mask a fixed pitch.
 *  - A BURST of beeps, not one. A single blip lands in a gap in the noise and is gone.
 *  - Soft clipping through a WaveShaper. It adds harmonics on purpose, and bounds the output
 *    so stacking oscillators cannot produce ugly digital clipping or hurt a tablet speaker.
 *  - Two DETUNED oscillators per beep. The few-Hz beating makes it rough and hard to ignore.
 */
const MUTE_KEY = 'pizza.alarmMuted';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let shaper: WaveShaperNode | null = null;
let lastPingAt = 0;

type Ctor = typeof AudioContext;

function audioCtor(): Ctor | undefined {
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext;
}

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // per-device convenience only; nothing depends on it persisting
  }
}

/** tanh soft clip: bounded output, and the distortion itself is extra harmonics to hear. */
function softClipCurve(drive = 9): Float32Array<ArrayBuffer> {
  const n = 2048;
  // Backed by an explicit ArrayBuffer: WaveShaperNode.curve will not accept the
  // SharedArrayBuffer-compatible type that a bare `new Float32Array(n)` infers.
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const k = Math.tanh(drive);
  for (let i = 0; i < n; i += 1) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(x * drive) / k;
  }
  return curve;
}

/** MUST be called synchronously from inside a real click/tap handler. */
export function unlockAudio(): void {
  const Ctor = audioCtor();
  if (!Ctor) return;
  try {
    if (!ctx) {
      ctx = new Ctor();
      shaper = ctx.createWaveShaper();
      shaper.curve = softClipCurve();
      shaper.oversample = '4x'; // keeps the added harmonics from aliasing into mush
      master = ctx.createGain();
      // Measured: the soft clipper bounds its own output to +/-1, but the 4x oversampling
      // filter rings and overshoots to ~1.34 on these hard square edges. Left at unity that
      // overshoot hard-clips at the output device - uncontrolled distortion that sounds bad
      // and is unkind to a small tablet speaker. 0.72 puts the true peak just under 1.0 and
      // still leaves this roughly 11 dB louder than the sound it replaces.
      master.gain.value = 0.72;
      shaper.connect(master);
      master.connect(ctx.destination);
    }
    void ctx.resume();
    // A moment of genuine silent playback - iOS treats a bare resume() as insufficient.
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    ctx = null;
    master = null;
    shaper = null;
  }
}

export function audioReady(): boolean {
  return ctx !== null && ctx.state === 'running';
}

type Beep = {
  at: number;
  freq: number;
  durationS: number;
  gain: number;
  wave?: OscillatorType;
};

function play(beeps: Beep[]): void {
  if (!ctx || !shaper || ctx.state !== 'running') return;
  const base = ctx.currentTime + 0.01;

  for (const b of beeps) {
    const env = ctx.createGain();
    env.connect(shaper);
    const t0 = base + b.at;
    const t1 = t0 + b.durationS;
    // Fast attack so it sounds like a hard edge rather than a fade-in, but not so fast that
    // it clicks; the release is quick because a ringing tail just muddies the next beep.
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(b.gain, t0 + 0.004);
    env.gain.setValueAtTime(b.gain, t1 - 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t1);

    // Two oscillators a few Hz apart: the beating between them is what makes it grating.
    for (const detune of [0, 9]) {
      const osc = ctx.createOscillator();
      osc.type = b.wave ?? 'square';
      osc.frequency.value = b.freq + detune;
      osc.connect(env);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
  }
}

// --- The oven alarm: a pizza is burning -------------------------------------------------
const OVEN_HIGH = 3100;
const OVEN_LOW = 2350;
const OVEN_GAIN = 0.95;

/** Four hard beeps warbling between two pitches. Roughly a smoke alarm, on purpose. */
export function ping(): void {
  play([
    { at: 0.0, freq: OVEN_HIGH, durationS: 0.13, gain: OVEN_GAIN },
    { at: 0.17, freq: OVEN_LOW, durationS: 0.13, gain: OVEN_GAIN },
    { at: 0.34, freq: OVEN_HIGH, durationS: 0.13, gain: OVEN_GAIN },
    { at: 0.51, freq: OVEN_LOW, durationS: 0.2, gain: OVEN_GAIN },
  ]);
}

// --- The prep alert: a new pizza to make -------------------------------------------------
/**
 * Loud enough for the same room, but deliberately the opposite shape: two DESCENDING notes,
 * an octave below the oven alarm, and over in a third of the time. Two alerts that both
 * sound urgent would be worse than one, so the hierarchy has to be audible instantly.
 */
export function prepPing(): void {
  play([
    { at: 0.0, freq: 1175, durationS: 0.11, gain: 0.7 },
    { at: 0.15, freq: 784, durationS: 0.18, gain: 0.7 },
  ]);
}

/** Same gating as the oven alarm: muted devices and hidden tabs stay silent. */
export function playPrepArrival(): void {
  if (isMuted() || !audioReady()) return;
  if (document.visibilityState !== 'visible') return;
  prepPing();
}

export function testSound(): void {
  unlockAudio();
  ping();
}

export function testPrepSound(): void {
  unlockAudio();
  prepPing();
}

// --- Repeat cadence ---------------------------------------------------------------------
const REPEAT_MS = 9_000;
const URGENT_REPEAT_MS = 4_500;
/** Past a minute over, nobody has heard it - so nag twice as often. */
const URGENT_AFTER_MS = 60_000;

/**
 * Called on every tick of the oven screen. Fires once when something first goes overdue and
 * then on a repeat that TIGHTENS the longer a pizza is left - never while the tab is hidden,
 * so a tablet in a pocket does not shriek all evening.
 */
export function maybeAlarm(overdueCount: number, maxOverdueMs: number, now: number): void {
  if (overdueCount === 0) {
    lastPingAt = 0;
    return;
  }
  if (isMuted() || !audioReady()) return;
  if (document.visibilityState !== 'visible') return;
  const interval = maxOverdueMs >= URGENT_AFTER_MS ? URGENT_REPEAT_MS : REPEAT_MS;
  if (lastPingAt !== 0 && now - lastPingAt < interval) return;
  lastPingAt = now;
  ping();
}
