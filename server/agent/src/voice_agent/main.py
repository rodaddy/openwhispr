from livekit.agents import Agent, AgentServer, AgentSession, JobContext, cli
from livekit.plugins import openai, silero

from .config import Config
from .tts import OmniVoiceTTS
from .evidence import AcceptanceObserver

server = AgentServer(host="127.0.0.1", port=8091)


def validate_startup() -> Config:
    config = Config.from_env()
    config.load_voice_profile()
    return config


def own_tts(ctx: JobContext, engine: OmniVoiceTTS) -> OmniVoiceTTS:
    ctx.add_shutdown_callback(engine.aclose)
    return engine


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    config = Config.from_env()
    observer = AcceptanceObserver.from_env(ctx.room.name)
    engine = OmniVoiceTTS(config, on_audio=observer.record_tts if observer else None)
    stt_base = config.stt_url.removesuffix("/audio/transcriptions")
    session = AgentSession(
        stt=openai.STT(base_url=stt_base, model=config.stt_model, api_key=config.stt_api_key or "none"),
        llm=openai.LLM(base_url=config.llm_base_url, model=config.llm_model, api_key=config.llm_api_key or "none"),
        tts=own_tts(ctx, engine),
        vad=silero.VAD.load(),
    )
    if observer:
        observer.attach(session)
    await session.start(
        agent=Agent(instructions="You are Skippy, Rico's concise and capable voice assistant."),
        room=ctx.room,
    )


if __name__ == "__main__":
    validate_startup()
    cli.run_app(server)
