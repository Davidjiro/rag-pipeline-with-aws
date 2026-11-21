"""Contracts between the API and the ingest Lambda, which are deployed separately and share a storage layout."""

from __future__ import annotations

import handler
import pytest
from app import keys

PID = "11111111-1111-1111-1111-111111111111"
DID = "22222222-2222-2222-2222-222222222222"


def test_ingest_parses_every_key_the_api_builds():
    for name in ("a.pdf", "My_Report.docx", "x-y_z.1.md"):
        key = keys.s3_key("projects/", PID, DID, name)
        assert handler.parse_key(key) == keys.parse_s3_key("projects/", key) == (PID, DID, name)


def test_docs_prefix_matches():
    assert handler.DOCS_PREFIX == "projects/"


def test_ingest_finds_the_record_the_api_wrote(monkeypatch, aws):
    """The record the API creates is exactly what the ingest Lambda looks up and updates."""
    from app import clients
    from app.store import Store

    class FakeBedrock:
        def __init__(self):
            self.calls = []

        def ingest_knowledge_base_documents(self, **kw):
            self.calls.append(kw)
            return {"documentDetails": [{"status": "STARTING"}]}

    fake = FakeBedrock()
    monkeypatch.setattr(handler, "_bedrock", lambda: fake)
    handler._table.cache_clear()

    store = Store(clients.dynamodb_table())
    project = store.create_project("alice", "P")
    doc = store.create_document("alice", project["project_id"], "report.pdf", "application/pdf")
    key = f"projects/{doc['project_id']}/{doc['doc_id']}/report.pdf"

    outcome = handler.main(
        {"Records": [{"eventName": "ObjectCreated:Post", "s3": {"bucket": {"name": "b"}, "object": {"key": key}}}]}
    )

    assert outcome == {"started": 1}
    assert store.get_document(doc["project_id"], doc["doc_id"])["status"] == "INGESTING"
    assert "ttl" not in store.get_document(doc["project_id"], doc["doc_id"])
    handler._table.cache_clear()


@pytest.mark.parametrize("extension", sorted(keys.CONTENT_TYPES))
def test_every_default_extension_has_a_content_type(extension):
    from app.config import Settings  # noqa: F401  (import check only)

    assert keys.CONTENT_TYPES[extension]
