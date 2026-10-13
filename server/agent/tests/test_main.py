import pytest

from voice_agent.main import own_tts, server


def test_agent_health_uses_dedicated_loopback_port() -> None:
    assert server._host == "127.0.0.1"
    assert server._port == 8091


@pytest.mark.asyncio
async def test_room_job_owns_and_closes_omnivoice_client() -> None:
    class Context:
        callback = None

        def add_shutdown_callback(self, callback):
            self.callback = callback

    class Engine:
        closed = False

        async def aclose(self):
            self.closed = True

    context = Context()
    engine = Engine()
    assert own_tts(context, engine) is engine
    assert engine.closed is False
    await context.callback()
    assert engine.closed is True
