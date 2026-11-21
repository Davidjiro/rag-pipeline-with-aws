"""Projects, and the rule that matters most: one user can never see or change another user's data."""

from __future__ import annotations

import uuid

import pytest


def make_project(api, user="alice", name="Research"):
    return api.as_user(user).post("/projects", json={"name": name}).json()["project_id"]


def test_create_list_get(api):
    pid = make_project(api)
    assert api.as_user("alice").get("/projects").json()[0]["project_id"] == pid
    assert api.get(f"/projects/{pid}").json()["name"] == "Research"


def test_name_validation(api):
    assert api.post("/projects", json={"name": ""}).status_code == 422
    assert api.post("/projects", json={"name": "x" * 81}).status_code == 422
    assert api.post("/projects", json={"name": "ok", "owner_id": "bob"}).status_code == 422  # unknown fields refused


def test_invalid_uuid_in_path_is_422(api):
    assert api.get("/projects/not-a-uuid").status_code == 422
    assert api.get("/projects/..%2F..%2Fx").status_code in (404, 422)


def test_list_shows_only_own_projects(api):
    make_project(api, "alice")
    make_project(api, "bob", "Bob's")
    assert [p["name"] for p in api.as_user("bob").get("/projects").json()] == ["Bob's"]


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("get", "", None),
        ("delete", "", None),
        ("get", "/files", None),
        ("post", "/files", {"filename": "a.pdf"}),
        ("get", "/chats", None),
        ("post", "/chats", {}),
        ("post", "/retrieve", {"query": "x"}),
    ],
)
def test_other_users_project_is_404_on_every_route(api, method, path, body):
    pid = make_project(api, "alice")
    response = getattr(api.as_user("bob"), method)(f"/projects/{pid}{path}", **({"json": body} if body is not None else {}))
    assert response.status_code == 404


def test_other_users_chat_and_file_are_404(api, store):
    pid = make_project(api, "alice")
    chat = api.as_user("alice").post(f"/projects/{pid}/chats", json={}).json()["chat_id"]
    doc = api.post(f"/projects/{pid}/files", json={"filename": "a.pdf"}).json()["doc_id"]
    bob = api.as_user("bob")
    assert bob.get(f"/projects/{pid}/chats/{chat}/messages").status_code == 404
    assert bob.post(f"/projects/{pid}/chats/{chat}/messages", json={"text": "hi"}).status_code == 404
    assert bob.delete(f"/projects/{pid}/chats/{chat}").status_code == 404
    assert bob.delete(f"/projects/{pid}/files/{doc}").status_code == 404
    # nothing was changed
    assert store.get_chat(pid, chat) is not None
    assert store.get_document(pid, doc) is not None


def test_chat_id_of_another_project_is_404(api):
    p1, p2 = make_project(api, name="one"), make_project(api, name="two")
    chat = api.post(f"/projects/{p1}/chats", json={}).json()["chat_id"]
    assert api.get(f"/projects/{p2}/chats/{chat}/messages").status_code == 404


def test_unknown_project_is_404(api):
    assert api.get(f"/projects/{uuid.uuid4()}").status_code == 404


def test_delete_project_cascades(api, store, s3, kb):
    pid = make_project(api)
    api.post(f"/projects/{pid}/files", json={"filename": "a.pdf"})  # stays PENDING_UPLOAD: never sent to the index
    ready = api.post(f"/projects/{pid}/files", json={"filename": "b.pdf"}).json()["doc_id"]
    doc = store.get_document(pid, ready)
    store.set_document_status(doc, "INGESTING", expected="PENDING_UPLOAD")
    s3.put_object(Bucket="test-docs", Key=f"projects/{pid}/{ready}/b.pdf", Body=b"x")
    s3.put_object(Bucket="test-docs", Key=f"projects/{make_project(api, name='other')}/keep/c.pdf", Body=b"x")
    chat = api.post(f"/projects/{pid}/chats", json={}).json()["chat_id"]
    store.add_exchange(chat, "q", "a", [])

    assert api.delete(f"/projects/{pid}").status_code == 204

    assert kb.deleted == [[f"s3://test-docs/projects/{pid}/{ready}/b.pdf"]]  # only the document that was sent to the index
    keys = [o["Key"] for o in s3.list_objects_v2(Bucket="test-docs").get("Contents", [])]
    assert all(f"projects/{pid}/" not in k for k in keys)
    assert len(keys) == 1  # the other project's file is untouched
    assert store.list_documents(pid) == [] and store.list_chats(pid) == [] and store.list_messages(chat) == []
    assert api.get(f"/projects/{pid}").status_code == 404


def test_delete_project_stops_when_index_removal_fails(api, store, s3, kb):
    pid = make_project(api)
    doc_id = api.post(f"/projects/{pid}/files", json={"filename": "b.pdf"}).json()["doc_id"]
    store.set_document_status(store.get_document(pid, doc_id), "READY", expected="PENDING_UPLOAD")
    s3.put_object(Bucket="test-docs", Key=f"projects/{pid}/{doc_id}/b.pdf", Body=b"x")
    kb.fail_delete = True

    assert api.delete(f"/projects/{pid}").status_code == 502

    assert s3.list_objects_v2(Bucket="test-docs")["KeyCount"] == 1  # file kept, so a retry can finish the job
    assert api.get(f"/projects/{pid}").status_code == 200
