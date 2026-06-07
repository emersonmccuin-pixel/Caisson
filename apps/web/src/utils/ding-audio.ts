/**
 * Synthesises and plays a gentle two-note chime via the Web Audio API.
 * No binary asset — the sound is generated entirely in code.
 *
 * Autoplay policy: audio context creation requires a prior user gesture.
 * In normal app use this is already satisfied (the user clicked / typed
 * before the first ding fires). If not, the AudioContext construction or
 * .resume() will silently fail — caught and swallowed below.
 */
export function playDing(): void {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return;
  }

  const PEAK_GAIN = 0.12;  // quiet but audible
  const DURATION = 0.5;    // seconds per note envelope

  function note(frequencyHz: number, delayS: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle'; // softer timbre than sawtooth, richer than sine
    osc.frequency.value = frequencyHz;

    const t0 = ctx.currentTime + delayS;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, t0 + 0.012);       // 12ms attack
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + DURATION);  // ~500ms decay

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + DURATION);
  }

  // A5 (880 Hz) → C#6 (1108.7 Hz): a pleasant major-third rising chime.
  note(880, 0);
  note(1108.73, 0.06);

  // Free the AudioContext once the sound finishes.
  const closeAfterMs = (DURATION + 0.2) * 1_000;
  setTimeout(() => void ctx.close(), closeAfterMs);
}
