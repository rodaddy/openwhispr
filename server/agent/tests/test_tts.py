import asyncio
import base64
from pathlib import Path

import httpx
import pytest
from livekit.agents import tts
from io import BytesIO
import wave

from voice_agent.config import Config
from voice_agent.tts import OmniVoiceTTS


def config(profile: Path) -> Config:
    (profile / "ref.wav").write_bytes(b"RIFFreference")
    (profile / "ref.txt").write_text("Reference words")
    return Config("http://stt", "whisper", "", "http://tts/synthesize", profile, "http://llm/v1", "qwen", "")


def wav_bytes() -> bytes:
    output = BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24_000)
        audio.writeframes(b"\x00\x00" * 240)
    return output.getvalue()


@pytest.mark.asyncio
async def test_tts_posts_profile_and_returns_24k_wav(tmp_path: Path) -> None:
    wav = wav_bytes()
    observed = []
    async def handler(request: httpx.Request) -> httpx.Response:
        body = __import__("json").loads(request.content)
        assert body["text"] == "Hello"
        assert body["prompt_text"] == "Reference words"
        assert base64.b64decode(body["audio_base64"]) == b"RIFFreference"
        return httpx.Response(200, json={"audio_base64": base64.b64encode(wav).decode(), "sample_rate": 24_000})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await OmniVoiceTTS(config(tmp_path), client, lambda rate, frames: observed.append((rate, frames))).synthesize_wav("Hello") == wav
    assert observed == []


@pytest.mark.asyncio
async def test_tts_sdk_stream_decodes_returned_wav(tmp_path: Path) -> None:
    wav = wav_bytes()
    observed = []

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"audio_base64": base64.b64encode(wav).decode(), "sample_rate": 24_000})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        audio = await OmniVoiceTTS(
            config(tmp_path), client, lambda rate, frames: observed.append((rate, frames))
        ).synthesize("Hello").collect()

    assert audio.sample_rate == 24_000
    assert audio.num_channels == 1
    assert audio.samples_per_channel == 240
    assert observed == [(24_000, 240)]


@pytest.mark.asyncio
async def test_tts_does_not_record_source_wav_when_sdk_push_fails(tmp_path: Path, monkeypatch) -> None:
    wav = wav_bytes()
    observed = []

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"audio_base64": base64.b64encode(wav).decode(), "sample_rate": 24_000})

    def reject_push(_emitter, _wav: bytes) -> None:
        raise RuntimeError("SDK push rejected")

    monkeypatch.setattr(tts.AudioEmitter, "push", reject_push)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        stream = OmniVoiceTTS(
            config(tmp_path), client, lambda rate, frames: observed.append((rate, frames))
        ).synthesize("Hello")
        with pytest.raises(RuntimeError, match="SDK push rejected"):
            await stream.collect()

    assert observed == []


@pytest.mark.asyncio
async def test_tts_rejects_invalid_audio_and_honors_task_cancellation(tmp_path: Path) -> None:
    gate = asyncio.Event()
    async def handler(_request: httpx.Request) -> httpx.Response:
        await gate.wait()
        return httpx.Response(200, json={"audio_base64": "YmFk", "sample_rate": 24_000})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        task = asyncio.create_task(OmniVoiceTTS(config(tmp_path), client).synthesize_wav("Hello"))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
