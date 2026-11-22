"""Call the AgentCore Runtime agent and normalise its reply into events.

The agent is a separate deployable (the agent stage). This module defines the contract the API relies on, so either side can
change independently as long as it holds:

    request payload (JSON)
        {"user_id", "project_id", "chat_id", "text", "history": [{"role","text"}...], "strategy": "basic" | "multi_query"}
    response, either
        application/json     {"answer": "...", "citations": [{"source": "s3://...", "snippet": "...", "score": 0.5}]}
        text/event-stream    data: {"type":"token","text":"..."}   (repeated)
                             data: {"type":"citations","citations":[...]}

`runtimeSessionId` is the chat id, so every message of a chat reaches the same warm runtime session (AgentCore requires
an id of at least 33 characters, and a UUID has 36).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from .sse import parse_events

log = logging.getLogger(__name__)


class AgentError(Exception):
    """The agent call failed or returned something unusable."""


class AgentClient:
    def __init__(self, client: Any, runtime_arn: str) -> None:
        self._client = client
        self._arn = runtime_arn

    def stream(self, payload: dict, session_id: str) -> Iterator[dict]:
        """Yield `token` and `citations` events."""
        try:
            response = self._client.invoke_agent_runtime(
                agentRuntimeArn=self._arn,
                runtimeSessionId=session_id,
                contentType="application/json",
                payload=json.dumps(payload).encode("utf-8"),
            )
        except (ClientError, BotoCoreError) as exc:
            raise AgentError(f"InvokeAgentRuntime failed: {exc}") from exc

        body = response["response"]
        content_type = str(response.get("contentType", ""))
        try:
            if "text/event-stream" in content_type:
                for event in parse_events(body.iter_lines()):
                    # The AgentCore SDK reports a failure inside a stream as {"error": ...}; the agent itself sends type "error".
                    # Either way the answer is incomplete and must not be saved.
                    if event.get("type") == "error" or "error" in event:
                        raise AgentError("The agent reported an error while streaming.")
                    if event.get("type") in ("token", "citations"):
                        yield event
                return
            document = json.loads(body.read())
        except (BotoCoreError, ValueError) as exc:
            raise AgentError(f"Unreadable agent response: {exc}") from exc
        finally:
            close = getattr(body, "close", None)
            if close:
                close()

        if not isinstance(document, dict) or not isinstance(document.get("answer"), str):
            raise AgentError("The agent response has no 'answer'.")
        yield {"type": "token", "text": document["answer"]}
        yield {"type": "citations", "citations": document.get("citations") or []}
