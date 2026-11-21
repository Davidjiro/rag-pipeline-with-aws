"""Test retrieval: show which passages the Knowledge Base returns for a query, without calling the model.

Useful to check that uploaded documents are indexed and to see raw relevance scores. Uses the basic strategy only. It costs one
Retrieve call and no model tokens, so it is not counted against the daily question cap.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import citations, schemas
from ..deps import KbDep, ProjectDep, S3Dep, SettingsDep, UserDep

router = APIRouter(prefix="/projects/{project_id}/retrieve", tags=["retrieve"])


@router.post("")
def test_retrieval(
    body: schemas.RetrieveRequest, project: ProjectDep, user_id: UserDep, kb: KbDep, s3: S3Dep, settings: SettingsDep
) -> list[dict]:
    if len(body.query) > settings.max_question_chars:
        raise HTTPException(status_code=422, detail=f"The query is limited to {settings.max_question_chars} characters.")
    results = kb.retrieve(body.query, project["project_id"], user_id, settings.top_k)
    out = []
    for result in results:
        kept = citations.sanitize([{**result, "snippet": result["text"]}], settings, project["project_id"])
        if kept:
            out.append(citations.with_links(kept, s3, settings.docs_bucket)[0])
    return out
