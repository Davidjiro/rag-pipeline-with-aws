"""One question, start to finish. Yields the events the API relays to the browser.

    1. guardrail on the user's text            blocked -> a fixed refusal, nothing else runs
    2. the agent answers, using the search tool
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

import asyncio
import logging
import threading
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

from . import prompts
from .config import MAX_SEARCHES_PER_QUESTION
from .guardrail import GuardrailError, InputGuardrail
from .request import ChatRequest
from .retrieval import Evidence, Searcher, SearchError, format_for_model

log = logging.getLogger(__name__)

StreamText = Callable[[Any, tuple, str, Callable[[str], str]], AsyncIterator[str]]


@dataclass
class ChatDeps:
    """Everything the flow needs from the outside world. Tests pass fakes."""

    guardrail: InputGuardrail
    searcher: Searcher
    model: Any
    stream_text: StreamText


def _event(kind: str, **fields: Any) -> dict:
    return {"type": kind, **fields}


async def run(request: ChatRequest, deps: ChatDeps) -> AsyncIterator[dict]:
    try:
        if await asyncio.to_thread(deps.guardrail.blocks, request.text):
            log.info("Question blocked by the guardrail (chat %s)", request.chat_id)
            yield _event("token", text=prompts.BLOCKED_MESSAGE)
            yield _event("citations", citations=[])
            return

        evidence = Evidence()
        lock = threading.Lock()
        searches = 0

        def search(query: str) -> str:
            """Called by the agent as a tool, in a worker thread."""
            nonlocal searches
            with lock:
                searches += 1
                allowed = searches <= MAX_SEARCHES_PER_QUESTION
            if not allowed:
                return prompts.SEARCH_LIMIT_MESSAGE
            numbered = evidence.add(deps.searcher.search(query.strip()[:500], request.strategy))
            return format_for_model(numbered) if numbered else prompts.NO_RESULTS_MESSAGE

        async for chunk in deps.stream_text(deps.model, request.history, request.text, search):
            if evidence.found:
                yield _event("token", text=chunk)

        if not evidence.found:
            yield _event("token", text=prompts.NO_EVIDENCE_MESSAGE)
            yield _event("citations", citations=[])
            return
        yield _event("citations", citations=evidence.citations())
    except (SearchError, GuardrailError):
        log.exception("Dependency failure (chat %s)", request.chat_id)
        yield _event("error", message=prompts.GENERIC_ERROR)
    except Exception:
        log.exception("Unexpected failure (chat %s)", request.chat_id)
        yield _event("error", message=prompts.GENERIC_ERROR)
