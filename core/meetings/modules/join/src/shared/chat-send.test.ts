/**
 * local patch (IntelliBooks fork, consent line) — sendMeetingChatMessage
 * against a fabricated chat panel (no browser, no live meeting), in the same
 * mock-Page style as msteams/modals.test.ts. Proves the control flow: open the
 * panel if closed, refuse cleanly when chat is unavailable/off, never post a
 * duplicate, detect a send that did not go through, close the panel again only
 * if we opened it, and never throw.
 *
 * Run: npx tsx src/shared/chat-send.test.ts
 */
import { sendMeetingChatMessage, type MeetingChatUi } from './chat-send';
import {
  googleChatButtonSelectors, googleChatInputSelectors,
  googleChatSendButtonSelectors, googleChatDisabledIndicators,
} from '../googlemeet/selectors';

const UI: MeetingChatUi = {
  toggleButtonSelectors: googleChatButtonSelectors,
  inputSelectors: googleChatInputSelectors,
  sendButtonSelectors: googleChatSendButtonSelectors,
  disabledIndicators: googleChatDisabledIndicators,
};
const TEXT = 'This meeting is being recorded and transcribed by Notetaker.';

interface Room {
  panelOpen: boolean;
  hasChatButton: boolean;
  chatOff: boolean;
  sendWorks: boolean;
  fillThrows: boolean;
  messages: string[];
  compose: string;
  toggleClicks: number;
  sends: number;
}

function room(over: Partial<Room> = {}): Room {
  return {
    panelOpen: false, hasChatButton: true, chatOff: false, sendWorks: true, fillThrows: false,
    messages: [], compose: '', toggleClicks: 0, sends: 0, ...over,
  };
}

function mockPage(r: Room): any {
  const el = (sel: string) => {
    const isToggle = sel === UI.toggleButtonSelectors[0];
    const isInput = sel === UI.inputSelectors[0];
    const isSend = sel === UI.sendButtonSelectors[0];
    const isOff = sel === UI.disabledIndicators[0];
    return {
      isVisible: async () =>
        (isToggle && r.hasChatButton) || ((isInput || isSend) && r.panelOpen) || (isOff && r.panelOpen && r.chatOff),
      getAttribute: async (name: string) => (isInput && name === 'aria-disabled' && r.chatOff ? 'true' : null),
      isEnabled: async () => true,
      click: async () => {
        if (isToggle) { r.toggleClicks++; r.panelOpen = !r.panelOpen; }
        if (isSend) {
          r.sends++;
          if (r.sendWorks) { r.messages.push(r.compose); r.compose = ''; }
        }
      },
      fill: async (v: string) => { if (r.fillThrows) throw new Error('element detached'); r.compose = v; },
      inputValue: async () => r.compose,
      innerText: async () => '',
      press: async () => {},
    };
  };
  return {
    locator: (sel: string) => ({ first: () => el(sel) }),
    getByText: (text: string) => ({
      first: () => ({ isVisible: async () => r.panelOpen && r.messages.includes(text) }),
    }),
    keyboard: { type: async (v: string) => { r.compose = v; } },
  };
}

let passed = 0, failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name} (expected ${String(expected)}, got ${String(actual)})`); failed++; }
}
const FAST = { panelTimeoutMs: 0, verifyTimeoutMs: 0 };

(async () => {
  console.log('\n=== meeting chat: post one message (consent line) ===');

  let r = room();
  let res = await sendMeetingChatMessage(mockPage(r), UI, TEXT, FAST);
  check('closed panel → posted', res.outcome, 'posted');
  check('closed panel → message sent once', r.messages.filter((m) => m === TEXT).length, 1);
  check('closed panel → panel closed again (opened + closed)', r.toggleClicks === 2 && !r.panelOpen, true);

  r = room({ panelOpen: true });
  res = await sendMeetingChatMessage(mockPage(r), UI, TEXT, FAST);
  check('open panel → posted', res.outcome, 'posted');
  check('open panel → left open (we did not open it)', r.toggleClicks === 0 && r.panelOpen, true);

  r = room({ hasChatButton: false });
  res = await sendMeetingChatMessage(mockPage(r), UI, TEXT, FAST);
  check('no chat button → chat_unavailable', res.outcome, 'chat_unavailable');
  check('no chat button → nothing sent', r.sends, 0);

  r = room({ chatOff: true });
  res = await sendMeetingChatMessage(mockPage(r), UI, TEXT, FAST);
  check('chat turned off by host → chat_unavailable', res.outcome, 'chat_unavailable');
  check('chat turned off by host → nothing sent, panel closed again', r.sends === 0 && !r.panelOpen, true);

  r = room({ messages: [TEXT] });
  res = await sendMeetingChatMessage(mockPage(r), UI, TEXT, FAST);
  check('identical line already in chat → already_posted', res.outcome, 'already_posted');
  check('identical line already in chat → no second send', r.sends, 0);

  r = room({ sendWorks: false });
  res = await sendMeetingChatMessage(mockPage(r), UI, TEXT, FAST);
  check('send did not clear the box → failed', res.outcome, 'failed');

  r = room({ fillThrows: true });
  res = await sendMeetingChatMessage(mockPage(r), UI, TEXT, FAST);
  check('a throw inside → failed (never throws out)', res.outcome, 'failed');
  check('a throw inside → panel still closed again', r.panelOpen, false);

  res = await sendMeetingChatMessage(mockPage(room()), UI, '   ', FAST);
  check('empty text → failed, nothing attempted', res.outcome, 'failed');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
