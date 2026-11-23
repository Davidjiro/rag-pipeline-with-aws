"""The boto3 agent loop on its own: request shape, tool round trip, stream errors, limits, the thinking filter."""

import pytest
from botocore.exceptions import ClientError
from conftest import FakeRuntimeClient

from app.runner import MAX_MODEL_TURNS, TOOL_NAME, ModelError, ThinkingFilter, stream_answer


def run(client, search=lambda q: f"results for {q}", history=()):
    return "".join(stream_answer(client, "model-x", 128, history, "the question", search))


def test_request_shape():
    client = FakeRuntimeClient(turns=[[("text", "hello")]])
    assert run(client) == "hello"
    call = client.stream_calls[0]
    assert call["modelId"] == "model-x"
    assert call["inferenceConfig"] == {"maxTokens": 128, "temperature": 0}
    assert [t["toolSpec"]["name"] for t in call["toolConfig"]["tools"]] == [TOOL_NAME]
    assert call["messages"] == [{"role": "user", "content": [{"text": "the question"}]}]
    assert "search_documents" in call["system"][0]["text"]


def test_tool_round_trip():
    seen = []
    client = FakeRuntimeClient(
        turns=[[("text", "Let me look."), ("tool", TOOL_NAME, {"query": "refunds"})], [("text", "Answer.")]]
    )
    out = run(client, search=lambda q: seen.append(q) or "PASSAGES")
    assert seen == ["refunds"]
    assert out == "Let me look.Answer."  # the runner yields everything; chat.py decides what reaches the user
    second = client.stream_calls[1]["messages"]
    assert second[1] == {
        "role": "assistant",
        "content": [{"text": "Let me look."}, {"toolUse": {"toolUseId": "t1", "name": TOOL_NAME, "input": {"query": "refunds"}}}],
    }
    assert second[2] == {"role": "user", "content": [{"toolResult": {"toolUseId": "t1", "content": [{"text": "PASSAGES"}]}}]}


def test_history_comes_first():
    client = FakeRuntimeClient(turns=[[("text", "ok")]])
    run(client, history=({"role": "user", "text": "q0"}, {"role": "assistant", "text": "a0"}))
    assert [m["role"] for m in client.stream_calls[0]["messages"]] == ["user", "assistant", "user"]


@pytest.mark.parametrize(
    "tool",
    [("tool", TOOL_NAME, "{not json"), ("tool", TOOL_NAME, {"query": "  "}), ("tool", "delete_everything", {"query": "x"})],
    ids=["bad-json", "empty-query", "unknown-tool"],
)
def test_bad_tool_requests_are_answered_without_searching(tool):
    searched = []
    client = FakeRuntimeClient(turns=[[tool], [("text", "done")]])
    assert run(client, search=lambda q: searched.append(q) or "") == "done"
    assert searched == []
    result = client.stream_calls[1]["messages"][-1]["content"][0]["toolResult"]["content"][0]["text"]
    assert result.startswith("Invalid tool request")


def test_turn_limit():
    client = FakeRuntimeClient(turns=[[("tool", TOOL_NAME, {"query": f"q{i}"})] for i in range(MAX_MODEL_TURNS + 3)])
    run(client)
    assert len(client.stream_calls) == MAX_MODEL_TURNS


def test_call_failure_raises_model_error():
    error = ClientError({"Error": {"Code": "ThrottlingException", "Message": "x"}}, "ConverseStream")
    with pytest.raises(ModelError):
        run(FakeRuntimeClient(stream_error=error))


def test_error_event_inside_the_stream_raises():
    client = FakeRuntimeClient(turns=[[("text", "partial"), ("raw", {"modelStreamErrorException": {"message": "boom"}})]])
    with pytest.raises(ModelError):
        run(client)


def test_search_failure_propagates():
    """A failing search must fail the answer, not be shown to the model as an empty result."""

    def broken(_):
        raise RuntimeError("retrieve down")

    client = FakeRuntimeClient(turns=[[("tool", TOOL_NAME, {"query": "x"})], [("text", "guess")]])
    with pytest.raises(RuntimeError):
        run(client, search=broken)


def test_max_tokens_stop_returns_what_was_written():
    client = FakeRuntimeClient(turns=[[("text", "cut off"), ("stop", "max_tokens")]])
    assert run(client) == "cut off"


@pytest.mark.parametrize(
    ("chunks", "expected"),
    [
        (["<thinking>plan</thinking>Answer"], "Answer"),
        (["<think", "ing>plan</thi", "nking>Ans", "wer"], "Answer"),
        (["A <thinking>x</thinking>B <thinking>y</thinking>C"], "A B C"),
        (["no tags at all"], "no tags at all"),
        (["ends with <"], "ends with <"),
        (["<thinking>never closed"], ""),
        (["a < b and <b>bold</b>"], "a < b and <b>bold</b>"),
    ],
)
def test_thinking_filter(chunks, expected):
    f = ThinkingFilter()
    assert "".join(f.feed(c) for c in chunks) + f.flush() == expected
