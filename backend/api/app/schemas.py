"""Request bodies and the shapes returned to the browser.

Responses are built by explicit functions, never by returning DynamoDB items directly, so internal attributes (keys, owner ids,
TTL) never leave the API.
"""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Strategy = Literal["basic", "multi_query"]


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ProjectCreate(_Body):
    name: str = Field(min_length=1, max_length=80)


class FileCreate(_Body):
    filename: str = Field(min_length=1, max_length=255)


class ChatCreate(_Body):
    title: str | None = Field(default=None, max_length=80)
    strategy: Strategy = "basic"


class MessageCreate(_Body):
    # The upper bound is MAX_QUESTION_CHARS, checked in the route because it is configuration.
    text: str = Field(min_length=1)


class RetrieveRequest(_Body):
    query: str = Field(min_length=1)


def project_out(item: dict) -> dict:
    return {"project_id": item["project_id"], "name": item["name"], "created_at": item["created_at"]}


def document_out(item: dict) -> dict:
    out = {
        "doc_id": item["doc_id"],
        "filename": item["filename"],
        "status": item["status"],
        "created_at": item["created_at"],
    }
    if item.get("warning"):
        out["warning"] = item["warning"]
    if item.get("failure_reason"):
        out["reason"] = item["failure_reason"]
    return out


def chat_out(item: dict) -> dict:
    return {
        "chat_id": item["chat_id"],
        "title": item["title"],
        "strategy": item["strategy"],
        "created_at": item["created_at"],
    }


def stored_citations(item: dict) -> list[dict]:
    return json.loads(item.get("citations_json") or "[]")
