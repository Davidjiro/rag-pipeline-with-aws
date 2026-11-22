"""Fakes shared by the agent tests. Nothing here calls AWS."""

import json
from collections.abc import AsyncIterator

import pytest
from strands.models import Model

from app.config import Settings
from app.guardrail import InputGuardrail


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


class FakeRuntimeClient:
    """bedrock-runtime: apply_guardrail and converse."""

    def __init__(self, intervene=False, rewrite_text='["alt one", "alt two"]', error=None):
        self.intervene = intervene
        self.rewrite_text = rewrite_text
        self.error = error
        self.guardrail_calls: list[dict] = []
        self.converse_calls: list[dict] = []

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


@pytest.fixture
def guardrail():
    return InputGuardrail(FakeRuntimeClient(), "gr1", "1")


class ScriptedModel(Model):
    """A Strands model that plays back scripted turns, so the real Agent loop and tool calling run without Bedrock.

    Each turn is a list of ("text", str) or ("tool", name, input_dict) items.
    """

    def __init__(self, turns):
        self.turns = list(turns)
        self.requests: list[list] = []

    def update_config(self, **model_config):
        return None

    def get_config(self):
        return {"model_id": "scripted"}

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        raise NotImplementedError
        yield

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs) -> AsyncIterator[dict]:
        self.requests.append(messages)
        turn = self.turns.pop(0)
        yield {"messageStart": {"role": "assistant"}}
        stop = "end_turn"
        for index, item in enumerate(turn):
            if item[0] == "text":
                yield {"contentBlockStart": {"start": {}, "contentBlockIndex": index}}
                yield {"contentBlockDelta": {"delta": {"text": item[1]}, "contentBlockIndex": index}}
                yield {"contentBlockStop": {"contentBlockIndex": index}}
            else:
                stop = "tool_use"
                yield {
                    "contentBlockStart": {
                        "start": {"toolUse": {"toolUseId": f"tool-{index}", "name": item[1]}},
                        "contentBlockIndex": index,
                    }
                }
                yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(item[2])}}, "contentBlockIndex": index}}
                yield {"contentBlockStop": {"contentBlockIndex": index}}
        yield {"messageStop": {"stopReason": stop}}
        yield {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}, "metrics": {"latencyMs": 1}}}
