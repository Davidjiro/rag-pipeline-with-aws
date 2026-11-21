"""FastAPI dependencies: the objects routes use, and the ownership checks.

Routes never build AWS clients themselves. They ask for `Store`, `KnowledgeBase`, `AgentClient`, `Settings` here, which lets the
tests substitute fakes through `app.dependency_overrides`.

`owned_project` is the tenancy gate. Every route below /projects/{project_id} depends on it, so no route can forget the check.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import Depends, HTTPException

from . import clients
from .agent import AgentClient
from .auth import current_user
from .config import Settings, get_settings
from .kb import KnowledgeBase
from .store import Store

SettingsDep = Annotated[Settings, Depends(get_settings)]
UserDep = Annotated[str, Depends(current_user)]


def get_store() -> Store:
    return Store(clients.dynamodb_table())


def get_kb(settings: SettingsDep) -> KnowledgeBase:
    return KnowledgeBase(
        clients.bedrock_agent(), clients.bedrock_agent_runtime(), settings.knowledge_base_id, settings.data_source_id
    )


def get_agent(settings: SettingsDep) -> AgentClient:
    return AgentClient(clients.agentcore(), settings.agent_runtime_arn)


def get_s3():
    return clients.s3()


StoreDep = Annotated[Store, Depends(get_store)]
KbDep = Annotated[KnowledgeBase, Depends(get_kb)]
AgentDep = Annotated[AgentClient, Depends(get_agent)]
S3Dep = Annotated[Any, Depends(get_s3)]


def owned_project(project_id: UUID, user_id: UserDep, store: StoreDep) -> dict:
    """The project, if it exists AND belongs to the caller. Otherwise 404, the same answer for both cases."""
    project = store.get_project(user_id, str(project_id))
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return project


ProjectDep = Annotated[dict, Depends(owned_project)]
