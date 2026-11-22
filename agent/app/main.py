"""AgentCore Runtime entrypoint.

AgentCore starts this container for a chat session and sends requests to `POST /invocations` (health check: `GET /ping`). The
`BedrockAgentCoreApp` from the AgentCore SDK serves both. The entrypoint is an async generator, so every event it yields is sent
to the caller as one Server-Sent Event (`data: <json>`), which the API relays to the browser.
"""

from __future__ import annotations

import logging
from functools import lru_cache

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from botocore.config import Config
from strands.models import BedrockModel

from . import chat
from .config import Settings, get_settings
from .guardrail import InputGuardrail
from .queries import QueryRewriter
from .request import ChatRequest, RequestError, parse_request
from .retrieval import Searcher
from .runner import stream_text

logging.getLogger().setLevel(logging.INFO)
log = logging.getLogger(__name__)

_RETRY = Config(retries={"max_attempts": 3, "mode": "standard"}, read_timeout=90, connect_timeout=10)

app = BedrockAgentCoreApp()


@lru_cache
def _clients(region: str):
    session = boto3.Session(region_name=region)
    return (
        session.client("bedrock-runtime", config=_RETRY),
        session.client("bedrock-agent-runtime", config=_RETRY),
    )


@lru_cache
def _model(settings: Settings) -> BedrockModel:
    """Stateless and safe to share between requests."""
    return BedrockModel(
        model_id=settings.model_id,
        region_name=settings.region,
        max_tokens=settings.max_output_tokens,
        temperature=0.2,
        boto_client_config=_RETRY,
    )


def build_deps(request: ChatRequest) -> chat.ChatDeps:
    settings = get_settings()
    runtime, agent_runtime = _clients(settings.region)
    searcher = Searcher(
        agent_runtime,
        settings,
        project_id=request.project_id,
        owner_id=request.user_id,
        rewrite=QueryRewriter(runtime, settings.model_id),
    )
    return chat.ChatDeps(
        guardrail=InputGuardrail(runtime, settings.guardrail_id, settings.guardrail_version),
        searcher=searcher,
        model=_model(settings),
        stream_text=stream_text,
    )


@app.entrypoint
async def invoke(payload):
    try:
        request = parse_request(payload)
    except RequestError as exc:
        yield {"type": "error", "message": str(exc)}
        return
    async for event in chat.run(request, build_deps(request)):
        yield event


if __name__ == "__main__":
    app.run()
