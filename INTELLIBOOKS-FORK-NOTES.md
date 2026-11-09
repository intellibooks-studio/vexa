# Why this fork exists

This is IntelliBooks' production fork of [Vexa](https://github.com/Vexa-ai/vexa)
(Apache-2.0). It powers the **IntelliBooks Notetaker** — the meeting bot behind
the Meetings feature in IntelliBooks Studio (send a bot to a Meet/Teams/Zoom
call, get a live speaker-attributed transcript, summaries, and a persona-agent
debrief).

We forked instead of tracking upstream directly because production testing
(2026-08-29, staging, real multi-speaker meetings) surfaced defects and capacity
gaps that we fixed locally and cannot afford to lose on a fresh install:

## Patches carried ahead of upstream

1. **Google Meet "End call for everyone" detection**
   (`core/meetings/modules/join/src/googlemeet/selectors.ts`)
   Upstream's removal indicators match "Meeting ended" / "Call ended", but
   today's Meet shows *"Your host ended the meeting (for everyone)"* — reversed
   word order, no match — so the bot sat in silence until the alone-timer
   (~5 min) instead of completing on the event. Added the missing markers;
   validated live twice (`completion_reason: evicted`, instant).

2. **STT client timeout + retry hardening**
   (`core/meetings/modules/whisper/src/transcription-client.ts`)
   Upstream defaults: 30s per-request timeout, 3 retries × 1s base — under CPU
   contention every chunk aborted (~15s of persistence) and the audio was
   silently lost, mid-meeting AND during the teardown flush. Now 90s timeout /
   6 retries × 2s base (~2 min persistence), both env-tunable
   (`WHISPER_REQUEST_TIMEOUT_MS`, `WHISPER_MAX_RETRIES`, `WHISPER_RETRY_DELAY_MS`).

3. **CPU transcription: 3-worker scale-out + queue mode**
   (`deploy/transcription/docker-compose.cpu.yml`, `nginx.conf`)
   One worker serialized all speaker streams (a 3-person meeting froze the
   transcript). Ships 3 workers behind the nginx LB and env-wires the service's
   queue knobs (`FAIL_FAST_WHEN_BUSY=false`, `MAX_ACTIVE_REQUESTS=1`,
   `MAX_QUEUE_SIZE=60`): chunks now WAIT in line instead of being shed with
   503 — for meeting notes, completeness beats latency.

## Operational notes (not in this repo)

- Installs are driven by `scripts/server/setup-vexa.sh` in the IntelliBooksStudio
  repo: clones this fork, templates the `.env`s, builds the patched bot image
  (`make bot` → `vexa/vexa-bot:dev`, wired via `BROWSER_IMAGE`), starts the
  stack + CPU transcription unit, and installs a systemd socat unit exposing
  the loopback-only gateway on the LAN IP for k8s pods.
- Capacity (measured): `base` model on 12 vCPU handles 3 concurrent speaker
  streams; `small` fits 1–2; `medium`+ needs a GPU. The gateway API key is
  minted per-install (`make all`).

## Rebasing on upstream

Fetch upstream, rebase `main`; the three patch areas are small and isolated.
If upstream fixes the Meet end-screen wording or makes the client knobs
configurable, drop the corresponding patch.

5. **Google Meet presence-based aloneness** (core/meetings/modules/join/src/googlemeet/presence.ts + bot orchestrator/join-driver/ports wiring)
   Vexa only leaves on 10-min AUDIO SILENCE. Added a PRESENCE monitor: ends the
   meeting when the bot is the only participant tile for BOT_ALONE_PRESENCE_WINDOW_MS
   (default 30s). A muted/silent human still counts as company (keeps waiting).
   Fail-safe: unknown/unreadable count => stay, never leave. Google Meet only for now.

