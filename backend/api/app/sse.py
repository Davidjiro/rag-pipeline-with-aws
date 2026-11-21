"""Server-Sent Events helpers: format events for the browser and parse events from the agent.

Events sent to the browser are `data: <json>` lines with a `type`:
    token      {"type":"token","text":"..."}               a piece of the answer
    citations  {"type":"citations","citations":[...]}      sources of the answer, with short-lived download links
    done       {"type":"done","message_id":"..."}          the answer is complete and saved
    error      {"type":"error","message":"..."}            the answer failed; nothing was saved

A line starting with `:` is an SSE comment. The first byte of every answer is such a comment, so the response starts flowing
immediately and no proxy times out while the model is thinking.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator

KEEP_ALIVE = ": keep-alive\n\n"


def format_event(event: dict) -> str:
    return f"data: {json.dumps(event, separators=(',', ':'))}\n\n"


def parse_events(lines: Iterable[bytes | str]) -> Iterator[dict]:
    """Yield the JSON objects of `data:` lines. Comments, blank lines and malformed JSON are skipped."""
    for raw in lines:
        line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
        line = line.strip()
        if not line.startswith("data:"):
            continue
        body = line[5:].strip()
        if not body or body == "[DONE]":
            continue
        try:
            event = json.loads(body)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            yield event
