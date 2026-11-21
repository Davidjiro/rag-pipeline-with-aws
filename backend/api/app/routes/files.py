"""Documents of a project: request an upload, list with live status, delete.

Upload flow: the browser asks for an upload here, receives a presigned POST, and sends the file straight to S3 (it never passes
through Lambda). S3 then triggers the ingest function, which starts indexing.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, Response

from .. import keys, schemas, services
from ..deps import KbDep, ProjectDep, S3Dep, SettingsDep, StoreDep, UserDep

router = APIRouter(prefix="/projects/{project_id}/files", tags=["files"])

UPLOAD_SECONDS = 600


@router.post("", status_code=201)
def request_upload(
    body: schemas.FileCreate, project: ProjectDep, user_id: UserDep, store: StoreDep, s3: S3Dep, settings: SettingsDep
) -> dict:
    """Create the document record and return a presigned POST for it.

    The POST policy fixes the object key, the content type and a size range of 1 byte to the configured maximum, so S3 itself
    rejects anything else. The client cannot choose the key.
    """
    try:
        filename = keys.sanitize_filename(body.filename)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    extension = keys.extension_of(filename)
    if extension not in settings.allowed_extensions or extension not in keys.CONTENT_TYPES:
        allowed = ", ".join(settings.allowed_extensions)
        raise HTTPException(status_code=422, detail=f"File type .{extension} is not supported. Allowed: {allowed}.")

    project_id = project["project_id"]
    if len(store.list_documents(project_id)) >= settings.max_documents_per_project:
        raise HTTPException(status_code=409, detail=f"A project holds at most {settings.max_documents_per_project} documents.")

    content_type = keys.CONTENT_TYPES[extension]
    doc = store.create_document(user_id, project_id, filename, content_type)
    key = services.doc_key(settings, doc)
    upload = s3.generate_presigned_post(
        Bucket=settings.docs_bucket,
        Key=key,
        Fields={"Content-Type": content_type},
        Conditions=[{"Content-Type": content_type}, ["content-length-range", 1, settings.max_file_bytes]],
        ExpiresIn=UPLOAD_SECONDS,
    )
    return {**schemas.document_out(doc), "upload": upload, "max_bytes": settings.max_file_bytes}


@router.get("")
def list_files(project: ProjectDep, store: StoreDep, kb: KbDep, settings: SettingsDep) -> list[dict]:
    docs = store.list_documents(project["project_id"])
    docs = services.reconcile_documents(settings, store, kb, docs)
    return [schemas.document_out(d) for d in docs]


@router.delete("/{doc_id}", status_code=204)
def delete_file(doc_id: UUID, project: ProjectDep, store: StoreDep, kb: KbDep, s3: S3Dep, settings: SettingsDep) -> Response:
    doc = store.get_document(project["project_id"], str(doc_id))
    if doc is None:
        raise HTTPException(status_code=404, detail="File not found.")
    services.remove_from_index(settings, kb, [doc])
    s3.delete_object(Bucket=settings.docs_bucket, Key=services.doc_key(settings, doc))
    store.delete_document(project["project_id"], doc["doc_id"])
    return Response(status_code=204)
