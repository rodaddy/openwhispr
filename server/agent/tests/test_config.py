from pathlib import Path

import pytest

from voice_agent.config import Config


def make_config(profile: Path) -> Config:
    return Config("http://stt", "whisper", "", "http://tts", profile, "http://llm/v1", "qwen", "")


def test_profile_requires_matching_wav_and_transcript(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    with pytest.raises(ValueError, match="ref.wav and ref.txt"):
        config.load_voice_profile()
    (tmp_path / "ref.wav").write_bytes(b"RIFFvoice")
    (tmp_path / "ref.txt").write_text("  exact words  ")
    assert config.load_voice_profile() == (b"RIFFvoice", "exact words")


def test_malformed_profile_fails_closed(tmp_path: Path) -> None:
    (tmp_path / "ref.wav").write_bytes(b"not-wave")
    (tmp_path / "ref.txt").write_text("words")
    with pytest.raises(ValueError, match="malformed"):
        make_config(tmp_path).load_voice_profile()


def test_environment_requires_livekit_and_upstream_endpoints(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "LIVEKIT_URL",
        "LIVEKIT_API_KEY",
        "LIVEKIT_API_SECRET",
        "STT_URL",
        "OMNIVOICE_SYNTH_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValueError, match="LIVEKIT_URL.*LIVEKIT_API_KEY.*LIVEKIT_API_SECRET.*STT_URL"):
        Config.from_env()
