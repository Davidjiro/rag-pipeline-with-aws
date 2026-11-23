"""Chats and the streaming answer: events, persistence rules, daily cap, citations safety, history and agent payload."""

from __future__ import annotations

import json

import pytest
from app.agent import AgentError


def setup_chat(api, strategy="basic"):
    pid = api.as_user("alice").post("/projects", json={"name": "P"}).json()["project_id"]
    cid = api.post(f"/projects/{pid}/chats", json={"strategy": strategy}).json()["chat_id"]
    return pid, cid


def events(response) -> list[dict]:
    return [json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data:")]


def ask(api, pid, cid, text="What is the refund policy?"):
    return api.post(f"/projects/{pid}/chats/{cid}/messages", json={"text": text})


def test_stream_shape_and_persistence(api, agent, store, s3):
    pid, cid = setup_chat(api)
    key = f"projects/{pid}/33333333-3333-3333-3333-333333333333/policy.pdf"
    agent.script = [
        {"type": "token", "text": "Refunds take "},
        {"type": "token", "text": "30 days."},
        {
            "type": "citations",
            "citations": [{"number": 1, "source": f"s3://test-docs/{key}", "snippet": "30 days", "score": 0.8}],
        },
    ]

    response = ask(api, pid, cid)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.text.startswith(": keep-alive\n\n")
    seen = events(response)
    assert [e["type"] for e in seen] == ["token", "token", "citations", "done"]
    cite = seen[2]["citations"][0]
    assert cite["number"] == 1
    assert cite["filename"] == "policy.pdf" and "X-Amz-Signature" in cite["url"]
    assert cite["url"].startswith("https://test-docs.s3.us-east-1.amazonaws.com/")

    messages = api.get(f"/projects/{pid}/chats/{cid}/messages").json()
    assert [(m["role"], m["text"]) for m in messages] == [
        ("user", "What is the refund policy?"),
        ("assistant", "Refunds take 30 days."),
    ]
    assert messages[1]["citations"][0]["key"] == key
    assert seen[3]["message_id"] == messages[1]["message_id"]
    assert api.get(f"/projects/{pid}/chats").json()[0]["title"] == "What is the refund policy?"


def test_agent_receives_context_and_session_id(api, agent):
    pid, cid = setup_chat(api, strategy="multi_query")
    ask(api, pid, cid, "first")
    ask(api, pid, cid, "second")
    payload, session = agent.calls[1]
    assert session == cid and len(session) >= 33
    assert payload["user_id"] == "alice" and payload["project_id"] == pid and payload["chat_id"] == cid
    assert payload["text"] == "second" and payload["strategy"] == "multi_query"
    assert payload["history"] == [{"role": "user", "text": "first"}, {"role": "assistant", "text": "An answer."}]


def test_history_is_limited(api, agent, monkeypatch):
    monkeypatch.setenv("DAILY_QUESTION_CAP", "100")
    from app import config

    config.get_settings.cache_clear()
    pid, cid = setup_chat(api)
    for i in range(4):
        ask(api, pid, cid, f"q{i}")
    ask(api, pid, cid, "last")
    history = agent.calls[-1][0]["history"]
    assert len(history) == 4  # HISTORY_MESSAGES
    assert history[-1]["role"] == "assistant" and history[-2]["text"] == "q3"


def test_failure_saves_nothing_and_hides_details(api, agent):
    pid, cid = setup_chat(api)
    agent.script = AgentError("secret internal detail arn:aws:...")
    response = ask(api, pid, cid)
    seen = events(response)
    assert [e["type"] for e in seen] == ["error"]
    assert "secret" not in response.text and "arn:" not in response.text
    assert api.get(f"/projects/{pid}/chats/{cid}/messages").json() == []


def test_empty_answer_is_an_error(api, agent):
    pid, cid = setup_chat(api)
    agent.script = [{"type": "token", "text": "   "}]
    assert events(ask(api, pid, cid))[-1]["type"] == "error"
    assert api.get(f"/projects/{pid}/chats/{cid}/messages").json() == []


def test_citations_outside_the_project_are_dropped(api, agent):
    pid, cid = setup_chat(api)
    other = "11111111-1111-1111-1111-111111111111"
    agent.script = [
        {"type": "token", "text": "ok"},
        {
            "type": "citations",
            "citations": [
                {"source": f"s3://test-docs/projects/{other}/d/secret.pdf"},  # another project
                {"source": f"s3://other-bucket/projects/{pid}/22222222-2222-2222-2222-222222222222/a.pdf"},  # another bucket
                {"source": f"s3://test-docs/projects/{pid}/../{other}/d/x.pdf"},  # traversal
                {"source": f"s3://test-docs/projects/{pid}/d"},  # not a file key
                {"source": 42},
                "junk",
                {"source": f"s3://test-docs/projects/{pid}/22222222-2222-2222-2222-222222222222/good.pdf", "snippet": "x" * 2000},
            ],
        },
    ]
    seen = events(ask(api, pid, cid))
    cites = next(e for e in seen if e["type"] == "citations")["citations"]
    assert [c["filename"] for c in cites] == ["good.pdf"]
    assert len(cites[0]["snippet"]) == 500


def test_daily_cap_returns_429_and_does_not_call_agent(api, agent):
    pid, cid = setup_chat(api)
    for _ in range(3):
        assert ask(api, pid, cid).status_code == 200
    blocked = ask(api, pid, cid)
    assert blocked.status_code == 429 and len(agent.calls) == 3


def test_cap_is_per_user(api, agent):
    pid, cid = setup_chat(api)
    for _ in range(3):
        ask(api, pid, cid)
    pid2, cid2 = setup_chat_for(api, "bob")
    assert ask(api.as_user("bob"), pid2, cid2).status_code == 200


def setup_chat_for(api, user):
    pid = api.as_user(user).post("/projects", json={"name": "B"}).json()["project_id"]
    return pid, api.post(f"/projects/{pid}/chats", json={}).json()["chat_id"]


def test_question_length_limit_is_checked_before_cap(api, agent):
    pid, cid = setup_chat(api)
    assert ask(api, pid, cid, "x" * 201).status_code == 422
    assert ask(api, pid, cid, "").status_code == 422
    assert agent.calls == []
    for _ in range(3):  # the rejected requests did not use up the cap
        assert ask(api, pid, cid).status_code == 200


def test_invalid_strategy_is_rejected(api):
    pid, _ = setup_chat(api)
    assert api.post(f"/projects/{pid}/chats", json={"strategy": "hybrid"}).status_code == 422


def test_delete_chat_removes_messages(api, store):
    pid, cid = setup_chat(api)
    ask(api, pid, cid)
    assert api.delete(f"/projects/{pid}/chats/{cid}").status_code == 204
    assert store.list_messages(cid) == []
    assert api.get(f"/projects/{pid}/chats/{cid}/messages").status_code == 404


def test_retrieve_builds_filter_from_verified_identity(api, kb):
    pid, _ = setup_chat(api)
    kb.results = [
        {"text": "passage", "source": f"s3://test-docs/projects/{pid}/44444444-4444-4444-4444-444444444444/a.txt", "score": 0.7},
        {"text": "leak", "source": "s3://test-docs/projects/other/d/b.txt", "score": 0.6},
    ]
    response = api.post(f"/projects/{pid}/retrieve", json={"query": "refunds"})
    assert response.status_code == 200
    assert [r["filename"] for r in response.json()] == ["a.txt"]
    assert kb.retrieve_calls == [("refunds", pid, "alice", 5)]


@pytest.mark.parametrize("body", [{}, {"query": ""}, {"query": "x" * 201}, {"query": "ok", "project_id": "other"}])
def test_retrieve_validation(api, body):
    pid, _ = setup_chat(api)
    assert api.post(f"/projects/{pid}/retrieve", json=body).status_code == 422


@pytest.mark.parametrize(("raw", "kept"), [(2, 2), (True, None), ("1", None), (0, None), (5000, None), (None, None)])
def test_citation_number_is_validated(raw, kept):
    from app import citations
    from app.config import get_settings

    settings = get_settings()
    pid = "55555555-5555-5555-5555-555555555555"
    source = f"s3://test-docs/projects/{pid}/66666666-6666-6666-6666-666666666666/a.pdf"
    assert citations.sanitize([{"number": raw, "source": source}], settings, pid)[0]["number"] == kept
