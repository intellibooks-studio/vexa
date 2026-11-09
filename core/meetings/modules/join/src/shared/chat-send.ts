// local patch (IntelliBooks fork, consent line) — post ONE message in the
// meeting's chat panel: open the panel if it is closed, type, send, verify,
// and close the panel again if we opened it.
//
// Never throws and never leaves the meeting: every failure is a typed outcome
// the embedder reports (posted / chat unavailable / …). Platform knowledge is
// ONLY the selector lists each platform's selectors.ts exports; this routine is
// shared so Meet and Teams can never drift apart in how they send.
import type { Page, Locator } from "playwright";
import { log } from "../_host";

export interface MeetingChatUi {
  /** opens/closes the chat side panel (the same button toggles it) */
  toggleButtonSelectors: string[];
  /** the compose box — a <textarea> (Meet) or a contenteditable (Teams) */
  inputSelectors: string[];
  sendButtonSelectors: string[];
  /** visible text that means the host/tenant turned chat off for us */
  disabledIndicators: string[];
}

export type ChatSendOutcome =
  | "posted"            // sent, and the message is visible in the panel
  | "already_posted"    // the identical text is already in the chat (e.g. an earlier session)
  | "sent_unverified"   // sent, but the message was not seen in the panel afterwards
  | "chat_unavailable"  // no chat button / panel / box, or chat turned off
  | "failed";           // something threw or the send did not go through

export interface ChatSendResult {
  outcome: ChatSendOutcome;
  detail?: string;
}

export interface ChatSendOptions {
  /** how long to wait for the compose box after opening the panel (default 8 s) */
  panelTimeoutMs?: number;
  /** how long to wait for the sent message to appear (default 6 s) */
  verifyTimeoutMs?: number;
}

const POLL_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** First selector (in list order) with a visible match, polling up to `timeoutMs`. */
async function firstVisible(page: Page, selectors: string[], timeoutMs = 0): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

async function anyVisible(page: Page, selectors: string[]): Promise<boolean> {
  return (await firstVisible(page, selectors)) !== null;
}

/** Disabled via the `disabled` property, aria-disabled, or contenteditable="false". */
async function isUsable(loc: Locator): Promise<boolean> {
  const aria = await loc.getAttribute("aria-disabled").catch(() => null);
  if (aria === "true") return false;
  const editable = await loc.getAttribute("contenteditable").catch(() => null);
  if (editable === "false") return false;
  return await loc.isEnabled().catch(() => true);
}

/** What the compose box currently holds (textarea value or contenteditable text). */
async function composeText(loc: Locator): Promise<string> {
  const value = await loc.inputValue().catch(() => null);
  if (value !== null) return value.trim();
  return ((await loc.innerText().catch(() => "")) || "").trim();
}

async function messageVisible(page: Page, text: string): Promise<boolean> {
  return await page.getByText(text, { exact: true }).first().isVisible().catch(() => false);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

export async function sendMeetingChatMessage(
  page: Page,
  ui: MeetingChatUi,
  text: string,
  opts: ChatSendOptions = {},
): Promise<ChatSendResult> {
  const message = (text || "").trim();
  if (!message) return { outcome: "failed", detail: "empty message" };
  const panelTimeoutMs = opts.panelTimeoutMs ?? 8000;
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? 6000;

  let toggle: Locator | null = null;
  let openedPanel = false;
  try {
    let input = await firstVisible(page, ui.inputSelectors);
    if (!input) {
      toggle = await firstVisible(page, ui.toggleButtonSelectors);
      if (!toggle) return { outcome: "chat_unavailable", detail: "chat button not found" };
      if (!(await isUsable(toggle))) return { outcome: "chat_unavailable", detail: "chat button disabled" };
      await toggle.click({ timeout: 5000 });
      openedPanel = true;
      input = await firstVisible(page, ui.inputSelectors, panelTimeoutMs);
    }
    if (await anyVisible(page, ui.disabledIndicators)) {
      return { outcome: "chat_unavailable", detail: "chat turned off for participants" };
    }
    if (!input) return { outcome: "chat_unavailable", detail: "message box not found" };
    if (!(await isUsable(input))) return { outcome: "chat_unavailable", detail: "message box disabled" };

    // Once per meeting: an identical line already in the chat (an earlier bot session of this
    // meeting, where the platform keeps chat history) is not posted again.
    if (await messageVisible(page, message)) return { outcome: "already_posted" };

    await input.click({ timeout: 3000 }).catch(() => { /* fill focuses anyway */ });
    await input.fill(message, { timeout: 5000 });
    if (!(await composeText(input)).includes(message)) {
      // A rich editor that ignored fill(): type it instead.
      await input.click({ timeout: 3000 }).catch(() => {});
      await page.keyboard.type(message, { delay: 15 });
    }

    const send = await firstVisible(page, ui.sendButtonSelectors);
    if (send && (await isUsable(send))) await send.click({ timeout: 5000 });
    else await input.press("Enter");

    // The compose box empties when the platform accepted the message. (A contenteditable box
    // still holding the text would also satisfy the visible-text check, so this comes first.)
    const cleared = await waitFor(async () => !(await composeText(input!)).includes(message), verifyTimeoutMs);
    if (!cleared) return { outcome: "failed", detail: "message still in the compose box — send did not go through" };
    const seen = await waitFor(() => messageVisible(page, message), verifyTimeoutMs);
    return seen ? { outcome: "posted" } : { outcome: "sent_unverified", detail: "message not seen in the chat panel" };
  } catch (e: any) {
    return { outcome: "failed", detail: String(e?.message || e).split("\n")[0] };
  } finally {
    if (openedPanel && toggle) {
      await toggle.click({ timeout: 3000 }).catch((e: any) => {
        log(`[chat] could not close the chat panel: ${String(e?.message || e).split("\n")[0]}`);
      });
    }
  }
}
