"""Operations that combine several stores: status reconciliation and cascading deletes."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from . import store as st
from .config import Settings
from .kb import KnowledgeBase, map_status
from .store import Store

log = logging.getLogger(__name__)

STALE_INGEST_SECONDS = 30 * 60


def doc_uri(settings: Settings, doc: dict) -> str:
    return f"s3://{settings.docs_bucket}/{doc_key(settings, doc)}"


def doc_key(settings: Settings, doc: dict) -> str:
    return f"{settings.docs_prefix}{doc['project_id']}/{doc['doc_id']}/{doc['filename']}"


def reconcile_documents(settings: Settings, store: Store, kb: KnowledgeBase, docs: list[dict]) -> list[dict]:
    """Bring the status of INGESTING documents up to date from the Knowledge Base, and return the (updated) documents.

    Ingestion is asynchronous and nothing pushes the result to us, so the file list asks. Only INGESTING documents are looked up
    (usually none), in batches of 10. A document still INGESTING after 30 minutes is marked FAILED so the user is never left
    waiting forever. If the Knowledge Base cannot be reached the stored status is shown as is.
    """
    pending = [d for d in docs if d["status"] == st.INGESTING]
    if not pending:
        return docs
    uris = {doc_uri(settings, d): d for d in pending}
    try:
        reported = kb.statuses(list(uris))
    except Exception:
        log.exception("Could not read document statuses; showing stored statuses")
        return docs

    now = st.now()
    for uri, doc in uris.items():
        age = (now - datetime.fromisoformat(doc["updated_at"])).total_seconds()
        status, warning = map_status(reported.get(uri, "NOT_FOUND"), age_seconds=age)
        if status == st.INGESTING and age > STALE_INGEST_SECONDS:
            status = st.FAILED
        if status != st.INGESTING and store.set_document_status(doc, status, expected=st.INGESTING, warning=warning):
            doc["status"] = status
            if warning:
                doc["warning"] = warning
    return docs


def delete_s3_prefix(s3_client: Any, bucket: str, prefix: str) -> None:
    """Delete every object under a prefix (a project's folder)."""
    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        objects = [{"Key": o["Key"]} for o in page.get("Contents", [])]
        if objects:
            s3_client.delete_objects(Bucket=bucket, Delete={"Objects": objects, "Quiet": True})


def remove_from_index(settings: Settings, kb: KnowledgeBase, docs: list[dict]) -> None:
    """Remove documents that were sent to the index. Raises KnowledgeBaseError on failure, before anything else is deleted."""
    sent = [doc_uri(settings, d) for d in docs if d["status"] != st.PENDING_UPLOAD]
    if sent:
        kb.delete_documents(sent)
