#!/usr/bin/env python3
"""Backend-only LiveKit voice smoke; it does not certify browser, SSO, or microphones."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import re
import struct
import time
import uuid
import wave

from livekit import api, rtc


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def http_url(value: str) -> str:
    return value.replace("wss://", "https://", 1).replace("ws://", "http://", 1)


def contains_marker(text: str, marker: str) -> bool:
    normalize = lambda value: re.sub(r"[^a-z0-9]", "", value.casefold())
    return normalize(marker) in normalize(text)


def read_wav(path: Path) -> tuple[int, int, bytes]:
    with wave.open(str(path), "rb") as source:
        if source.getsampwidth() != 2 or source.getnchannels() != 1:
            raise RuntimeError(f"{path.name} must be mono 16-bit PCM WAV")
        return source.getframerate(), source.getnchannels(), source.readframes(source.getnframes())


async def run_room(url: str, key: str, secret: str, room_name: str, marker: str, wav_path: Path) -> dict:
    room = rtc.Room()
    transcripts: list[dict] = []
    assistant_audio = {"frames": 0, "nonSilentSamples": 0}
    audio_tasks: set[asyncio.Task] = set()
    agent_ready = asyncio.Event()
    agent_states: list[dict] = []
    subscribed_tracks: list[dict] = []

    def is_listening(participant) -> bool:
        return (
            not participant.identity.startswith("backend-smoke-")
            and participant.attributes.get("lk.agent.state") == "listening"
        )

    @room.on("participant_connected")
    def on_participant(participant) -> None:
        if not participant.identity.startswith("backend-smoke-"):
            agent_states.append({"state": participant.attributes.get("lk.agent.state"), "at": time.time()})
        if is_listening(participant):
            agent_ready.set()

    @room.on("participant_attributes_changed")
    def on_attributes(_changed, participant) -> None:
        if not participant.identity.startswith("backend-smoke-"):
            agent_states.append({"state": participant.attributes.get("lk.agent.state"), "at": time.time()})
        if is_listening(participant):
            agent_ready.set()

    @room.on("transcription_received")
    def on_transcription(segments, participant, _publication) -> None:
        for segment in segments:
            if segment.final and segment.text.strip():
                transcripts.append({
                    "text": segment.text.strip(),
                    "at": time.time(),
                    "participantIdentity": participant.identity if participant else None,
                    "source": "input-stt" if participant and participant.identity == identity else "assistant",
                })

    @room.on("track_subscribed")
    def on_track(track, _publication, participant) -> None:
        subscribed_tracks.append({"kind": str(track.kind), "participantIdentity": participant.identity, "at": time.time()})
        if track.kind != rtc.TrackKind.KIND_AUDIO or participant.identity.startswith("backend-smoke-"):
            return

        async def collect() -> None:
            async for event in rtc.AudioStream(track):
                data = bytes(event.frame.data)
                samples = struct.unpack(f"<{len(data) // 2}h", data)
                assistant_audio["frames"] += event.frame.samples_per_channel
                assistant_audio["nonSilentSamples"] += sum(abs(sample) > 8 for sample in samples)

        task = asyncio.create_task(collect())
        audio_tasks.add(task)
        task.add_done_callback(audio_tasks.discard)

    identity = f"backend-smoke-{uuid.uuid4().hex}"
    token = (
        api.AccessToken(key, secret)
        .with_identity(identity)
        .with_grants(api.VideoGrants(room_join=True, room=room_name, can_publish=True, can_subscribe=True))
        .to_jwt()
    )
    await room.connect(url, token)
    if any(is_listening(participant) for participant in room.remote_participants.values()):
        agent_ready.set()
    await asyncio.wait_for(agent_ready.wait(), timeout=20)
    sample_rate, channels, pcm = read_wav(wav_path)
    source = rtc.AudioSource(sample_rate, channels)
    track = rtc.LocalAudioTrack.create_audio_track("deterministic-smoke-input", source)
    await room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )
    samples_per_frame = sample_rate // 100
    frame_bytes = samples_per_frame * channels * 2
    started_at = time.time()
    for offset in range(0, len(pcm), frame_bytes):
        chunk = pcm[offset:offset + frame_bytes]
        if len(chunk) < frame_bytes:
            chunk += bytes(frame_bytes - len(chunk))
        await source.capture_frame(rtc.AudioFrame(chunk, sample_rate, channels, samples_per_frame))
    silence = bytes(frame_bytes)
    for _ in range(100):
        await source.capture_frame(rtc.AudioFrame(silence, sample_rate, channels, samples_per_frame))
    await source.wait_for_playout()

    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        input_text = " ".join(item["text"] for item in transcripts if item["source"] == "input-stt")
        assistant_text = " ".join(item["text"] for item in transcripts if item["source"] == "assistant")
        if contains_marker(input_text, marker) and assistant_text and assistant_audio["nonSilentSamples"] > 0:
            break
        await asyncio.sleep(0.25)
    succeeded = contains_marker(input_text, marker) and bool(assistant_text) and assistant_audio["nonSilentSamples"] > 0

    await room.disconnect()
    for task in audio_tasks:
        task.cancel()
    await asyncio.gather(*audio_tasks, return_exceptions=True)
    return {
        "roomName": room_name,
        "inputMarker": marker,
        "inputStartedAt": started_at,
        "input": {
            "sampleRate": sample_rate,
            "spokenPcmFrames": len(pcm) // 2,
            "publishedPcmFrames": len(pcm) // 2 + sample_rate,
            "publishedDurationSeconds": len(pcm) / 2 / sample_rate + 1,
        },
        "agentStates": agent_states,
        "subscribedTracks": subscribed_tracks,
        "transcripts": transcripts,
        "assistantAudio": assistant_audio,
        "status": "passed" if succeeded else "failed",
        "failure": None if succeeded else "marker-bound STT, assistant text, and non-silent audio were not all observed",
    }


async def main() -> None:
    url = required("LIVEKIT_URL")
    key = required("LIVEKIT_API_KEY")
    secret = required("LIVEKIT_API_SECRET")
    receipt_path = Path(required("VOICE_BACKEND_SMOKE_RECEIPT"))
    cases = [
        (required("VOICE_SMOKE_MARKER_A"), Path(required("VOICE_SMOKE_WAV_A"))),
        (required("VOICE_SMOKE_MARKER_B"), Path(required("VOICE_SMOKE_WAV_B"))),
    ]
    run_id = uuid.uuid4().hex
    room_names = [f"backend-smoke-{run_id}-a", f"backend-smoke-{run_id}-b"]
    client = api.LiveKitAPI(http_url(url), key, secret)
    try:
        for name in room_names:
            await client.room.create_room(api.CreateRoomRequest(name=name, empty_timeout=120, max_participants=4))
        results = await asyncio.gather(*[
            run_room(url, key, secret, room_name, marker, wav)
            for room_name, (marker, wav) in zip(room_names, cases, strict=True)
        ])
        for current, other in ((results[0], cases[1][0]), (results[1], cases[0][0])):
            text = " ".join(item["text"] for item in current["transcripts"])
            current["otherRoomMarkerAbsent"] = not contains_marker(text, other)
            if not current["otherRoomMarkerAbsent"]:
                current["status"] = "failed"
                current["failure"] = "cross-room marker appeared in observations"
        receipt_path.parent.mkdir(parents=True, exist_ok=True)
        receipt_path.write_text(json.dumps({
            "kind": "backend-only-livekit-smoke",
            "status": "passed" if all(result["status"] == "passed" for result in results) else "failed",
            "runId": run_id,
            "observedAt": time.time(),
            "rooms": results,
            "limits": ["no browser", "no SSO", "no physical microphone"],
        }, indent=2) + "\n")
        os.chmod(receipt_path, 0o600)
        print(f"backend smoke receipt: {receipt_path}")
        if any(result["status"] != "passed" for result in results):
            raise RuntimeError("backend smoke observations did not satisfy the pipeline assertions")
    finally:
        for name in room_names:
            try:
                await client.room.delete_room(api.DeleteRoomRequest(room=name))
            except Exception as error:
                print(f"cleanup warning for {name}: {type(error).__name__}")
        await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
