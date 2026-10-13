from __future__ import annotations

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import time
from typing import Any


class AcceptanceObserver:
    def __init__(self, path: Path, room_name: str) -> None:
        self.path = path
        self.room_name = room_name
        self._assistant_speech_started_at: float | None = None
        self._assistant_speech_id: str | None = None
        self._user_input_item_id: str | None = None
        self._interruption_observed = False

    @classmethod
    def from_env(cls, room_name: str) -> "AcceptanceObserver | None":
        value = os.getenv("VOICE_AGENT_EVIDENCE", "").strip()
        if not value:
            return None
        observer = cls(Path(value), room_name)
        observer._record_producer_identity()
        return observer

    def _record_producer_identity(self) -> None:
        source_sha = os.getenv("VOICE_AGENT_SOURCE_SHA", "").strip()
        command = os.getenv("VOICE_AGENT_PRODUCER_COMMAND", "").strip()
        def record(document: dict[str, Any]) -> None:
            if source_sha:
                document["sourceSha"] = source_sha
            if command:
                document["producerCommand"] = command
        self._update(record)

    @contextmanager
    def _locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        with lock_path.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _update(self, mutate) -> None:
        with self._locked():
            try:
                document = json.loads(self.path.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                document = {"sessions": {}}
            mutate(document)
            staged = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
            staged.write_text(json.dumps(document, sort_keys=True) + "\n")
            os.chmod(staged, 0o600)
            staged.replace(self.path)

    def attach(self, session: Any) -> None:
        @session.on("user_input_transcribed")
        def on_stt(event: Any) -> None:
            if event.is_final and event.transcript.strip():
                self._user_input_item_id = event.item_id
                observation = {
                    "text": event.transcript.strip(),
                    "at": event.created_at,
                    "itemId": event.item_id,
                }
                self._room_set("finalStt", observation)
                self._room_append("finalSttEvents", observation)

        @session.on("conversation_item_added")
        def on_item(event: Any) -> None:
            item = event.item
            if getattr(item, "role", None) != "assistant":
                return
            text = getattr(item, "text_content", None)
            if isinstance(text, str) and text.strip():
                response = {"text": text.strip(), "at": event.created_at, "itemId": item.id}
                self._room_set("assistantResponse", response)
                self._room_append("assistantResponseEvents", response)
                if self._interruption_observed:
                    self._room_merge("interruption", {
                        "responseEventAt": event.created_at,
                        "responseText": text.strip(),
                        "responseItemId": item.id,
                    })
                    self._interruption_observed = False

        @session.on("speech_created")
        def on_speech_created(event: Any) -> None:
            self._assistant_speech_id = event.speech_handle.id

        @session.on("agent_state_changed")
        def on_agent_state(event: Any) -> None:
            if event.new_state == "speaking":
                self._assistant_speech_started_at = event.created_at
            if event.old_state == "speaking" and event.new_state != "speaking" and self._interruption_observed:
                self._room_merge("interruption", {"assistantSpeechStoppedAt": event.created_at})

        @session.on("overlapping_speech")
        def on_interruption(event: Any) -> None:
            if not event.is_interruption:
                return
            self._interruption_observed = True
            self._room_set("interruption", {
                "assistantSpeechStartedAt": self._assistant_speech_started_at,
                "assistantSpeechId": self._assistant_speech_id,
                "overlappingSpeechItemId": self._user_input_item_id,
                "overlappingSpeechAt": event.overlap_started_at,
                "sdkEvent": event.type,
                "sdkEventAt": event.created_at,
            })

    def record_tts(self, sample_rate: int, audio_frames: int) -> None:
        observation = {
            "sourceSampleRate": sample_rate,
            "sourceWavFrames": audio_frames,
            "at": time.time(),
        }
        self._room_set("tts", observation)
        self._room_append("ttsEvents", observation)

    def _room_set(self, key: str, value: Any) -> None:
        self._room_update(lambda room: room.__setitem__(key, value))

    def _room_merge(self, key: str, value: dict[str, Any]) -> None:
        def merge(room: dict[str, Any]) -> None:
            room.setdefault(key, {}).update(value)
        self._room_update(merge)

    def _room_append(self, key: str, value: Any) -> None:
        self._room_update(lambda room: room.setdefault(key, []).append(value))

    def _room_update(self, mutate) -> None:
        def update(document: dict[str, Any]) -> None:
            sessions = document.setdefault("sessions", {})
            room = sessions.setdefault(self.room_name, {})
            mutate(room)
        self._update(update)
