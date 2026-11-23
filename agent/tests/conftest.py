"""Fakes shared by the agent tests. Nothing here calls AWS.

`FakeRuntimeClient` plays back scripted ConverseStream turns in the event shape Bedrock sends (checked against a real Nova call:
text arrives as contentBlockDelta without a contentBlockStart; a tool request has a contentBlockStart with `toolUse`).
"""

import json

import pytest

from app.config import Settings


@pytest.fixture
def settings() -> Settings:
    return Settings(
        region="us-east-1",
        model_id="test-model",
        knowledge_base_id="KB1",
        guardrail_id="gr1",
        guardrail_version="1",
        top_k=3,
        max_output_tokens=256,
        min_score=0.0,
    )


def result(uri: str, text: str, score: float = 0.5) -> dict:
    return {"content": {"text": text}, "location": {"s3Location": {"uri": uri}}, "score": score}


class FakeRetrieveClient:
    """bedrock-agent-runtime. `responses` maps a query to results; unknown queries return `default`."""

    def __init__(self, responses=None, default=None, error=None):
        self.responses = responses or {}
        self.default = default or []
        self.error = error
        self.calls: list[dict] = []

    def retrieve(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        query = kwargs["retrievalQuery"]["text"]
        return {"retrievalResults": self.responses.get(query, self.default)}


def turn_events(turn) -> list[dict]:
    """Bedrock stream events for one scripted turn: items are ("text", str), ("tool", name, input) or ("raw", event)."""
    events: list[dict] = [{"messageStart": {"role": "assistant"}}]
    stop = "end_turn"
    for index, item in enumerate(turn):
        if item[0] == "text":
            for piece in (item[1][: len(item[1]) // 2], item[1][len(item[1]) // 2 :]):  # split, as the real stream does
                if piece:
                    events.append({"contentBlockDelta": {"delta": {"text": piece}, "contentBlockIndex": index}})
            events.append({"contentBlockStop": {"contentBlockIndex": index}})
        elif item[0] == "tool":
            stop = "tool_use"
            raw = item[2] if isinstance(item[2], str) else json.dumps(item[2])
            events.append(
                {
                    "contentBlockStart": {
                        "start": {"toolUse": {"toolUseId": f"t{index}", "name": item[1]}},
                        "contentBlockIndex": index,
                    }
                }
            )
            events.append({"contentBlockDelta": {"delta": {"toolUse": {"input": raw}}, "contentBlockIndex": index}})
            events.append({"contentBlockStop": {"contentBlockIndex": index}})
        elif item[0] == "stop":
            stop = item[1]
        else:
            events.append(item[1])
    events.append({"messageStop": {"stopReason": stop}})
    events.append({"metadata": {"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}}})
    return events


class FakeRuntimeClient:
    """bedrock-runtime: apply_guardrail, converse (multi-query rewrite) and converse_stream (the answer loop)."""

    def __init__(self, turns=None, intervene=False, rewrite_text='["alt one", "alt two"]', error=None, stream_error=None):
        self.turns = list(turns or [])
        self.intervene = intervene
        self.rewrite_text = rewrite_text
        self.error = error
        self.stream_error = stream_error
        self.guardrail_calls: list[dict] = []
        self.converse_calls: list[dict] = []
        self.stream_calls: list[dict] = []

    def apply_guardrail(self, **kwargs):
        self.guardrail_calls.append(kwargs)
        if self.error:
            raise self.error
        return {"action": "GUARDRAIL_INTERVENED" if self.intervene else "NONE"}

    def converse(self, **kwargs):
        self.converse_calls.append(kwargs)
        if self.error:
            raise self.error
        return {"output": {"message": {"content": [{"text": self.rewrite_text}]}}}

    def converse_stream(self, **kwargs):
        # copy the messages: the loop keeps appending to the same list
        self.stream_calls.append({**kwargs, "messages": json.loads(json.dumps(kwargs["messages"]))})
        if self.stream_error:
            raise self.stream_error
        return {"stream": iter(turn_events(self.turns.pop(0)))}
