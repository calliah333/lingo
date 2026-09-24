/** A short sine "ping" for highlights. Audio failures must never interrupt message handling. */
export function playChime(context: AudioContext): void {
  try {
    if (context.state === 'suspended') void context.resume().catch(() => {});
    const oscillator = context.createOscillator();
    const volume = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 740;
    volume.gain.setValueAtTime(0.0001, context.currentTime);
    volume.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.01);
    volume.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
    oscillator.connect(volume);
    volume.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.19);
  } catch { /* An unavailable audio device must not interrupt messages. */ }
}
