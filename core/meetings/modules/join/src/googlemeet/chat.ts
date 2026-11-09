// local patch (IntelliBooks fork, consent line): post one message in the Google Meet chat.
import type { Page } from "playwright";
import { sendMeetingChatMessage, type ChatSendOptions, type ChatSendResult } from "../shared/chat-send";
import {
  googleChatButtonSelectors,
  googleChatInputSelectors,
  googleChatSendButtonSelectors,
  googleChatDisabledIndicators,
} from "./selectors";

export function sendGoogleMeetChatMessage(page: Page, text: string, opts?: ChatSendOptions): Promise<ChatSendResult> {
  return sendMeetingChatMessage(page, {
    toggleButtonSelectors: googleChatButtonSelectors,
    inputSelectors: googleChatInputSelectors,
    sendButtonSelectors: googleChatSendButtonSelectors,
    disabledIndicators: googleChatDisabledIndicators,
  }, text, opts);
}
