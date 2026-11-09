/**
 * local patch (IntelliBooks fork, consent line) — post ONE line in the meeting chat once the bot is
 * admitted and recording (e.g. "This meeting is being recorded and transcribed by Notetaker.").
 *
 * The text arrives on invocation.v1 `consentMessage` (meeting-api resolves the request's
 * `consent_message`, else its BOT_CONSENT_MESSAGE env default). Absent/empty ⇒ this module is not
 * wired at all and the bot behaves exactly as upstream.
 *
 * Contract: never throws, never ends or leaves the meeting. The outcome is logged and rides the
 * TERMINAL lifecycle.v1 event as `consent_message: { status, detail? }` (additive — lifecycle.v1 is
 * additionalProperties:true, exactly like `stt_fault`), which meeting-api keeps in meeting.data.
 * Posts at most once per bot process (the bot has no in-process rejoin); a later session of the same
 * meeting is covered by meeting-api (it drops the line on continue_meeting once a session reported
 * it posted) and by the chat sender's "identical line already visible" check.
 */
export type ConsentStatus =
  | 'posted'
  | 'already_posted'
  | 'sent_unverified'
  | 'chat_unavailable'
  | 'failed'
  | 'not_attempted';

export interface ChatSendResultLike {
  outcome: string;
  detail?: string;
}

export interface ConsentAnnouncer {
  /** True when a consent line is configured (otherwise nothing is wired). */
  readonly enabled: boolean;
  /** Post the line — first call only; later calls are no-ops. Never throws. */
  post(): Promise<void>;
  /** Terminal-lifecycle fields; undefined when no consent line is configured. Never throws. */
  report(): Record<string, unknown> | undefined;
}

export interface ConsentAnnouncerOptions {
  text: string | undefined;
  /** Sends one chat line on the live meeting page (wired to @vexa/join sendMeetingChat). */
  send: (text: string) => Promise<ChatSendResultLike>;
  log?: (message: string) => void;
  /** Let the in-meeting UI settle after admission before touching it (default 3 s). */
  settleMs?: number;
  /** Cap on the whole attempt (default 45 s) — a wedged page must not hold the result forever. */
  timeoutMs?: number;
}

const KNOWN: readonly ConsentStatus[] = ['posted', 'already_posted', 'sent_unverified', 'chat_unavailable', 'failed'];

export function createConsentAnnouncer(opts: ConsentAnnouncerOptions): ConsentAnnouncer {
  const text = (opts.text ?? '').trim();
  const log = opts.log ?? ((m: string) => console.log(`[bot] ${m}`));
  const settleMs = opts.settleMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  let attempt: Promise<void> | null = null;
  let status: ConsentStatus = 'not_attempted';
  let detail: string | undefined;

  const run = async (): Promise<void> => {
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race<ChatSendResultLike>([
        opts.send(text),
        new Promise<ChatSendResultLike>((resolve) => {
          timer = setTimeout(() => resolve({ outcome: 'failed', detail: `timed out after ${timeoutMs} ms` }), timeoutMs);
        }),
      ]);
      status = (KNOWN as readonly string[]).includes(result.outcome) ? result.outcome as ConsentStatus : 'failed';
      detail = result.detail;
    } catch (e) {
      status = 'failed';
      detail = String((e as Error)?.message ?? e).split('\n')[0];
    } finally {
      if (timer) clearTimeout(timer);
    }
    log(`consent message: ${status}${detail ? ` (${detail})` : ''}`);
  };

  return {
    enabled: text.length > 0,
    post() {
      if (!text) return Promise.resolve();
      if (!attempt) attempt = run().catch(() => { /* run() already never throws */ });
      return attempt;
    },
    report() {
      if (!text) return undefined;
      return { consent_message: { status, ...(detail ? { detail } : {}) } };
    },
  };
}

/** Merge two terminal-event field sets (either may be undefined). */
export function mergeTerminalFields(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!a) return b;
  if (!b) return a;
  return { ...a, ...b };
}
