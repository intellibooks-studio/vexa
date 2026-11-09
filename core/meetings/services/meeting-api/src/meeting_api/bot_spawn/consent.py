"""local patch (IntelliBooks fork, consent line) — the one chat line a bot posts after admission.

``POST /bots`` takes an optional ``consent_message`` (plain text, one line, ≤ 300 chars). When the
request omits it, the deployment default ``BOT_CONSENT_MESSAGE`` applies; neither set ⇒ nothing is
posted (upstream behaviour). An explicit empty string opts a single bot out of the default. The
resolved text rides invocation.v1 ``consentMessage``; the bot reports the outcome on its terminal
lifecycle event (``consent_message: {status, detail?}``), which lands in ``meeting.data``.
"""
from __future__ import annotations

import os
from typing import Any, Optional

#: Mirrors invocation.v1 ``consentMessage.maxLength`` (the schema is the bound; this names it).
CONSENT_MESSAGE_MAX_LEN = 300

#: Outcomes after which a CONTINUED meeting (``continue_meeting``) must not post the line again.
_ALREADY_POSTED = frozenset({"posted", "already_posted"})


class InvalidConsentMessage(ValueError):
    """The request's ``consent_message`` is not one line of plain text within the limit — 422."""


class ConsentMessageMisconfigured(Exception):
    """``BOT_CONSENT_MESSAGE`` is set but invalid — a deployment misconfiguration, HTTP 503.

    Refused loud, never a bot that silently joins without the notice the operator configured."""


def normalize_consent_message(value: Any, *, field: str = "consent_message") -> Optional[str]:
    """``None`` → ``None`` (not given); ``""``/blank → ``""`` (explicitly none); else the stripped
    text. Raises ``InvalidConsentMessage`` for a non-string, an over-long text, or any control
    character (a line break would split the message — or send it early — in the chat box)."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise InvalidConsentMessage(f"'{field}' must be a string")
    text = value.strip()
    if len(text) > CONSENT_MESSAGE_MAX_LEN:
        raise InvalidConsentMessage(
            f"'{field}' is {len(text)} characters; the maximum is {CONSENT_MESSAGE_MAX_LEN}"
        )
    if any(ch < " " or ch == "\x7f" for ch in text):
        raise InvalidConsentMessage(
            f"'{field}' must be one line of plain text (no line breaks or control characters)"
        )
    return text


def resolve_consent_message(requested: Optional[str]) -> Optional[str]:
    """The line this spawn posts: the request's value wins (``""`` = none), else the
    ``BOT_CONSENT_MESSAGE`` default; ``None`` = post nothing."""
    if requested is not None:
        return requested or None
    raw = os.getenv("BOT_CONSENT_MESSAGE")
    if raw is None or not raw.strip():
        return None
    try:
        return normalize_consent_message(raw, field="BOT_CONSENT_MESSAGE") or None
    except InvalidConsentMessage as e:
        raise ConsentMessageMisconfigured(str(e)) from e


def consent_already_posted(meeting_data: Optional[dict]) -> bool:
    """True when an earlier session of this meeting reported the line as posted."""
    reported = (meeting_data or {}).get("consent_message")
    return isinstance(reported, dict) and reported.get("status") in _ALREADY_POSTED
