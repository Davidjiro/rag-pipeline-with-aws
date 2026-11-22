"""Search the Knowledge Base for one project of one user, and keep track of the evidence found.

TENANCY: the metadata filter is built here, in code, from the `user_id` and `project_id` the API verified. The model never sees
or sets either value, so a prompt injection cannot widen the search. Both conditions must match (`andAll`).

MULTI-QUERY: the question is rewritten (see queries.py), every query is searched in parallel with the same filter, and the ranked
lists are merged with Reciprocal Rank Fusion: score = sum over lists of 1 / (60 + rank). A passage that several queries rank
highly rises to the top, and duplicates collapse. S3 Vectors is semantic only, so this is the available way to improve recall.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from .config import MAX_PASSAGE_CHARS, Settings

log = logging.getLogger(__name__)

RRF_K = 60


class SearchError(Exception):
    """The Knowledge Base could not be searched."""


@dataclass(frozen=True)
class Passage:
    source: str  # s3://bucket/key of the document
    text: str
    score: float | None

    @property
    def filename(self) -> str:
        return self.source.rsplit("/", 1)[-1] or "document"


def rrf_merge(rankings: list[list[Passage]], top_k: int) -> list[Passage]:
    """Merge ranked lists with Reciprocal Rank Fusion and drop duplicate passages."""
    fused: dict[tuple[str, str], float] = {}
    first_seen: dict[tuple[str, str], Passage] = {}
    for ranking in rankings:
        for rank, passage in enumerate(ranking, start=1):
            key = (passage.source, passage.text)
            fused[key] = fused.get(key, 0.0) + 1.0 / (RRF_K + rank)
            first_seen.setdefault(key, passage)
    ordered = sorted(fused, key=lambda k: fused[k], reverse=True)
    return [first_seen[k] for k in ordered[:top_k]]


class Searcher:
    """Searches one project of one user. Create one per request."""

    def __init__(
        self,
        client: Any,
        settings: Settings,
        project_id: str,
        owner_id: str,
        rewrite: Callable[[str], list[str]] | None = None,
    ) -> None:
        self._client = client
        self._settings = settings
        self._filter = {
            "andAll": [
                {"equals": {"key": "project_id", "value": project_id}},
                {"equals": {"key": "owner_id", "value": owner_id}},
            ]
        }
        self._rewrite = rewrite

    def _retrieve(self, query: str) -> list[Passage]:
        try:
            response = self._client.retrieve(
                knowledgeBaseId=self._settings.knowledge_base_id,
                retrievalQuery={"text": query},
                retrievalConfiguration={
                    "vectorSearchConfiguration": {"numberOfResults": self._settings.top_k, "filter": self._filter}
                },
            )
        except (ClientError, BotoCoreError) as exc:
            raise SearchError(f"Retrieve failed: {exc}") from exc
        passages = []
        for item in response.get("retrievalResults", []):
            text = item.get("content", {}).get("text") or ""
            source = item.get("location", {}).get("s3Location", {}).get("uri") or ""
            score = item.get("score")
            if not text.strip() or not source:
                continue
            if score is not None and score < self._settings.min_score:
                continue
            passages.append(Passage(source=source, text=text[:MAX_PASSAGE_CHARS], score=score))
        return passages

    def search(self, query: str, strategy: str) -> list[Passage]:
        """`basic`: one search. `multi_query`: the query and its rewrites, searched in parallel and fused."""
        queries = [query]
        if strategy == "multi_query" and self._rewrite is not None:
            queries = self._rewrite(query)
        if len(queries) == 1:
            return self._retrieve(queries[0])[: self._settings.top_k]
        with ThreadPoolExecutor(max_workers=len(queries)) as pool:
            rankings = list(pool.map(self._retrieve, queries))
        return rrf_merge(rankings, self._settings.top_k)


class Evidence:
    """The passages found during one question. Numbers each document, so the model can cite [1], [2] and the UI can list them.

    Thread-safe: the agent framework may run several tool calls at once.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._numbers: dict[str, int] = {}
        self._best: dict[str, Passage] = {}

    @property
    def found(self) -> bool:
        with self._lock:
            return bool(self._numbers)

    def add(self, passages: list[Passage]) -> list[tuple[int, Passage]]:
        """Record passages and return them with their document number."""
        numbered = []
        with self._lock:
            for passage in passages:
                number = self._numbers.setdefault(passage.source, len(self._numbers) + 1)
                best = self._best.get(passage.source)
                if best is None or (passage.score or 0) > (best.score or 0):
                    self._best[passage.source] = passage
                numbered.append((number, passage))
        return numbered

    def citations(self) -> list[dict]:
        """One entry per document, in citation-number order: its best passage as the snippet."""
        with self._lock:
            ordered = sorted(self._numbers, key=lambda source: self._numbers[source])
            return [{"source": s, "snippet": self._best[s].text[:500], "score": self._best[s].score} for s in ordered]


def format_for_model(numbered: list[tuple[int, Passage]]) -> str:
    """Passages as quoted data. The closing tag is neutralised inside the text so a document cannot break out of its quote."""
    blocks = []
    for number, passage in numbered:
        safe = passage.text.replace("</passage", "<\\/passage")
        blocks.append(f'<passage number="{number}" file="{passage.filename}">\n{safe}\n</passage>')
    return "\n".join(blocks)
