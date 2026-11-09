"""local patch (IntelliBooks fork, consent line) — POST /bots ``consent_message`` → invocation.v1
``consentMessage``, the ``BOT_CONSENT_MESSAGE`` default, once-per-meeting on continue, and the bot's
reported outcome persisted from the terminal lifecycle.v1 event. OFFLINE (fakes, TestClient).
"""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from meeting_api.bot_spawn import build_router, request_bot
from meeting_api.bot_spawn.consent import (
    InvalidConsentMessage,
    consent_already_posted,
    normalize_consent_message,
)
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo
from meeting_api.lifecycle import MeetingStore
from meeting_api.lifecycle.receiver import conforms, create_app

SECRET = "test-admin-token"
HEADERS = {"x-user-id": "7"}
LINE = "This meeting is being recorded and transcribed by Notetaker."


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("ADMIN_TOKEN", SECRET)
    monkeypatch.delenv("BOT_CONSENT_MESSAGE", raising=False)


def _post(body: dict, runtime=None, repo=None):
    app = FastAPI()
    runtime = runtime or FakeRuntimeClient()
    app.include_router(build_router(repo or InMemoryMeetingRepo(), runtime))
    r = TestClient(app).post("/bots", headers=HEADERS, json={"platform": "google_meet", **body})
    inv = json.loads(runtime.specs[0]["env"]["VEXA_BOT_CONFIG"]) if runtime.specs else None
    return r, inv


def test_normalize_rules():
    assert normalize_consent_message(None) is None
    assert normalize_consent_message("   ") == ""
    assert normalize_consent_message(f"  {LINE}  ") == LINE
    for bad in (42, "x" * 301, "two\nlines", "tab\there"):
        with pytest.raises(InvalidConsentMessage):
            normalize_consent_message(bad)


def test_request_line_rides_the_invocation():
    r, inv = _post({"native_meeting_id": "abc-defg-hij", "consent_message": LINE})
    assert r.status_code == 201, r.text
    assert inv["consentMessage"] == LINE


def test_no_line_anywhere_is_upstream_behaviour():
    r, inv = _post({"native_meeting_id": "abc-defg-hij"})
    assert r.status_code == 201, r.text
    assert "consentMessage" not in inv


def test_invalid_request_line_is_422_and_spawns_nothing():
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    r, inv = _post({"native_meeting_id": "abc-defg-hij", "consent_message": "a\nb"}, runtime, repo)
    assert r.status_code == 422, r.text
    assert inv is None and not repo._meetings


def test_env_default_applies_and_empty_request_opts_out(monkeypatch):
    monkeypatch.setenv("BOT_CONSENT_MESSAGE", LINE)
    _, inv = _post({"native_meeting_id": "abc-defg-hij"})
    assert inv["consentMessage"] == LINE
    _, inv = _post({"native_meeting_id": "abc-defg-hij", "consent_message": ""})
    assert "consentMessage" not in inv
    _, inv = _post({"native_meeting_id": "abc-defg-hij", "consent_message": "Own words."})
    assert inv["consentMessage"] == "Own words."


def test_invalid_env_default_is_503_not_a_silent_skip(monkeypatch):
    monkeypatch.setenv("BOT_CONSENT_MESSAGE", "x" * 301)
    repo = InMemoryMeetingRepo()
    r, inv = _post({"native_meeting_id": "abc-defg-hij"}, repo=repo)
    assert r.status_code == 503, r.text
    assert inv is None and not repo._meetings


async def test_continued_meeting_does_not_post_twice():
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    kw = dict(user_id=7, platform="google_meet", native_meeting_id="cont-consent",
              redis_url="redis://redis:6379/0", token_secret=SECRET, consent_message=LINE)
    first = await request_bot(repo, runtime, **kw)
    assert json.loads(runtime.specs[0]["env"]["VEXA_BOT_CONFIG"])["consentMessage"] == LINE
    repo._meetings[first["id"]]["data"]["consent_message"] = {"status": "posted"}
    repo.set_status(first["id"], "completed")
    await request_bot(repo, runtime, continue_meeting=True, **kw)
    assert "consentMessage" not in json.loads(runtime.specs[1]["env"]["VEXA_BOT_CONFIG"])


def test_already_posted_reads_only_success_statuses():
    assert consent_already_posted({"consent_message": {"status": "posted"}})
    assert consent_already_posted({"consent_message": {"status": "already_posted"}})
    assert not consent_already_posted({"consent_message": {"status": "chat_unavailable"}})
    assert not consent_already_posted({})
    assert not consent_already_posted(None)


def test_terminal_event_outcome_is_persisted():
    terminal = {
        "connection_id": "sess-uid", "status": "completed", "exit_code": 0,
        "completion_reason": "stopped",
        "consent_message": {"status": "chat_unavailable", "detail": "chat turned off for participants"},
    }
    conforms(terminal, "LifecycleEvent")  # additive field — still a conforming lifecycle.v1 event
    client = TestClient(create_app(store=MeetingStore(), on_status_change=lambda e: None))
    for ev in ({"connection_id": "sess-uid", "status": "joining"},
               {"connection_id": "sess-uid", "status": "active"}, terminal):
        r = client.post("/bots/internal/callback/lifecycle", json=ev)
        assert r.status_code == 200, r.text
    assert r.json()["data"]["consent_message"] == terminal["consent_message"]
