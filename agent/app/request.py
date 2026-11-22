"""Validate the request the API sends.

Only the API can invoke the runtime (IAM), so the payload is trusted to come from our code. It is still validated, because
`user_id` and `project_id` become the retrieval filter that keeps one user's documents away from another, and an unexpected shape
must fail loudly instead of searching with a half-empty filter.

Payload: {"user_id", "project_id", "chat_id", "text", "history": [{"role","text"}], "strategy": "basic" | "multi_query"}
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

STRATEGIES = ("basic", "multi_query")
MAX_TEXT_CHARS = 4000
MAX_HISTORY_ITEMS = 20
MAX_HISTORY_CHARS = 8000
_ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}")


class RequestError(ValueError):
    """The payload is not what the API contract says."""


@dataclass(frozen=True)
class ChatRequest:
    user_id: str
    project_id: str
    chat_id: str
    text: str
    history: tuple[dict[str, str], ...]
    strategy: str


def _identifier(payload: dict[str, Any], name: str) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise RequestError(f"'{name}' is missing or malformed.")
    return value


def normalize_history(raw: Any) -> tuple[dict[str, str], ...]:
    """Keep well-formed messages, starting with a user message and alternating roles, as the model API requires.

    The API sends the most recent messages, so the first one can be an assistant message when the window cuts a pair in half.
    """
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise RequestError("'history' must be a list.")
    cleaned: list[dict[str, str]] = []
    for item in raw[-MAX_HISTORY_ITEMS:]:
        if not isinstance(item, dict) or item.get("role") not in ("user", "assistant"):
            continue
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        role = item["role"]
        expected = "user" if not cleaned or cleaned[-1]["role"] == "assistant" else "assistant"
        if role != expected:
            continue
        cleaned.append({"role": role, "text": text[:MAX_HISTORY_CHARS]})
    if cleaned and cleaned[-1]["role"] == "user":
        cleaned.pop()  # a dangling question: the new question follows it directly, and two user turns in a row are invalid
    return tuple(cleaned)


def parse_request(payload: Any) -> ChatRequest:
    if not isinstance(payload, dict):
        raise RequestError("The request must be a JSON object.")
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise RequestError("'text' is required.")
    if len(text) > MAX_TEXT_CHARS:
        raise RequestError("'text' is too long.")
    strategy = payload.get("strategy", "basic")
    if strategy not in STRATEGIES:
        raise RequestError("'strategy' must be 'basic' or 'multi_query'.")
    return ChatRequest(
        user_id=_identifier(payload, "user_id"),
        project_id=_identifier(payload, "project_id"),
        chat_id=_identifier(payload, "chat_id"),
        text=text.strip(),
        history=normalize_history(payload.get("history")),
        strategy=strategy,
    )
