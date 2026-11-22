"""Unit tests for pure helpers: key layout, SSE parsing, agent response handling, Knowledge Base wrapper, config."""

from __future__ import annotations

import io
import json

import pytest
from app import keys
from app.agent import AgentClient, AgentError
from app.kb import KnowledgeBase, KnowledgeBaseError, map_status
from app.sse import format_event, parse_events
from botocore.exceptions import ClientError

# ---- keys ------------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("report.pdf", "report.pdf"),
        ("My Report (final).PDF", "My_Report_final.pdf"),
        ("../../etc/passwd.txt", "passwd.txt"),
        ("C:\\Users\\me\\notes.md", "notes.md"),
        ("..hidden.txt", "hidden.txt"),
        ("a" * 300 + ".pdf", "a" * 96 + ".pdf"),
        ("résumé.docx", "r_sum.docx"),
    ],
)
def test_sanitize_filename(raw, expected):
    assert keys.sanitize_filename(raw) == expected


@pytest.mark.parametrize("raw", ["", "noext", ".pdf", "...", "x."])
def test_sanitize_filename_rejects(raw):
    with pytest.raises(ValueError, match="name"):
        keys.sanitize_filename(raw)


def test_parse_s3_key():
    assert keys.parse_s3_key("projects/", "projects/p/d/f.pdf") == ("p", "d", "f.pdf")
    assert keys.parse_s3_key("projects/", "projects/p/d/sub/f.pdf") == ("p", "d", "sub/f.pdf")
    for bad in ("other/p/d/f", "projects/p/d", "projects//d/f", "projects/p/d/"):
        assert keys.parse_s3_key("projects/", bad) is None


# ---- sse -------------------------------------------------------------------------------------------------------------------


def test_sse_roundtrip_and_tolerance():
    line = format_event({"type": "token", "text": "héllo"})
    assert line.endswith("\n\n")
    lines = [b": comment", b"", line.encode(), b"data: not json", b"data: [DONE]", b'data: ["list"]', b"event: x"]
    assert list(parse_events(lines)) == [{"type": "token", "text": "héllo"}]


# ---- agent -----------------------------------------------------------------------------------------------------------------


class Body(io.BytesIO):
    def iter_lines(self):
        return iter(self.getvalue().splitlines())


class FakeRuntime:
    def __init__(self, content_type, body, error=None):
        self.content_type, self.body, self.error, self.kwargs = content_type, body, error, None

    def invoke_agent_runtime(self, **kwargs):
        self.kwargs = kwargs
        if self.error:
            raise self.error
        return {"contentType": self.content_type, "response": Body(self.body)}


def run_agent(runtime):
    return list(AgentClient(runtime, "arn:x").stream({"text": "hi"}, "s" * 36))


def test_agent_json_response():
    runtime = FakeRuntime("application/json", json.dumps({"answer": "A", "citations": [{"source": "s"}]}).encode())
    assert run_agent(runtime) == [
        {"type": "token", "text": "A"},
        {"type": "citations", "citations": [{"source": "s"}]},
    ]
    assert runtime.kwargs["runtimeSessionId"] == "s" * 36 and runtime.kwargs["agentRuntimeArn"] == "arn:x"
    assert json.loads(runtime.kwargs["payload"]) == {"text": "hi"}


def test_agent_event_stream_response():
    body = b'data: {"type":"token","text":"a"}\n\ndata: {"type":"debug"}\n\ndata: {"type":"citations","citations":[]}\n\n'
    assert [e["type"] for e in run_agent(FakeRuntime("text/event-stream", body))] == ["token", "citations"]


@pytest.mark.parametrize(
    "error_line",
    [b'data: {"error":"boom","message":"An error occurred during streaming"}', b'data: {"type":"error","message":"x"}'],
)
def test_agent_error_event_aborts_the_answer(error_line):
    body = b'data: {"type":"token","text":"partial"}\n\n' + error_line + b"\n\n"
    with pytest.raises(AgentError):
        run_agent(FakeRuntime("text/event-stream", body))


@pytest.mark.parametrize("body", [b"not json", b'{"no":"answer"}', b'["list"]'])
def test_agent_bad_json(body):
    with pytest.raises(AgentError):
        run_agent(FakeRuntime("application/json", body))


