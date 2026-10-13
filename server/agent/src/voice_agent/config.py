from dataclasses import dataclass
import os
from pathlib import Path


@dataclass(frozen=True)
class Config:
    stt_url: str
    stt_model: str
    stt_api_key: str
    tts_url: str
    tts_profile_dir: Path
    llm_base_url: str
    llm_model: str
    llm_api_key: str

    @classmethod
    def from_env(cls) -> "Config":
        required = (
            "LIVEKIT_URL",
            "LIVEKIT_API_KEY",
            "LIVEKIT_API_SECRET",
            "STT_URL",
            "OMNIVOICE_SYNTH_URL",
        )
        missing = [name for name in required if not os.environ.get(name, "").strip()]
        if missing:
            raise ValueError(f"Missing required environment: {', '.join(missing)}")
        return cls(
            stt_url=os.environ["STT_URL"].rstrip("/"),
            stt_model=os.getenv("STT_MODEL", "whisper-1"),
            stt_api_key=os.getenv("STT_API_KEY", ""),
            tts_url=os.environ["OMNIVOICE_SYNTH_URL"],
            tts_profile_dir=Path(os.getenv("TTS_PROFILE_DIR", "/var/lib/rtech-voice/voices/skippy")),
            llm_base_url=os.getenv("LLM_BASE_URL", "http://127.0.0.1:8080/v1").rstrip("/"),
            llm_model=os.getenv("LLM_MODEL", "qwen3-4b-instruct"),
            llm_api_key=os.getenv("LLM_API_KEY", ""),
        )

    def load_voice_profile(self) -> tuple[bytes, str]:
        audio_path = self.tts_profile_dir / "ref.wav"
        text_path = self.tts_profile_dir / "ref.txt"
        if not audio_path.is_file() or not text_path.is_file():
            raise ValueError("TTS profile requires ref.wav and ref.txt")
        audio, transcript = audio_path.read_bytes(), text_path.read_text().strip()
        if not audio.startswith(b"RIFF") or not transcript:
            raise ValueError("TTS profile is malformed")
        return audio, transcript
