"""Chats of a project and the streaming answer endpoint.

Answer flow (POST .../messages):
    1. validate the question and count it against the user's daily cap (one atomic write)
    2. load the last few messages as context
    3. call the agent, and relay its tokens to the browser as Server-Sent Events
    4. when the answer is complete, save the question and the answer together

A dropped connection or an agent failure saves nothing, so a chat never contains a question without its answer.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse

from .. import citations, schemas
from ..agent import AgentError
from ..deps import AgentDep, ProjectDep, S3Dep, SettingsDep, StoreDep, UserDep
from ..sse import KEEP_ALIVE, format_event

log = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/chats", tags=["chats"])

DEFAULT_TITLE = "New chat"
GENERIC_ERROR = "The answer could not be generated. Please try again."


def _owned_chat(project: dict, chat_id: UUID, store) -> dict:
    chat = store.get_chat(project["project_id"], str(chat_id))
    if chat is None:
        raise HTTPException(status_code=404, detail="Chat not found.")
    return chat


@router.post("", status_code=201)
def create_chat(body: schemas.ChatCreate, project: ProjectDep, user_id: UserDep, store: StoreDep) -> dict:
    chat = store.create_chat(user_id, project["project_id"], body.title or DEFAULT_TITLE, body.strategy)
    return schemas.chat_out(chat)


@router.get("")
def list_chats(project: ProjectDep, store: StoreDep) -> list[dict]:
    return [schemas.chat_out(c) for c in store.list_chats(project["project_id"])]


@router.delete("/{chat_id}", status_code=204)
def delete_chat(chat_id: UUID, project: ProjectDep, store: StoreDep) -> Response:
    chat = _owned_chat(project, chat_id, store)
    store.delete_chat(project["project_id"], chat["chat_id"])
    return Response(status_code=204)


@router.get("/{chat_id}/messages")
def list_messages(chat_id: UUID, project: ProjectDep, store: StoreDep, s3: S3Dep, settings: SettingsDep) -> list[dict]:
    chat = _owned_chat(project, chat_id, store)
    out = []
    for message in store.list_messages(chat["chat_id"]):
        cites = citations.with_links(schemas.stored_citations(message), s3, settings.docs_bucket)
        out.append(
            {
                "message_id": message["message_id"],
                "role": message["role"],
                "text": message["text"],
                "citations": cites,
                "created_at": message["created_at"],
            }
        )
    return out


@router.post("/{chat_id}/messages")
def ask(
    chat_id: UUID,
    body: schemas.MessageCreate,
    project: ProjectDep,
    user_id: UserDep,
    store: StoreDep,
    agent: AgentDep,
    s3: S3Dep,
    settings: SettingsDep,
) -> StreamingResponse:
    chat = _owned_chat(project, chat_id, store)
    if len(body.text) > settings.max_question_chars:
        raise HTTPException(status_code=422, detail=f"A question is limited to {settings.max_question_chars} characters.")
    if not store.consume_question(user_id, settings.daily_question_cap):
        raise HTTPException(
            status_code=429,
            detail=f"Daily limit of {settings.daily_question_cap} questions reached. Try again tomorrow.",
        )

    history = [
        {"role": m["role"], "text": m["text"]} for m in store.list_messages(chat["chat_id"], limit=settings.history_messages)
    ]
    payload = {
        "user_id": user_id,
        "project_id": project["project_id"],
        "chat_id": chat["chat_id"],
        "text": body.text,
        "history": history,
        "strategy": chat["strategy"],
    }

    def events() -> Iterator[str]:
        yield KEEP_ALIVE
        parts: list[str] = []
        cites: list[dict] = []
        try:
            for event in agent.stream(payload, session_id=chat["chat_id"]):
                if event["type"] == "token" and isinstance(event.get("text"), str):
                    parts.append(event["text"])
                    yield format_event({"type": "token", "text": event["text"]})
                elif event["type"] == "citations":
                    cites = citations.sanitize(event.get("citations"), settings, project["project_id"])
            answer = "".join(parts).strip()
            if not answer:
                raise AgentError("The agent returned an empty answer.")
            saved = store.add_exchange(chat["chat_id"], body.text, answer, cites)
            if chat["title"] == DEFAULT_TITLE:
                store.set_chat_title(chat, body.text[:60])
            if cites:
                yield format_event({"type": "citations", "citations": citations.with_links(cites, s3, settings.docs_bucket)})
            yield format_event({"type": "done", "message_id": saved["message_id"]})
        except Exception:
            log.exception("Answer failed for chat %s", chat["chat_id"])
            yield format_event({"type": "error", "message": GENERIC_ERROR})

    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )
