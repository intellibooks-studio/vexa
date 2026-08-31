import { Page } from "playwright";
import { log } from "../_host";

// Presence-based aloneness: end the meeting when the bot is the ONLY participant
// for a short window (everyone else left). This is DISTINCT from the audio-
// silence aloneness (10 min) — it fires on PRESENCE, not on quiet. A participant
// who is present but muted/silent still counts as company, so the bot keeps
// waiting; only an empty room (bot alone) ends here.
//
// Fail-safe by construction: if the page can't be read, or the bot's own tile
// can't be identified, we do NOT conclude "alone" — the bot STAYS. The monitor
// fires only on a confident "zero non-bot participants".

const DEFAULT_PRESENCE_WINDOW_MS = 30_000;
const PRESENCE_POLL_MS = 3_000;

function resolveWindowMs(): number {
  const raw = process.env.BOT_ALONE_PRESENCE_WINDOW_MS;
  if (raw && raw.trim() !== "") {
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return DEFAULT_PRESENCE_WINDOW_MS;
}

/** Count NON-self participant tiles in the Meet DOM (runs in the page). Returns
 *  null on any read failure (navigating/closed) so the caller treats it as
 *  UNKNOWN and keeps waiting rather than leaving. */
async function countOthers(page: Page): Promise<number | null> {
  try {
    return await page.evaluate(() => {
      const marker = document.querySelector('[data-self-name]');
      const selfTile = marker ? marker.closest('[data-participant-id]') : null;
      const selfId = selfTile ? selfTile.getAttribute('data-participant-id') : null;
      const ids = new Set<string>();
      document.querySelectorAll('[data-participant-id]').forEach((el) => {
        const id = (el as HTMLElement).getAttribute('data-participant-id');
        if (id) ids.add(id);
      });
      let others = 0;
      ids.forEach((id) => { if (id !== selfId) others += 1; });
      return others;
    });
  } catch {
    return null;
  }
}

export function startGooglePresenceMonitor(
  page: Page,
  onAlone?: () => void | Promise<void>,
): () => void {
  const windowMs = resolveWindowMs();
  log(`Starting Google Meet presence monitor (end when alone for ${windowMs}ms)...`);
  let aloneSince: number | null = null;
  let fired = false;

  const interval = setInterval(async () => {
    if (fired) return;
    const others = await countOthers(page);
    if (others === null) return;                 // unknown → keep waiting
    if (others > 0) { aloneSince = null; return; } // company present → reset
    // others === 0 → only the bot is here.
    const nowMs = Date.now();
    if (aloneSince === null) { aloneSince = nowMs; return; }
    if (nowMs - aloneSince >= windowMs) {
      fired = true;
      clearInterval(interval);
      log(`🚪 Google Meet: bot alone (no other participants) for ${windowMs}ms — ending meeting.`);
      try { await onAlone?.(); } catch { /* a repair/leave attempt must never break the monitor */ }
    }
  }, PRESENCE_POLL_MS);

  return () => clearInterval(interval);
}
