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