6. **Consent line in the meeting chat** (Google Meet + Teams; Zoom later)
   Why: people in the call must be told they are being recorded and transcribed. Upstream
   declares an acts.v1 `chat_send` but never handles it and has no chat sender at all.
   - Request: `POST /bots` takes an optional `consent_message` (one line of plain text,
     <= 300 chars, no line breaks/control chars; else 422). Omitted => the deployment default
     `BOT_CONSENT_MESSAGE` (meeting-api env, compose); `""` opts one bot out of the default;
     neither set => no message (upstream behaviour). An invalid `BOT_CONSENT_MESSAGE` refuses
     spawns with 503 (never a bot silently joining without the configured notice).
     (`meeting_api/bot_spawn/consent.py`, `router.py`, `service.py`, `invocation.py`,
     `config.v1.json`; accepted off the open api.v1 body like `continue_meeting`.)
   - Contract: invocation.v1 gains optional `consentMessage` (string, maxLength 300);
     back-compatible add, `contracts.seal.json` re-sealed (hash over the LF bytes).
   - Bot: after admission, once capture/recording are up, posts the line ONCE (fire-and-forget,
     3 s settle, 45 s cap) — `services/bot/src/consent.ts`, wired in `index.ts` only when a line is
     configured. Sender: `modules/join/src/shared/chat-send.ts` (open panel if closed, type, send,
     verify, close the panel again if we opened it; never throws, never leaves) with per-platform
     selectors in `googlemeet/selectors.ts` / `msteams/selectors.ts` (`*Chat*Selectors`,
     `*ChatDisabledIndicators`) and wrappers `googlemeet/chat.ts`, `msteams/chat.ts`;
     `sendMeetingChat(page, platform, text)` exported from `@vexa/join`.
   - Once per meeting: one attempt per bot process (no in-process rejoin); the sender skips if the
     identical line is already visible in the chat; on `continue_meeting` meeting-api drops the
     line when an earlier session reported `posted`/`already_posted`.
   - Outcome: logged (`[bot] consent message: <status> (<detail>)`) and carried on the terminal
     lifecycle.v1 event as `consent_message: {status, detail?}` (additive, like `stt_fault`),
     persisted to `meeting.data.consent_message` (`lifecycle/machine.py`). Statuses: `posted`,
     `already_posted`, `sent_unverified`, `chat_unavailable` (no button/box, or chat turned off by
     host/tenant), `failed`, `not_attempted` (bot ended before posting).
   - Selectors are best-effort for the 2025–26 web UIs and MUST be verified live (see the
     comments next to them); a miss degrades to `chat_unavailable`, never a crash.

7. **Speech-to-text cadence knobs reach Teams too** (`services/bot/src/pipeline.ts`)
   Why: cost. Every active speaker stream re-sends its growing unconfirmed window to STT on a
   timer (LocalAgreement-2). Upstream ALREADY exposes the knobs as env, forwarded to spawned bots
   by the runtime profile (compose/helm/lite): `BOT_SPEAKER_SUBMIT_INTERVAL_SEC` (default 2),
   `BOT_SPEAKER_MIN_AUDIO_SEC` (2), `BOT_SPEAKER_MAX_BUFFER_SEC` (30) (+ `_CONFIRM_THRESHOLD`,
   `_IDLE_TIMEOUT_SEC`) — but only the Google Meet lane read them. We did NOT add new
   `TRANSCRIBE_*_MS` names (one home per knob); the patch passes the same tuning to the Teams
   CSRC lane's shared buffer and, when the interval is raised, stretches that lane's draft-persist
   timeout to max(4 s, 2 x interval) so drafts are not promoted before a confirmation could arrive.
   Unset => Teams options are byte-identical to upstream.
   Trade-off (rough model, continuous speech, Whisper segments ~5 s): each submission sends about
   2 x interval + ~3.5 s of audio, so audio-seconds sent per second of speech ~= (2I + 3.5) / I:
   - default I = 2 s: ~7.5 s per call, ~3.5–4x the speech, 30 STT calls/min per active speaker;
     live lines update every ~2 s, confirmed text lags ~4–6 s.
   - I = 8 s: ~19.5 s per call, ~2.4x the speech, 7.5 calls/min per speaker (~4x fewer calls,
     ~35–40% less billed audio); live lines update every ~8 s, confirmed text lags ~16–20 s.
   - Floor ~2x: LocalAgreement-2 needs every word heard in two consecutive windows. Providers that
     bill a per-request minimum (some bill >= 10 s per call — check yours) make the call count
     matter more: at I = 2 s each ~7.5 s window bills as 10 s (~5x).
   Keep `BOT_SPEAKER_MAX_BUFFER_SEC` >= ~2.5 x the interval (I = 12 s needs ~45 s), or the hard cap
   force-flushes unconfirmed text. Set them on the runtime service (compose `.env`).
   Found, parked: the `WHISPER_*` client knobs from patch 2 are NOT in the runtime profile's
   forwarded env (`runtime_kernel/profiles.py` bot_tuning_env), so a spawned bot only ever sees
   their in-code defaults (90 s / 6 / 2 s) unless baked into the image.

## 8. The STT client's timeout and retries reach spawned bots

Patch 2 made `WHISPER_REQUEST_TIMEOUT_MS`, `WHISPER_MAX_RETRIES` and `WHISPER_RETRY_DELAY_MS`
tunable, but the runtime's pass-through list for bot containers
(`core/runtime/src/runtime_kernel/profiles.py`, `bot_tuning_env`) didn't include them, so bots
only ever used the in-code defaults. They're now passed like the `BOT_SPEAKER_*` settings (only
when set).
