"""AgentCore Runtime entrypoint.

AgentCore starts this container for a chat session and sends requests to `POST /invocations` (health check: `GET /ping`). The
`BedrockAgentCoreApp` from the AgentCore SDK serves both. The entrypoint is a generator, so every event it yields is sent to the
caller as one Server-Sent Event (`data: <json>`), which the API relays to the browser.
"""

from __future__ import annotations

import logging
from functools import lru_cache, partial

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from botocore.config import Config

from . import chat
from .config import get_settings
from .guardrail import InputGuardrail
from .queries import QueryRewriter
from .request import ChatRequest, RequestError, parse_request
from .retrieval import Searcher
from .runner import stream_answer

logging.getLogger().setLevel(logging.INFO)
log = logging.getLogger(__name__)

_CONFIG = Config(retries={"max_attempts": 3, "mode": "standard"}, read_timeout=90, connect_timeout=10)

app = BedrockAgentCoreApp()


@lru_cache
def _clients(region: str):
    """Created once per container and shared: boto3 clients are thread-safe."""
    session = boto3.Session(region_name=region)
    return session.client("bedrock-runtime", config=_CONFIG), session.client("bedrock-agent-runtime", config=_CONFIG)


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
        answer=partial(stream_answer, runtime, settings.model_id, settings.max_output_tokens),
    )


@app.entrypoint
def invoke(payload):
    try:
        request = parse_request(payload)
    except RequestError as exc:
        yield {"type": "error", "message": str(exc)}
        return
    yield from chat.run(request, build_deps(request))


if __name__ == "__main__":
    app.run()
