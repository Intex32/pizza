/**
 * Audible alert for overdue pizzas. Oscillator tones, no audio files.
 *
 * Tablets refuse to start audio unless a real user gesture started it, so the context is
 * created AND resumed synchronously inside a click handler (see unlockAudio), plus a short
 * real playback, which is what iOS actually wants.
 */
const MUTE_KEY = 'pizza.alarmMuted';

let ctx: AudioContext | null = null;
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

/** MUST be called synchronously from inside a real click/tap handler. */
export function unlockAudio(): void {
  const Ctor = audioCtor();
  if (!Ctor) return;
  try {
    if (!ctx) ctx = new Ctor();
    void ctx.resume();
    // A moment of genuine silent playback - iOS treats a bare resume() as insufficient.
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    ctx = null;
  }
}

export function audioReady(): boolean {
  return ctx !== null && ctx.state === 'running';
}

function tone(startDelayS: number, freq: number, durationS: number, gain: number): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const vol = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + startDelayS;
  // Ramped rather than switched, because an abrupt gain change clicks unpleasantly.
  vol.gain.setValueAtTime(0.0001, t0);
  vol.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  vol.gain.exponentialRampToValueAtTime(0.0001, t0 + durationS);
  osc.connect(vol);
  vol.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + durationS + 0.05);
}

/** A two-note chirp. Distinct from a phone notification, and audible over an extractor fan. */
export function ping(): void {
  if (!ctx || ctx.state !== 'running') return;
  tone(0, 880, 0.18, 0.3);
  tone(0.22, 1320, 0.22, 0.3);
}

export function testSound(): void {
  unlockAudio();
  ping();
}

const REPEAT_MS = 20_000;

/**
 * Called on every tick of the oven screen. Pings once when something first goes overdue and
 * then every 20s while anything still is - and never while the tab is hidden, so a tablet in
 * a pocket does not chirp all evening.
 */
export function maybeAlarm(overdueCount: number, now: number): void {
  if (overdueCount === 0) {
    lastPingAt = 0;
    return;
  }
  if (isMuted() || !audioReady()) return;
  if (document.visibilityState !== 'visible') return;
  if (lastPingAt !== 0 && now - lastPingAt < REPEAT_MS) return;
  lastPingAt = now;
  ping();
}
