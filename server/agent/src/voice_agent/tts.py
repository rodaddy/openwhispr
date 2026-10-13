import base64
import uuid
from io import BytesIO
import wave
from collections.abc import Callable

import httpx
from livekit.agents import APIConnectOptions, tts

from .config import Config


class OmniVoiceTTS(tts.TTS):
    def __init__(self, config: Config, client: httpx.AsyncClient | None = None, on_audio: Callable[[int, int], None] | None = None) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=24_000,
            num_channels=1,
        )
        self._config = config
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(30.0))
        self._owns_client = client is None
        self._on_audio = on_audio

    @property
    def model(self) -> str:
        return "omnivoice"

    @property
    def provider(self) -> str:
        return "rtech"

    def synthesize(self, text: str, *, conn_options: APIConnectOptions = APIConnectOptions()) -> tts.ChunkedStream:
        return _OmniVoiceStream(tts=self, input_text=text, conn_options=conn_options)

    async def synthesize_wav(self, text: str) -> bytes:
        reference, prompt = self._config.load_voice_profile()
        response = await self._client.post(
            self._config.tts_url,
            json={"text": text, "audio_base64": base64.b64encode(reference).decode("ascii"), "prompt_text": prompt},
        )
        response.raise_for_status()
        payload = response.json()
        encoded = payload.get("audio_base64")
        if not isinstance(encoded, str) or not encoded:
            raise ValueError("OmniVoice returned no audio")
        wav = base64.b64decode(encoded, validate=True)
        if not wav.startswith(b"RIFF") or payload.get("sample_rate") != 24_000:
            raise ValueError("OmniVoice returned malformed 24 kHz WAV")
        try:
            with wave.open(BytesIO(wav), "rb") as audio:
                if audio.getframerate() != 24_000 or audio.getnchannels() != 1:
                    raise ValueError("OmniVoice returned malformed 24 kHz WAV")
                frames = audio.getnframes()
        except (wave.Error, EOFError) as error:
            raise ValueError("OmniVoice returned malformed 24 kHz WAV") from error
        if frames < 1:
            raise ValueError("OmniVoice returned empty audio")
        return wav

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()


class _OmniVoiceStream(tts.ChunkedStream):
    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        engine: OmniVoiceTTS = self._tts
        wav = await engine.synthesize_wav(self.input_text)
        output_emitter.initialize(
            request_id=str(uuid.uuid4()), sample_rate=24_000, num_channels=1, mime_type="audio/wav"
        )
        output_emitter.push(wav)
        if engine._on_audio:
            with wave.open(BytesIO(wav), "rb") as audio:
                engine._on_audio(audio.getframerate(), audio.getnframes())
