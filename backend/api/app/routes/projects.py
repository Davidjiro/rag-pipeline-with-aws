"""Projects: a named collection of documents and chats, owned by one user."""

from __future__ import annotations

from fastapi import APIRouter, Response

from .. import schemas, services
from ..deps import KbDep, ProjectDep, S3Dep, SettingsDep, StoreDep, UserDep
from ..keys import project_s3_prefix

router = APIRouter(prefix="/projects", tags=["projects"])


@router.post("", status_code=201)
def create_project(body: schemas.ProjectCreate, user_id: UserDep, store: StoreDep) -> dict:
    return schemas.project_out(store.create_project(user_id, body.name))


@router.get("")
def list_projects(user_id: UserDep, store: StoreDep) -> list[dict]:
    return [schemas.project_out(p) for p in store.list_projects(user_id)]


@router.get("/{project_id}")
def get_project(project: ProjectDep) -> dict:
    return schemas.project_out(project)


@router.delete("/{project_id}", status_code=204)
def delete_project(
    project: ProjectDep, user_id: UserDep, store: StoreDep, kb: KbDep, s3: S3Dep, settings: SettingsDep
) -> Response:
    """Delete a project and everything in it.

    Order matters. The index entries go first and a failure there stops the request (502, nothing else deleted), so the user can
    retry and no vectors outlive their source. Then the files, then the database records, and the project item last, so a
    partial failure leaves a project that can still be deleted again.
    """
    project_id = project["project_id"]
    docs = store.list_documents(project_id)
    services.remove_from_index(settings, kb, docs)
    services.delete_s3_prefix(s3, settings.docs_bucket, project_s3_prefix(settings.docs_prefix, project_id))
    store.delete_project_records(project_id)
    store.delete_project_item(user_id, project_id)
    return Response(status_code=204)
