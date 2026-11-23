"""The AgentCore HTTP contract end to end, through the SDK's server: /ping, /invocations, SSE framing, error handling."""

import json
from functools import partial

import pytest
from conftest import FakeRetrieveClient, FakeRuntimeClient, result
from starlette.testclient import TestClient

from app import chat, main
from app.guardrail import InputGuardrail
from app.retrieval import Searcher
from app.runner import stream_answer

DOC = "s3://docs/projects/p-1/11111111-1111-1111-1111-111111111111/policy.pdf"
PAYLOAD = {"user_id": "u-1", "project_id": "p-1", "chat_id": "c-1", "text": "Refund time?", "history": [], "strategy": "basic"}


def sse_events(response) -> list[dict]:
    return [json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data:")]


@pytest.fixture
def client(monkeypatch, settings):
    def fake_deps(request):
        runtime = FakeRuntimeClient(turns=[[("tool", "search_documents", {"query": "refund"})], [("text", "30 days [1].")]])
        searcher = Searcher(
            FakeRetrieveClient(default=[result(DOC, "30 days", 0.7)]), settings, request.project_id, request.user_id
        )
        return chat.ChatDeps(InputGuardrail(runtime, "gr", "1"), searcher, partial(stream_answer, runtime, "m", 256))

    monkeypatch.setattr(main, "build_deps", fake_deps)
    return TestClient(main.app)


def test_ping(client):
    response = client.get("/ping")
    assert response.status_code == 200 and response.json()["status"] in ("Healthy", "HealthyBusy")


def test_invocation_streams_events_the_api_understands(client):
    response = client.post("/invocations", json=PAYLOAD)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = sse_events(response)
    assert [e["type"] for e in events][-1] == "citations"
    assert "".join(e["text"] for e in events if e["type"] == "token") == "30 days [1]."
    assert events[-1]["citations"][0]["source"] == DOC


def test_events_parse_with_the_api_client(client):
    """The API's own parser accepts the agent's stream: the two sides of the contract agree."""
    import importlib.util
    import sys
    from pathlib import Path

    # Both services name their package `app`, so load the API's copy under another name.
    package = Path(__file__).parents[2] / "backend" / "api" / "app"
    spec = importlib.util.spec_from_file_location("api_app", package / "__init__.py", submodule_search_locations=[str(package)])
    module = importlib.util.module_from_spec(spec)
    sys.modules["api_app"] = module
    spec.loader.exec_module(module)
    from api_app.agent import AgentClient

    class Body:
        def __init__(self, text):
            self.text = text

        def iter_lines(self):
            return iter(self.text.encode().splitlines())

        def close(self):
            pass

    class Runtime:
        def invoke_agent_runtime(self, **kwargs):
            return {"contentType": "text/event-stream", "response": Body(client.post("/invocations", json=PAYLOAD).text)}

    events = list(AgentClient(Runtime(), "arn").stream(PAYLOAD, "s" * 36))
    types = [e["type"] for e in events]
    assert types[-1] == "citations" and set(types[:-1]) == {"token"} and len(types) >= 2


@pytest.mark.parametrize("payload", [{"text": "hi"}, {**PAYLOAD, "strategy": "hybrid"}, {**PAYLOAD, "user_id": ""}])
def test_bad_request_is_an_error_event_and_no_search(client, payload):
    response = client.post("/invocations", json=payload)
    assert [e["type"] for e in sse_events(response)] == ["error"]


def test_invalid_json_is_400(client):
    assert client.post("/invocations", content=b"not json").status_code == 400
