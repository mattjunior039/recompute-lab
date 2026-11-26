import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, resampleTo16k, splitSentences, wavToPcm16k } from '../../web/src/node/speech';

function wav16(rate: number, channels: number, frames: (i: number, ch: number) => number, n: number) {
  const buf = new ArrayBuffer(44 + n * channels * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * channels * 2, true);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) v.setInt16(44 + (i * channels + c) * 2, Math.round(frames(i, c) * 32767), true);
  return buf;
}

test('wavToPcm16k mixes 44.1 kHz stereo PCM16 down to 16 kHz mono', () => {
  const pcm = wavToPcm16k(wav16(44100, 2, (_, c) => (c ? 0.5 : 0.1), 44100));
  assert.equal(pcm.length, 16000);
  assert.ok(Math.abs(pcm[8000] - 0.3) < 1e-3);
});

test('resampleTo16k keeps a 440 Hz tone at 440 Hz', () => {
  const tone = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000));
  const out = resampleTo16k(tone, 48000);
  assert.equal(out.length, 16000);
  let crossings = 0;
  for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 !== out[i] < 0) crossings++;
  assert.ok(Math.abs(crossings - 880) <= 2, `${crossings} zero crossings`);
});

test('cleanTranscript strips non-speech tags and silence hallucinations', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.equal(cleanTranscript('(music) Hello class. ♪'), 'Hello class.');
  assert.equal(cleanTranscript(' you', 0.1), '');
  assert.equal(cleanTranscript('Thank you.', 0.1), '');
  assert.equal(cleanTranscript('Thank you.', 0.9), 'Thank you.');
});

test('splitSentences keeps punctuation and trailing fragments', () => {
  assert.deepEqual(splitSentences('Hi there! How are you? Fine. and then'), ['Hi there!', 'How are you?', 'Fine.', 'and then']);
});
