"""The Strands agent: one model, one read-only tool, streaming text.

This is the only module that imports Strands, so the rest of the agent is plain Python and testable without a model.

WHAT THE MODEL CAN DO: call `search_documents(query)` and write text. The tool is read-only and the project and user it searches
are fixed in code (retrieval.py), so even a successful prompt injection can only change the wording of an answer.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable

from strands import Agent, tool

from .prompts import SYSTEM_PROMPT, TOOL_DESCRIPTION


def build_search_tool(search: Callable[[str], str]):
    """Wrap the per-request search function as a Strands tool."""

    @tool(name="search_documents", description=TOOL_DESCRIPTION)
    def search_documents(query: str) -> str:
        return search(query)

    return search_documents


def to_strands_messages(history: tuple[dict[str, str], ...]) -> list[dict]:
    return [{"role": m["role"], "content": [{"text": m["text"]}]} for m in history]


async def stream_text(
    model,
    history: tuple[dict[str, str], ...],
    question: str,
    search: Callable[[str], str],
) -> AsyncIterator[str]:
    """Run the agent for one question and yield the text it writes, as it is generated.

    A new Agent is created for every question and given the history the API supplies, so nothing is kept in memory between
    questions or between users.
    """
    agent = Agent(
        model=model,
        system_prompt=SYSTEM_PROMPT,
        tools=[build_search_tool(search)],
        messages=to_strands_messages(history),
        callback_handler=None,  # no printing to stdout
    )
    async for event in agent.stream_async(question):
        chunk = event.get("data") if isinstance(event, dict) else None
        if isinstance(chunk, str) and chunk:
            yield chunk
