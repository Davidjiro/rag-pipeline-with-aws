"""Uploads (presigned POST rules), listing with status reconciliation, and deletion."""

from __future__ import annotations

from datetime import timedelta

import pytest
from app import store as st


def make_project(api):
    return api.as_user("alice").post("/projects", json={"name": "P"}).json()["project_id"]


def conditions(upload: dict) -> list:
    """The signed policy is base64 JSON in the form fields."""
    import base64
    import json

    return json.loads(base64.b64decode(upload["fields"]["policy"]))["conditions"]


def test_request_upload_returns_locked_down_presigned_post(api, store):
    pid = make_project(api)
    body = api.post(f"/projects/{pid}/files", json={"filename": "Report 2024.PDF"}).json()

    assert body["filename"] == "Report_2024.pdf" and body["status"] == "PENDING_UPLOAD"
    assert body["max_bytes"] == 1024 * 1024
    fields = body["upload"]["fields"]
    assert fields["key"] == f"projects/{pid}/{body['doc_id']}/Report_2024.pdf"
    assert fields["Content-Type"] == "application/pdf"
    policy = conditions(body["upload"])
    assert ["content-length-range", 1, 1024 * 1024] in policy
    assert {"Content-Type": "application/pdf"} in policy
    assert {"bucket": "test-docs"} in policy

    record = store.get_document(pid, body["doc_id"])
    assert record["owner_id"] == "alice" and record["status"] == "PENDING_UPLOAD" and "ttl" in record


@pytest.mark.parametrize(
    "name", ["virus.exe", "noextension", "script.js", ".pdf", "a.PDF.exe", "x.pdf.metadata.json", "x.METADATA.JSON"]
)
def test_unsupported_names_are_rejected(api, name):
    pid = make_project(api)
    assert api.post(f"/projects/{pid}/files", json={"filename": name}).status_code == 422


def test_path_traversal_in_name_cannot_escape_the_project_folder(api):
    pid = make_project(api)
    body = api.post(f"/projects/{pid}/files", json={"filename": "../../other/evil.pdf"}).json()
    assert body["filename"] == "evil.pdf"
    assert body["upload"]["fields"]["key"] == f"projects/{pid}/{body['doc_id']}/evil.pdf"


def test_document_limit(api):
    pid = make_project(api)
    for i in range(3):
        assert api.post(f"/projects/{pid}/files", json={"filename": f"f{i}.txt"}).status_code == 201
    assert api.post(f"/projects/{pid}/files", json={"filename": "f4.txt"}).status_code == 409


def test_list_does_not_call_bedrock_when_nothing_is_ingesting(api, kb):
    pid = make_project(api)
    api.post(f"/projects/{pid}/files", json={"filename": "a.txt"})
    assert len(api.get(f"/projects/{pid}/files").json()) == 1
    assert kb.status_calls == []


def ingesting_doc(api, store, pid, name="a.txt", age_minutes=1):
    doc_id = api.post(f"/projects/{pid}/files", json={"filename": name}).json()["doc_id"]
    doc = store.get_document(pid, doc_id)
    assert store.set_document_status(doc, st.INGESTING, expected=st.PENDING_UPLOAD)
    past = st.iso(st.now() - timedelta(minutes=age_minutes))
    store.table.update_item(
        Key={"PK": doc["PK"], "SK": doc["SK"]},
        UpdateExpression="SET updated_at = :t",
        ExpressionAttributeValues={":t": past},
    )
    return doc_id, f"s3://test-docs/projects/{pid}/{doc_id}/{name}"


@pytest.mark.parametrize(
    ("bedrock", "age", "expected"),
    [
        ("INDEXED", 1, "READY"),
        ("PARTIALLY_INDEXED", 1, "READY"),
        ("FAILED", 1, "FAILED"),
        ("IGNORED", 1, "FAILED"),
        ("IN_PROGRESS", 1, "INGESTING"),
        ("PENDING", 1, "INGESTING"),
        ("NOT_FOUND", 1, "INGESTING"),
        ("NOT_FOUND", 10, "FAILED"),
        ("IN_PROGRESS", 45, "FAILED"),  # stuck for over 30 minutes
    ],
)
def test_status_reconciliation(api, store, kb, bedrock, age, expected):
    pid = make_project(api)
    doc_id, uri = ingesting_doc(api, store, pid, age_minutes=age)
    kb.status_by_uri[uri] = bedrock

    shown = api.get(f"/projects/{pid}/files").json()[0]["status"]

    assert shown == expected
    assert store.get_document(pid, doc_id)["status"] == expected  # persisted, so the next list is free


def test_partial_index_carries_a_warning(api, store, kb):
    pid = make_project(api)
    _, uri = ingesting_doc(api, store, pid)
    kb.status_by_uri[uri] = "PARTIALLY_INDEXED"
    assert "warning" in api.get(f"/projects/{pid}/files").json()[0]


def test_batches_of_ten(api, store, kb, monkeypatch):
    monkeypatch.setenv("MAX_DOCUMENTS_PER_PROJECT", "30")
    from app import config

    config.get_settings.cache_clear()
    pid = make_project(api)
    for i in range(12):
        ingesting_doc(api, store, pid, name=f"f{i}.txt")
    api.get(f"/projects/{pid}/files")
    # the fake receives one call with all uris; batching of 10 is inside KnowledgeBase and tested there
    assert len(kb.status_calls[0]) == 12


def test_bedrock_outage_shows_stored_status(api, store, kb):
    pid = make_project(api)
    ingesting_doc(api, store, pid)
    kb.fail_status = True
    response = api.get(f"/projects/{pid}/files")
    assert response.status_code == 200 and response.json()[0]["status"] == "INGESTING"


def test_delete_file(api, store, s3, kb):
    pid = make_project(api)
    doc_id, uri = ingesting_doc(api, store, pid)
    s3.put_object(Bucket="test-docs", Key=f"projects/{pid}/{doc_id}/a.txt", Body=b"x")
    s3.put_object(Bucket="test-docs", Key=f"projects/{pid}/{doc_id}/a.txt.metadata.json", Body=b"{}")

    assert api.delete(f"/projects/{pid}/files/{doc_id}").status_code == 204

    assert kb.deleted == [[uri]]
    assert s3.list_objects_v2(Bucket="test-docs")["KeyCount"] == 0
    assert store.get_document(pid, doc_id) is None


def test_delete_file_keeps_everything_when_index_removal_fails(api, store, s3, kb):
    pid = make_project(api)
    doc_id, _ = ingesting_doc(api, store, pid)
    s3.put_object(Bucket="test-docs", Key=f"projects/{pid}/{doc_id}/a.txt", Body=b"x")
    kb.fail_delete = True
    assert api.delete(f"/projects/{pid}/files/{doc_id}").status_code == 502
    assert s3.list_objects_v2(Bucket="test-docs")["KeyCount"] == 1
    assert store.get_document(pid, doc_id) is not None


def test_delete_pending_file_skips_the_index(api, kb):
    pid = make_project(api)
    doc_id = api.post(f"/projects/{pid}/files", json={"filename": "a.txt"}).json()["doc_id"]
    assert api.delete(f"/projects/{pid}/files/{doc_id}").status_code == 204
    assert kb.deleted == []
