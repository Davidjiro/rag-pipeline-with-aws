"""Bedrock Knowledge Base operations: status of ingested documents, removal from the index, and test retrieval.

`KnowledgeBase` wraps the two boto3 clients. Routes depend on this small interface, and the tests replace it with a fake.

Status mapping (Bedrock document status -> application status):

    INDEXED                                       READY
    PARTIALLY_INDEXED, METADATA_PARTIALLY_INDEXED READY, with a warning (some content was skipped)
    FAILED, METADATA_UPDATE_FAILED, IGNORED       FAILED
    PENDING, STARTING, IN_PROGRESS                INGESTING
    NOT_FOUND                                     INGESTING for the first 5 minutes (not visible yet), then FAILED
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

log = logging.getLogger(__name__)

BATCH = 10  # the API accepts at most 10 document identifiers per call

_READY = {"INDEXED"}
_READY_WITH_WARNING = {"PARTIALLY_INDEXED", "METADATA_PARTIALLY_INDEXED"}
_FAILED = {"FAILED", "METADATA_UPDATE_FAILED", "IGNORED"}


class KnowledgeBaseError(Exception):
    """A Knowledge Base call failed. The API answers 502 and logs the cause."""


def map_status(bedrock_status: str, *, age_seconds: float, not_found_grace_seconds: float = 300) -> tuple[str, str | None]:
    """Translate a Bedrock status into (application status, optional warning)."""
    if bedrock_status in _READY:
        return "READY", None
    if bedrock_status in _READY_WITH_WARNING:
        return "READY", "Some content of this file could not be indexed."
    if bedrock_status in _FAILED:
        return "FAILED", None
    if bedrock_status == "NOT_FOUND" and age_seconds > not_found_grace_seconds:
        return "FAILED", None
    return "INGESTING", None


def _batches(items: list[Any]) -> Iterable[list[Any]]:
    for start in range(0, len(items), BATCH):
        yield items[start : start + BATCH]


class KnowledgeBase:
    def __init__(self, agent_client: Any, runtime_client: Any, knowledge_base_id: str, data_source_id: str) -> None:
        self._agent = agent_client
        self._runtime = runtime_client
        self._kb_id = knowledge_base_id
        self._ds_id = data_source_id

    @staticmethod
    def _identifier(s3_uri: str) -> dict:
        return {"dataSourceType": "S3", "s3": {"uri": s3_uri}}

    def statuses(self, s3_uris: list[str]) -> dict[str, str]:
        """Bedrock status per document URI. A URI the service did not report is absent from the result."""
        result: dict[str, str] = {}
        for batch in _batches(s3_uris):
            try:
                response = self._agent.get_knowledge_base_documents(
                    knowledgeBaseId=self._kb_id,
                    dataSourceId=self._ds_id,
                    documentIdentifiers=[self._identifier(u) for u in batch],
                )
            except (ClientError, BotoCoreError) as exc:
                raise KnowledgeBaseError(f"GetKnowledgeBaseDocuments failed: {exc}") from exc
            for detail in response.get("documentDetails", []):
                uri = detail.get("identifier", {}).get("s3", {}).get("uri")
                if uri:
                    result[uri] = detail.get("status", "")
        return result

    def delete_documents(self, s3_uris: list[str]) -> None:
        """Remove documents from the index. Raises KnowledgeBaseError so the caller does not delete the source file and
        leave orphaned vectors that still answer questions."""
        for batch in _batches(s3_uris):
            try:
                self._agent.delete_knowledge_base_documents(
                    knowledgeBaseId=self._kb_id,
                    dataSourceId=self._ds_id,
                    documentIdentifiers=[self._identifier(u) for u in batch],
                )
            except (ClientError, BotoCoreError) as exc:
                raise KnowledgeBaseError(f"DeleteKnowledgeBaseDocuments failed: {exc}") from exc

    def retrieve(self, query: str, project_id: str, owner_id: str, top_k: int) -> list[dict]:
        """Semantic search restricted to one project of one owner.

        The filter is built here from verified values, never from request input. Both conditions must hold, so a document of
        another user is excluded even if it somehow carried the same project id.
        """
        try:
            response = self._runtime.retrieve(
                knowledgeBaseId=self._kb_id,
                retrievalQuery={"text": query},
                retrievalConfiguration={
                    "vectorSearchConfiguration": {
                        "numberOfResults": top_k,
                        "filter": {
                            "andAll": [
                                {"equals": {"key": "project_id", "value": project_id}},
                                {"equals": {"key": "owner_id", "value": owner_id}},
                            ]
                        },
                    }
                },
            )
        except (ClientError, BotoCoreError) as exc:
            raise KnowledgeBaseError(f"Retrieve failed: {exc}") from exc
        results = []
        for item in response.get("retrievalResults", []):
            results.append(
                {
                    "text": item.get("content", {}).get("text", ""),
                    "source": item.get("location", {}).get("s3Location", {}).get("uri", ""),
                    "score": item.get("score"),
                }
            )
        return results
