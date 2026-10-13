import json

from voice_agent.evidence import AcceptanceObserver


class Session:
    def __init__(self):
        self.handlers = {}

    def on(self, name):
        def register(handler):
            self.handlers[name] = handler
            return handler
        return register


class Event:
    def __init__(self, **values):
        self.__dict__.update(values)


def test_observer_records_raw_room_pipeline_and_interruption_events(tmp_path, monkeypatch) -> None:
    path = tmp_path / "agent.json"
    path.write_text(json.dumps({"auth": {"crossOwnerDenied": True}}))
    monkeypatch.setenv("VOICE_AGENT_EVIDENCE", str(path))
    monkeypatch.setenv("VOICE_AGENT_SOURCE_SHA", "source-sha")
    monkeypatch.setenv("VOICE_AGENT_PRODUCER_COMMAND", "python -m voice_agent.main start")
    observer = AcceptanceObserver.from_env("real-room")
    assert observer is not None
    session = Session()
    observer.attach(session)

    session.handlers["user_input_transcribed"](
        Event(is_final=True, transcript="test prompt", created_at=10.0, item_id="input-1")
    )
    session.handlers["conversation_item_added"](
        Event(item=Event(id="answer-1", role="assistant", text_content="first response"), created_at=11.0)
    )
    observer.record_tts(24_000, 240)
    session.handlers["speech_created"](
        Event(speech_handle=Event(id="speech-1"), created_at=11.5)
    )
    session.handlers["agent_state_changed"](
        Event(old_state="listening", new_state="speaking", created_at=12.0)
    )
    session.handlers["overlapping_speech"](
        Event(type="overlapping_speech", created_at=13.0, overlap_started_at=12.5,
              is_interruption=True)
    )
    session.handlers["agent_state_changed"](
        Event(old_state="speaking", new_state="listening", created_at=14.0)
    )
    session.handlers["conversation_item_added"](
        Event(item=Event(id="answer-2", role="assistant", text_content="new response"), created_at=15.0)
    )

    receipt = json.loads(path.read_text())
    assert receipt["auth"] == {"crossOwnerDenied": True}
    room = receipt["sessions"]["real-room"]
    assert room["finalStt"] == {"text": "test prompt", "at": 10.0, "itemId": "input-1"}
    assert room["finalSttEvents"] == [{"text": "test prompt", "at": 10.0, "itemId": "input-1"}]
    assert room["assistantResponse"] == {"text": "new response", "at": 15.0, "itemId": "answer-2"}
    assert room["assistantResponseEvents"] == [
        {"text": "first response", "at": 11.0, "itemId": "answer-1"},
        {"text": "new response", "at": 15.0, "itemId": "answer-2"},
    ]
    assert room["tts"]["sourceSampleRate"] == 24_000
    assert room["tts"]["sourceWavFrames"] == 240
    assert isinstance(room["tts"]["at"], float)
    assert room["ttsEvents"] == [room["tts"]]
    assert room["interruption"] == {
        "assistantSpeechStartedAt": 12.0,
        "assistantSpeechId": "speech-1",
        "overlappingSpeechItemId": "input-1",
        "overlappingSpeechAt": 12.5,
        "sdkEvent": "overlapping_speech",
        "sdkEventAt": 13.0,
        "assistantSpeechStoppedAt": 14.0,
        "responseEventAt": 15.0,
        "responseText": "new response",
        "responseItemId": "answer-2",
    }
    assert "interrupt" not in receipt
    assert receipt["sourceSha"] == "source-sha"
    assert receipt["producerCommand"] == "python -m voice_agent.main start"

    session.handlers["conversation_item_added"](
        Event(item=Event(id="answer-3", role="assistant", text_content="ordinary response"), created_at=20.0)
    )
    receipt = json.loads(path.read_text())
    assert receipt["sessions"]["real-room"]["interruption"]["responseText"] == "new response"
