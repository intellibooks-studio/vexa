import { Page } from "playwright";
import { log } from "../_host";

// Presence-based aloneness: end when the bot is the ONLY participant for a short
// window (everyone left). Distinct from audio-silence aloneness — a muted/silent
// human still counts as company.
//
// The count comes FIRST from the speaker observer, which publishes its own
// battle-tested participant count on `window.__vexaPresence` each scan (the same
// number it logs as "Scanned N participants"). My earlier DOM re-count used the
// wrong selectors and always read 0 → never fired. A per-platform DOM fallback
// covers the window before the observer's first publish. `count` includes the
// bot, so others = count − 1. total 0 / stale = UNKNOWN → never ends.

const DEFAULT_PRESENCE_WINDOW_MS = 30_000;
const PRESENCE_POLL_MS = 3_000;
const LOG_EVERY_MS = 15_000;

function resolveWindowMs(): number {
  const raw = process.env.BOT_ALONE_PRESENCE_WINDOW_MS;
  if (raw && raw.trim() !== "") {
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return DEFAULT_PRESENCE_WINDOW_MS;
}

// NON-bot participant count, or null on unknown.
async function countOthers(page: Page, platform: string): Promise<number | null> {
  try {
    return await page.evaluate((plat: string) => {
      // 1) Authoritative: the speaker observer's own participant count.
      const g = (window as unknown as { __vexaPresence?: { count?: number; at?: number } }).__vexaPresence;
      if (g && typeof g.count === "number" && Date.now() - (g.at || 0) < 20000) {
        return g.count > 0 ? g.count - 1 : 0;
      }
      // 2) Fallback DOM count (total includes the bot).
      let total = 0;
      if (plat === "teams") {
        const ids = new Set<string>();
        document.querySelectorAll('[data-stream-type][data-tid]').forEach((el) => {
          const id = (el as HTMLElement).getAttribute("data-tid");
          if (id) ids.add(id);
        });
        total = ids.size;
      } else if (plat === "zoom") {
        total = document.querySelectorAll(".video-avatar__avatar-footer").length
          || document.querySelectorAll('[class*="video-avatar"]').length;
      } else {
        const ids = new Set<string>();
        document.querySelectorAll('[data-participant-id]').forEach((el) => {
          const id = (el as HTMLElement).getAttribute("data-participant-id");
          if (id) ids.add(id);
        });
        total = ids.size;
      }
      if (total === 0) return null;
      return total - 1;
    }, platform);
  } catch {
    return null;
  }
}

function startPresenceMonitor(
  platform: string,
  page: Page,
  onAlone?: () => void | Promise<void>,
): () => void {
  const windowMs = resolveWindowMs();
  const label = platform === "teams" ? "Teams" : platform === "zoom" ? "Zoom" : "Google Meet";
  log(`Starting ${label} presence monitor (end when alone for ${windowMs}ms)...`);
  let aloneSince: number | null = null;
  let fired = false;
  let lastLog = 0;

  const interval = setInterval(async () => {
    if (fired) return;
    const others = await countOthers(page, platform);
    const nowMs = Date.now();
    if (others === null) {
      if (nowMs - lastLog >= LOG_EVERY_MS) { lastLog = nowMs; log(`presence(${label}): participant count UNKNOWN — waiting`); }
      return;
    }
    if (others > 0) {
      if (aloneSince !== null || nowMs - lastLog >= LOG_EVERY_MS) { lastLog = nowMs; log(`presence(${label}): ${others} other participant(s) present — waiting`); }
      aloneSince = null;
      return;
    }
    if (aloneSince === null) {
      aloneSince = nowMs;
      log(`presence(${label}): bot appears ALONE — starting ${windowMs}ms countdown`);
      return;
    }
    if (nowMs - aloneSince >= windowMs) {
      fired = true;
      clearInterval(interval);
      log(`🚪 ${label}: bot alone (no other participants) for ${windowMs}ms — ending meeting.`);
      try { await onAlone?.(); } catch { /* a leave attempt must never break the monitor */ }
    }
  }, PRESENCE_POLL_MS);

  return () => clearInterval(interval);
}

export function startGooglePresenceMonitor(page: Page, onAlone?: () => void | Promise<void>): () => void {
  return startPresenceMonitor("google", page, onAlone);
}

export function startTeamsPresenceMonitor(page: Page, onAlone?: () => void | Promise<void>): () => void {
  return startPresenceMonitor("teams", page, onAlone);
}

export function startZoomPresenceMonitor(page: Page, onAlone?: () => void | Promise<void>): () => void {
  return startPresenceMonitor("zoom", page, onAlone);
}
