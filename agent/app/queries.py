"""Multi-query: ask the model for alternative wordings of a question.

One short model call (at most 200 output tokens, temperature 0). Any failure falls back to the original question alone, so the
multi-query strategy can degrade to basic search but never fails the answer.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from .config import MULTI_QUERY_COUNT
from .prompts import REWRITE_SYSTEM

log = logging.getLogger(__name__)

MAX_QUERY_CHARS = 300


def parse_queries(raw: str, original: str, count: int = MULTI_QUERY_COUNT) -> list[str]:
    """The original question first, then up to `count` distinct rewrites from the model's JSON array."""
    start, end = raw.find("["), raw.rfind("]")
    rewrites: list[Any] = []
    if start != -1 and end > start:
        try:
            rewrites = json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            rewrites = []
    queries = [original]
    seen = {original.strip().lower()}
    for item in rewrites if isinstance(rewrites, list) else []:
        if not isinstance(item, str):
            continue
        query = item.strip()[:MAX_QUERY_CHARS]
        if query and query.lower() not in seen:
            seen.add(query.lower())
            queries.append(query)
        if len(queries) > count:
            break
    return queries


class QueryRewriter:
    def __init__(self, client: Any, model_id: str) -> None:
        self._client = client
        self._model_id = model_id

    def __call__(self, question: str) -> list[str]:
        try:
            response = self._client.converse(
                modelId=self._model_id,
                system=[{"text": REWRITE_SYSTEM}],
                messages=[
                    {
                        "role": "user",
                        "content": [{"text": f"Question: {question}\nWrite {MULTI_QUERY_COUNT} alternative queries."}],
                    }
                ],
                inferenceConfig={"maxTokens": 200, "temperature": 0},
            )
            blocks = response["output"]["message"]["content"]
            raw = "".join(b.get("text", "") for b in blocks)
        except (ClientError, BotoCoreError, KeyError, TypeError):
            log.warning("Query rewrite failed; searching with the original question only")
            return [question]
        return parse_queries(raw, question)
