/**
 * local patch (IntelliBooks fork, consent line) — the announcer's contract, OFFLINE (no browser).
 *
 * Pins: no text ⇒ not wired and nothing reported (upstream behaviour); the line is sent at most
 * once however often post() is called; every send outcome — including a throw, a hang, or an
 * unknown value — lands as a typed status on the terminal fields and never escapes as an error;
 * a bot that never reached the post reports `not_attempted`.
 * Run: npx tsx src/consent.test.ts
 */
import { createConsentAnnouncer, mergeTerminalFields } from './consent.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};
const quiet = () => { /* */ };
const statusOf = (r: Record<string, unknown> | undefined) =>
  (r?.consent_message as { status?: string; detail?: string } | undefined);

async function main(): Promise<void> {
  console.log('\n=== consent line (fork) ===');

  // No text ⇒ disabled, no send, no report.
  let sends = 0;
  let a = createConsentAnnouncer({ text: '  ', send: async () => { sends++; return { outcome: 'posted' }; }, log: quiet, settleMs: 0 });
  await a.post();
  check('empty text → not enabled', a.enabled === false);
  check('empty text → nothing sent', sends === 0);
  check('empty text → no terminal fields', a.report() === undefined);

  // Posted once, however often post() is called.
  sends = 0;
  let sent = '';
  a = createConsentAnnouncer({ text: ' Recorded by Notetaker. ', send: async (t) => { sends++; sent = t; return { outcome: 'posted' }; }, log: quiet, settleMs: 0 });
  check('configured → not_attempted before post', statusOf(a.report())?.status === 'not_attempted');
  await Promise.all([a.post(), a.post()]);
  await a.post();
  check('configured → sent exactly once', sends === 1, `sends=${sends}`);
  check('configured → trimmed text sent', sent === 'Recorded by Notetaker.', sent);
  check('configured → status posted', statusOf(a.report())?.status === 'posted');

  // Chat unavailable carries its detail.
  a = createConsentAnnouncer({ text: 'x', send: async () => ({ outcome: 'chat_unavailable', detail: 'chat turned off for participants' }), log: quiet, settleMs: 0 });
  await a.post();
  const s = statusOf(a.report());
  check('chat off → chat_unavailable + detail', s?.status === 'chat_unavailable' && s?.detail === 'chat turned off for participants', JSON.stringify(s));

  // A throwing sender never escapes.
  a = createConsentAnnouncer({ text: 'x', send: async () => { throw new Error('page closed'); }, log: quiet, settleMs: 0 });
  let threw = false;
  try { await a.post(); } catch { threw = true; }
  check('send throws → post() still resolves', !threw);
  check('send throws → failed', statusOf(a.report())?.status === 'failed');

  // A hanging sender is cut off by the cap.
  a = createConsentAnnouncer({ text: 'x', send: () => new Promise(() => { /* never */ }), log: quiet, settleMs: 0, timeoutMs: 20 });
  await a.post();
  check('send hangs → failed (timed out)', statusOf(a.report())?.status === 'failed' && /timed out/.test(statusOf(a.report())?.detail ?? ''));

  // An off-contract outcome is not passed through.
  a = createConsentAnnouncer({ text: 'x', send: async () => ({ outcome: 'weird' }), log: quiet, settleMs: 0 });
  await a.post();
  check('unknown outcome → failed', statusOf(a.report())?.status === 'failed');

  // Terminal-field merge keeps the STT fault summary intact.
  const merged = mergeTerminalFields({ stt_fault: { total: 2 }, reason: 'stt_degraded: x×2' }, { consent_message: { status: 'posted' } });
  check('merge keeps both field sets', !!merged?.stt_fault && !!merged?.consent_message && merged?.reason === 'stt_degraded: x×2');
  check('merge of nothing → undefined', mergeTerminalFields(undefined, undefined) === undefined);

  if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
  console.log('\nall consent checks passed');
}

void main();