def test_agent_service_error():
    error = ClientError({"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "InvokeAgentRuntime")
    with pytest.raises(AgentError):
        run_agent(FakeRuntime("application/json", b"", error))


# ---- knowledge base --------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "age", "expected"),
    [
        ("INDEXED", 0, ("READY", None)),
        ("METADATA_PARTIALLY_INDEXED", 0, ("READY", "Some content of this file could not be indexed.")),
        ("METADATA_UPDATE_FAILED", 0, ("FAILED", None)),
        ("STARTING", 0, ("INGESTING", None)),
        ("NOT_FOUND", 299, ("INGESTING", None)),
        ("NOT_FOUND", 301, ("FAILED", None)),
        ("SOMETHING_NEW", 0, ("INGESTING", None)),
    ],
)
def test_map_status(status, age, expected):
    assert map_status(status, age_seconds=age) == expected


class FakeAgentApi:
    def __init__(self):
        self.calls = []

    def get_knowledge_base_documents(self, **kw):
        self.calls.append(("get", kw))
        return {
            "documentDetails": [
                {"identifier": d, "status": "INDEXED"} | {"identifier": {"s3": d["s3"]}} for d in kw["documentIdentifiers"]
            ]
        }

    def delete_knowledge_base_documents(self, **kw):
        self.calls.append(("delete", kw))
        return {}


class FakeRuntimeApi:
    def __init__(self, error=None):
        self.kw, self.error = None, error

    def retrieve(self, **kw):
        if self.error:
            raise self.error
        self.kw = kw
        return {
            "retrievalResults": [
                {"content": {"text": "t"}, "location": {"s3Location": {"uri": "s3://b/k"}}, "score": 0.5},
                {"content": {}, "location": {}},
            ]
        }


def test_statuses_and_deletes_are_batched_by_ten():
    api = FakeAgentApi()
    kb = KnowledgeBase(api, FakeRuntimeApi(), "KB", "DS")
    uris = [f"s3://b/k{i}" for i in range(23)]
    assert set(kb.statuses(uris).values()) == {"INDEXED"} and len(kb.statuses(uris)) == 23
    kb.delete_documents(uris)
    sizes = [len(kw["documentIdentifiers"]) for op, kw in api.calls if op == "delete"]
    assert sizes == [10, 10, 3]
    assert api.calls[0][1]["knowledgeBaseId"] == "KB" and api.calls[0][1]["dataSourceId"] == "DS"
    assert api.calls[0][1]["documentIdentifiers"][0] == {"dataSourceType": "S3", "s3": {"uri": "s3://b/k0"}}


def test_retrieve_filter_requires_project_and_owner():
    runtime = FakeRuntimeApi()
    results = KnowledgeBase(FakeAgentApi(), runtime, "KB", "DS").retrieve("q", "P", "U", 7)
    config = runtime.kw["retrievalConfiguration"]["vectorSearchConfiguration"]
    assert config["numberOfResults"] == 7
    assert config["filter"] == {
        "andAll": [{"equals": {"key": "project_id", "value": "P"}}, {"equals": {"key": "owner_id", "value": "U"}}]
    }
    assert results[0] == {"text": "t", "source": "s3://b/k", "score": 0.5}
    assert results[1]["source"] == ""


def test_kb_errors_are_wrapped():
    error = ClientError({"Error": {"Code": "AccessDenied", "Message": "no"}}, "Retrieve")
    with pytest.raises(KnowledgeBaseError):
        KnowledgeBase(FakeAgentApi(), FakeRuntimeApi(error), "KB", "DS").retrieve("q", "P", "U", 5)


def test_kb_error_maps_to_502(api, kb):
    pid = api.post("/projects", json={"name": "p"}).json()["project_id"]

    def boom(*_):
        raise KnowledgeBaseError("secret detail")

    kb.retrieve = boom
    response = api.post(f"/projects/{pid}/retrieve", json={"query": "q"})
    assert response.status_code == 502 and "secret" not in response.text


# ---- config ----------------------------------------------------------------------------------------------------------------


def test_settings(environment):
    from app.config import get_settings

    settings = get_settings()
    assert settings.max_file_bytes == 1024 * 1024
    assert settings.jwks_url == "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL/.well-known/jwks.json"
    assert "pdf" in settings.allowed_extensions


def test_missing_required_variable_names_it(monkeypatch, environment):
    from app.config import Settings

    monkeypatch.delenv("TABLE_NAME")
    with pytest.raises(KeyError, match="TABLE_NAME"):
        Settings.from_env()
