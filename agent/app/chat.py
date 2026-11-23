"""One question, start to finish. Yields the events the API relays to the browser.

    1. guardrail on the user's text            blocked -> a fixed refusal, nothing else runs
    2. the model answers, using the search tool (runner.py)
    3. citations, built in code from what the search tool actually returned

RULES ENFORCED IN CODE (the prompt asks for them too, but code does not drift):
    - NO EVIDENCE, NO ANSWER: text is relayed only after a search returned passages. If none did, the answer is a fixed message,
      so the model cannot answer from general knowledge. Text it writes before searching ("Let me look...") is dropped.
    - CITATIONS ARE DATA: they come from the search results, not from what the model writes.
      The model only refers to them by number in its text.
    - BOUNDED WORK: at most 3 searches per question.
    - NO LEAKS: errors become a generic event, details go to the log. Questions and document text are never logged.

Events: {"type":"token","text":...}, {"type":"citations","citations":[...]}, {"type":"error","message":...}
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

from . import prompts
from .config import MAX_SEARCHES_PER_QUESTION
from .request import ChatRequest
from .retrieval import Evidence, format_for_model

log = logging.getLogger(__name__)

# (history, question, search function) -> answer text, streamed
Answer = Callable[[tuple, str, Callable[[str], str]], Iterator[str]]


@dataclass
class ChatDeps:
    """Everything the flow needs from the outside world. Tests pass fakes."""

    guardrail: Any  # .blocks(text) -> bool
    searcher: Any  # .search(query, strategy) -> list[Passage]
    answer: Answer


def _event(kind: str, **fields: Any) -> dict:
    return {"type": kind, **fields}


def run(request: ChatRequest, deps: ChatDeps) -> Iterator[dict]:
    try:
        if deps.guardrail.blocks(request.text):
            log.info("Question blocked by the guardrail (chat %s)", request.chat_id)
            yield _event("token", text=prompts.BLOCKED_MESSAGE)
            yield _event("citations", citations=[])
            return

        evidence = Evidence()
        lock = threading.Lock()
        searches = 0

        def search(query: str) -> str:
            """Called by the agent loop when the model requests the tool."""
            nonlocal searches
            with lock:
                searches += 1
                allowed = searches <= MAX_SEARCHES_PER_QUESTION
            if not allowed:
                return prompts.SEARCH_LIMIT_MESSAGE
            numbered = evidence.add(deps.searcher.search(query.strip()[:500], request.strategy))
            return format_for_model(numbered) if numbered else prompts.NO_RESULTS_MESSAGE

        written: list[str] = []
        for chunk in deps.answer(request.history, request.text, search):
            if evidence.found:
                written.append(chunk)
                yield _event("token", text=chunk)

        if not evidence.found:
            yield _event("token", text=prompts.NO_EVIDENCE_MESSAGE)
            yield _event("citations", citations=[])
            return
        yield _event("citations", citations=evidence.citations("".join(written)))
    except Exception:
        log.exception("Answer failed (chat %s)", request.chat_id)
        yield _event("error", message=prompts.GENERIC_ERROR)
