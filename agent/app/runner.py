"""The agent loop: the model, one read-only tool, streamed text. Plain boto3 over the Bedrock Converse API, no framework.

    loop (at most MAX_MODEL_TURNS model calls):
        ConverseStream(system prompt, messages, tool = search_documents)
            text deltas      -> yielded to the caller as they arrive
            a tool request   -> run search_documents, append the result, call the model again
        stop reason is not "tool_use" -> done

WHAT THE MODEL CAN DO: request `search_documents(query)` and write text. The tool is read-only, and the project and user it
searches are fixed in code (retrieval.py), so even a successful prompt injection can only change the wording of an answer.

Writing the loop by hand keeps every event visible: what reaches the user, when the tool runs, and how errors surface.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError, EventStreamError

from .config import MAX_SEARCHES_PER_QUESTION
from .prompts import SYSTEM_PROMPT, TOOL_DESCRIPTION

log = logging.getLogger(__name__)

TOOL_NAME = "search_documents"
# Every allowed search plus one turn to write the answer, plus one spare for a model that asks once more after the limit.
MAX_MODEL_TURNS = MAX_SEARCHES_PER_QUESTION + 2

TOOL_SPEC = {
    "toolSpec": {
        "name": TOOL_NAME,
        "description": TOOL_DESCRIPTION,
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "A self-contained search phrase."}},
                "required": ["query"],
            }
        },
    }
}


class ModelError(Exception):
    """The model call failed or its stream broke."""


class ThinkingFilter:
    """Remove `<thinking>...</thinking>` spans from streamed text, even when a tag is split across chunks.

    Some Nova models write their reasoning in these tags when they use tools. It is not part of the answer.
    """

    OPEN, CLOSE = "<thinking>", "</thinking>"

    def __init__(self) -> None:
        self._buffer = ""
        self._inside = False

    @staticmethod
    def _partial_suffix(text: str, tag: str) -> int:
        """Length of the longest end of `text` that could be the start of `tag`."""
        for size in range(min(len(text), len(tag) - 1), 0, -1):
            if tag.startswith(text[-size:]):
                return size
        return 0

    def feed(self, chunk: str) -> str:
        self._buffer += chunk
        out: list[str] = []
        while True:
            if self._inside:
                end = self._buffer.find(self.CLOSE)
                if end == -1:
                    keep = self._partial_suffix(self._buffer, self.CLOSE)
                    self._buffer = self._buffer[len(self._buffer) - keep :]
                    return "".join(out)
                self._buffer = self._buffer[end + len(self.CLOSE) :]
                self._inside = False
            else:
                start = self._buffer.find(self.OPEN)
                if start == -1:
                    keep = self._partial_suffix(self._buffer, self.OPEN)
                    out.append(self._buffer[: len(self._buffer) - keep])
                    self._buffer = self._buffer[len(self._buffer) - keep :]
                    return "".join(out)
                out.append(self._buffer[:start])
                self._buffer = self._buffer[start + len(self.OPEN) :]
                self._inside = True

    def flush(self) -> str:
        rest, self._buffer = ("" if self._inside else self._buffer), ""
        return rest


def to_converse_messages(history: tuple[dict[str, str], ...], question: str) -> list[dict]:
    messages = [{"role": m["role"], "content": [{"text": m["text"]}]} for m in history]
    messages.append({"role": "user", "content": [{"text": question}]})
    return messages


def _run_tool(name: str, raw_input: str, search: Callable[[str], str]) -> tuple[dict, str]:
    """Parse the model's tool request and run it. Returns (parsed input, result text)."""
    try:
        arguments = json.loads(raw_input or "{}")
    except json.JSONDecodeError:
        arguments = {}
    if not isinstance(arguments, dict):
        arguments = {}
    query = arguments.get("query")
    if name != TOOL_NAME or not isinstance(query, str) or not query.strip():
        return arguments, "Invalid tool request: call search_documents with a non-empty 'query'."
    return arguments, search(query)


def stream_answer(
    client: Any,
    model_id: str,
    max_tokens: int,
    history: tuple[dict[str, str], ...],
    question: str,
    search: Callable[[str], str],
) -> Iterator[str]:
    """Run the loop for one question and yield the answer text as it is generated.

    The conversation is rebuilt from the history the API sends, so nothing is kept between questions or between users.
    A failing search raises (SearchError) instead of being shown to the model: the answer is then an error, never a guess.
    """
    messages = to_converse_messages(history, question)
    for _ in range(MAX_MODEL_TURNS):
        try:
            response = client.converse_stream(
                modelId=model_id,
                system=[{"text": SYSTEM_PROMPT}],
                messages=messages,
                toolConfig={"tools": [TOOL_SPEC]},
                # Temperature 0: AWS recommends greedy decoding for reliable tool use with Nova.
                inferenceConfig={"maxTokens": max_tokens, "temperature": 0},
            )
        except (ClientError, BotoCoreError) as exc:
            raise ModelError(f"ConverseStream failed: {exc}") from exc

        text: list[str] = []
        tools: list[dict] = []
        current: dict | None = None
        stop_reason = None
        thinking = ThinkingFilter()
        try:
            for event in response["stream"]:
                if "contentBlockStart" in event:
                    start = event["contentBlockStart"].get("start", {})
                    if "toolUse" in start:
                        current = {"toolUseId": start["toolUse"]["toolUseId"], "name": start["toolUse"]["name"], "input": ""}
                elif "contentBlockDelta" in event:
                    delta = event["contentBlockDelta"].get("delta", {})
                    if "text" in delta:
                        text.append(delta["text"])
                        visible = thinking.feed(delta["text"])
                        if visible:
                            yield visible
                    elif "toolUse" in delta and current is not None:
                        current["input"] += delta["toolUse"].get("input", "")
                elif "contentBlockStop" in event:
                    if current is not None:
                        tools.append(current)
                        current = None
                elif "messageStop" in event:
                    stop_reason = event["messageStop"].get("stopReason")
                elif any(key.endswith("Exception") for key in event):
                    raise ModelError(f"Model stream error: {next(iter(event))}")
        except (ClientError, BotoCoreError, EventStreamError) as exc:
            raise ModelError(f"Model stream broke: {exc}") from exc
        rest = thinking.flush()
        if rest:
            yield rest

        if stop_reason != "tool_use" or not tools:
            if stop_reason not in ("end_turn", "stop_sequence", None):
                log.info("Model stopped with reason %s", stop_reason)
            return

        assistant: list[dict] = []
        spoken = "".join(text)
        if spoken.strip():
            assistant.append({"text": spoken})
        results: list[dict] = []
        for request in tools:
            arguments, result = _run_tool(request["name"], request["input"], search)
            assistant.append({"toolUse": {"toolUseId": request["toolUseId"], "name": request["name"], "input": arguments}})
            results.append({"toolResult": {"toolUseId": request["toolUseId"], "content": [{"text": result}]}})
        messages.append({"role": "assistant", "content": assistant})
        messages.append({"role": "user", "content": results})
    log.warning("Model turn limit reached without a final answer")
