import { Page } from "playwright";
import { log } from "../_host";

// Presence-based aloneness: end the meeting when the bot is the ONLY participant
// for a short window. Distinct from audio-silence aloneness (10 min) — fires on
// PRESENCE (people left), so a muted/silent human still counts as company.
//
// Robust to self-tile detection failing: if the bot's own tile can't be
// identified we assume exactly ONE tile is the bot (total − 1), so a missing
// self-marker can't wedge the count. total === 0 (DOM not ready) is UNKNOWN and
// never ends. Every poll logs its count so a live run is diagnosable.

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

// NON-bot participants in a Google Meet, or null on unknown.
async function countGoogleOthers(page: Page): Promise<number | null> {
  try {
    return await page.evaluate(() => {
      const ids = new Map<string, boolean>(); // participant id -> isSelf
      document.querySelectorAll('[data-participant-id]').forEach((node) => {
        const el = node as HTMLElement;
        const id = el.getAttribute('data-participant-id');
        if (!id) return;
        const isSelf = el.hasAttribute('data-self-name') || !!el.querySelector('[data-self-name]');
        if (!ids.has(id) || isSelf) ids.set(id, isSelf);
      });
      const total = ids.size;
      if (total === 0) return null;
      let selfCount = 0;
      ids.forEach((s) => { if (s) selfCount += 1; });
      return selfCount > 0 ? total - selfCount : total - 1;
    });
  } catch {
    return null;
  }
}

// NON-bot participants in a Teams meeting, or null on unknown. Teams' DOM has no
// single clean participant id, so dedupe across the tile/roster surfaces.
async function countTeamsOthers(page: Page): Promise<number | null> {
  try {
    return await page.evaluate(() => {
      const ids = new Set<string>();
      const sels = [
        '[data-tid*="participant-tile"]', '[data-tid*="video-tile"]',
        '[data-tid*="roster-item"]', '[data-participant-id]', '[data-user-id]',
      ];
      for (const s of sels) {
        document.querySelectorAll(s).forEach((node) => {
          const el = node as HTMLElement;
          const id = el.getAttribute('data-participant-id')
            || el.getAttribute('data-user-id')
            || el.getAttribute('data-tid');
          if (id) ids.add(id);
        });
      }
      const total = ids.size;
      if (total === 0) return null;
      return total - 1; // assume one surface is the bot
    });
  } catch {
    return null;
  }
}

// NON-bot participants in a Zoom (web client) meeting, or null on unknown. Each
// participant tile carries a `.video-avatar__avatar-footer` name element.
async function countZoomOthers(page: Page): Promise<number | null> {
  try {
    return await page.evaluate(() => {
      let total = document.querySelectorAll('.video-avatar__avatar-footer').length;
      if (total === 0) total = document.querySelectorAll('[class*="video-avatar"]').length;
      if (total === 0) return null;
      return total - 1; // assume one tile is the bot
    });
  } catch {
    return null;
  }
}

function startPresenceMonitor(
  label: string,
  page: Page,
  countOthers: (p: Page) => Promise<number | null>,
  onAlone?: () => void | Promise<void>,
): () => void {
  const windowMs = resolveWindowMs();
  log(`Starting ${label} presence monitor (end when alone for ${windowMs}ms)...`);
  let aloneSince: number | null = null;
  let fired = false;
  let lastLog = 0;

  const interval = setInterval(async () => {
    if (fired) return;
    const others = await countOthers(page);
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
    // others === 0 → only the bot is here.
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
  return startPresenceMonitor("Google Meet", page, countGoogleOthers, onAlone);
}

export function startTeamsPresenceMonitor(page: Page, onAlone?: () => void | Promise<void>): () => void {
  return startPresenceMonitor("Teams", page, countTeamsOthers, onAlone);
}

export function startZoomPresenceMonitor(page: Page, onAlone?: () => void | Promise<void>): () => void {
  return startPresenceMonitor("Zoom", page, countZoomOthers, onAlone);
}
