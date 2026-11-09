// local patch (IntelliBooks fork, consent line): post one message in the MS Teams meeting chat.
import type { Page } from "playwright";
import { sendMeetingChatMessage, type ChatSendOptions, type ChatSendResult } from "../shared/chat-send";
import {
  teamsChatButtonSelectors,
  teamsChatInputSelectors,
  teamsChatSendButtonSelectors,
  teamsChatDisabledIndicators,
} from "./selectors";

export function sendTeamsChatMessage(page: Page, text: string, opts?: ChatSendOptions): Promise<ChatSendResult> {
  return sendMeetingChatMessage(page, {
    toggleButtonSelectors: teamsChatButtonSelectors,
    inputSelectors: teamsChatInputSelectors,
    sendButtonSelectors: teamsChatSendButtonSelectors,
    disabledIndicators: teamsChatDisabledIndicators,
  }, text, opts);
}
