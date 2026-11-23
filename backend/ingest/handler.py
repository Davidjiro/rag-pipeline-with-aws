"""Ingest Lambda: start indexing a document when its file lands in S3.

Trigger: S3 `ObjectCreated` events for keys under `projects/`. Key layout: `projects/<project_id>/<doc_id>/<filename>`.

For each uploaded object:
    1. read the key and look up the document record the API created when it issued the upload (PK PROJECT#<pid>, SK DOC#<id>)
    2. move the record PENDING_UPLOAD -> INGESTING with ONE conditional write, and remove its expiry (`ttl`) so the record
       survives. If the condition fails the record was already handled (S3 delivers events at least once), and nothing is done.
    3. write the document's metadata (`project_id`, `owner_id`, `doc_id`, `filename`) as `<key>.metadata.json` next to it
    4. call IngestKnowledgeBaseDocuments with the S3 locations of the file and of its metadata
    5. if Bedrock rejects the request, mark the record FAILED so the user sees the problem

WHY A METADATA FILE
    A Knowledge Base with an S3 data source rejects metadata sent inline in the ingest request ("You can only upload content
    and metadata from S3 if your knowledge base is connected to an S3 data source"). Found on the first real deployment.
    Writing the metadata object triggers this function again; that event is recognised by its suffix and ignored.

SECURITY
    The owner written into the metadata comes from the DynamoDB record that the API created for an authenticated user, never
    from the S3 object or its key. An object with no matching record, or whose file name differs from the record, is not
    indexed. Retrieval later filters on this metadata, so this is what keeps one user's passages away from another.

Environment: TABLE_NAME, KNOWLEDGE_BASE_ID, DATA_SOURCE_ID.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any
from urllib.parse import unquote_plus

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# The S3 notification is filtered to this prefix by the infrastructure.
# Keep in step with the API (keys.py); a contract test checks both values.
DOCS_PREFIX = "projects/"
METADATA_SUFFIX = ".metadata.json"

PENDING_UPLOAD = "PENDING_UPLOAD"
INGESTING = "INGESTING"
FAILED = "FAILED"

_RETRY = Config(retries={"max_attempts": 5, "mode": "standard"})


@lru_cache
def _table():
    return boto3.resource("dynamodb", config=_RETRY).Table(os.environ["TABLE_NAME"])


@lru_cache
def _bedrock():
    return boto3.client("bedrock-agent", config=_RETRY)


@lru_cache
def _s3():
    return boto3.client("s3", config=_RETRY)


def parse_key(key: str) -> tuple[str, str, str] | None:
    """`projects/<project_id>/<doc_id>/<filename>` -> (project_id, doc_id, filename), or None if the key has another shape."""
    if not key.startswith(DOCS_PREFIX):
        return None
    parts = key[len(DOCS_PREFIX) :].split("/", 2)
    if len(parts) != 3 or not all(parts):
        return None
    return parts[0], parts[1], parts[2]


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _claim(project_id: str, doc_id: str) -> dict | None:
    """Atomically move PENDING_UPLOAD -> INGESTING and drop the expiry. Returns the record, or None to skip it."""
    try:
        response = _table().update_item(
            Key={"PK": f"PROJECT#{project_id}", "SK": f"DOC#{doc_id}"},
            UpdateExpression="SET #s = :ingesting, updated_at = :now REMOVE #ttl",
            ConditionExpression="attribute_exists(PK) AND #s = :pending",
            ExpressionAttributeNames={"#s": "status", "#ttl": "ttl"},
            ExpressionAttributeValues={":ingesting": INGESTING, ":pending": PENDING_UPLOAD, ":now": _now()},
            ReturnValues="ALL_NEW",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return None
        raise
    return response["Attributes"]


def _mark_failed(doc: dict, reason: str) -> None:
    try:
        _table().update_item(
            Key={"PK": doc["PK"], "SK": doc["SK"]},
            UpdateExpression="SET #s = :failed, updated_at = :now, failure_reason = :why",
            ConditionExpression="#s = :ingesting",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":failed": FAILED, ":ingesting": INGESTING, ":now": _now(), ":why": reason[:200]},
        )
    except ClientError:
        logger.exception("Could not mark document %s as FAILED", doc.get("doc_id"))


def metadata_document(doc: dict) -> dict:
    """The Knowledge Base metadata file format: string attributes the retrieval filter matches on."""
    return {
        "metadataAttributes": {
            "project_id": doc["project_id"],
            "owner_id": doc["owner_id"],
            "doc_id": doc["doc_id"],
            "filename": doc["filename"],
        }
    }


def _ingest(doc: dict, bucket: str, key: str) -> None:
    metadata_key = key + METADATA_SUFFIX
    _s3().put_object(
        Bucket=bucket,
        Key=metadata_key,
        Body=json.dumps(metadata_document(doc)).encode("utf-8"),
        ContentType="application/json",
    )
    response = _bedrock().ingest_knowledge_base_documents(
        knowledgeBaseId=os.environ["KNOWLEDGE_BASE_ID"],
        dataSourceId=os.environ["DATA_SOURCE_ID"],
        clientToken=doc["doc_id"],  # makes a retried invocation of the same document a no-op
        documents=[
            {
                "content": {"dataSourceType": "S3", "s3": {"s3Location": {"uri": f"s3://{bucket}/{key}"}}},
                "metadata": {"type": "S3_LOCATION", "s3Location": {"uri": f"s3://{bucket}/{metadata_key}"}},
            }
        ],
    )
    for detail in response.get("documentDetails", []):
        if detail.get("status") in ("FAILED", "IGNORED", "METADATA_UPDATE_FAILED"):
            raise RuntimeError(detail.get("statusReason") or detail["status"])


def _process(bucket: str, raw_key: str) -> str:
    key = unquote_plus(raw_key)
    if key.endswith(METADATA_SUFFIX):
        return "metadata"  # the object this function wrote for a document: nothing to index
    parsed = parse_key(key)
    if parsed is None:
        logger.warning("Ignoring object with unexpected key shape")
        return "ignored"
    project_id, doc_id, filename = parsed

    doc = _claim(project_id, doc_id)
    if doc is None:
        logger.info("Document %s has no pending record (unknown or already handled); nothing to do", doc_id)
        return "skipped"
    if doc["filename"] != filename or doc["project_id"] != project_id:
        _mark_failed(doc, "The uploaded file does not match its record.")
        logger.warning("Document %s: key does not match the record", doc_id)
        return "mismatch"

    try:
        _ingest(doc, bucket, key)
    except (ClientError, BotoCoreError, RuntimeError) as exc:
        logger.error("Ingestion request failed for document %s: %s", doc_id, exc)
        _mark_failed(doc, f"Indexing was rejected: {type(exc).__name__}")
        return "failed"
    logger.info("Ingestion started for document %s", doc_id)
    return "started"


def main(event: dict[str, Any], context: Any = None) -> dict[str, int]:
    """Lambda entry point (handler is `handler.main`)."""
    outcomes: dict[str, int] = {}
    for record in event.get("Records", []):
        if not str(record.get("eventName", "")).startswith("ObjectCreated"):
            continue
        outcome = _process(record["s3"]["bucket"]["name"], record["s3"]["object"]["key"])
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
    logger.info("Processed: %s", outcomes)
    return outcomes
