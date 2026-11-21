"""Ingest Lambda: claim the record once, send the right request to Bedrock, never trust the S3 key for ownership."""

from __future__ import annotations

import boto3
import handler
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

PID = "11111111-1111-1111-1111-111111111111"
DID = "22222222-2222-2222-2222-222222222222"
KEY = f"projects/{PID}/{DID}/report.pdf"


class FakeBedrock:
    def __init__(self):
        self.calls: list[dict] = []
        self.error: Exception | None = None
        self.detail_status = "STARTING"

    def ingest_knowledge_base_documents(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return {"documentDetails": [{"status": self.detail_status, "statusReason": "because"}]}


@pytest.fixture
def env(monkeypatch):
    for k, v in {
        "AWS_ACCESS_KEY_ID": "t",
        "AWS_SECRET_ACCESS_KEY": "t",
        "AWS_DEFAULT_REGION": "us-east-1",
        "TABLE_NAME": "t",
        "KNOWLEDGE_BASE_ID": "KB1",
        "DATA_SOURCE_ID": "DS1",
    }.items():
        monkeypatch.setenv(k, v)
    handler._table.cache_clear()
    handler._bedrock.cache_clear()


@pytest.fixture
def table(env):
    with mock_aws():
        resource = boto3.resource("dynamodb")
        resource.create_table(
            TableName="t",
            AttributeDefinitions=[{"AttributeName": "PK", "AttributeType": "S"}, {"AttributeName": "SK", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}],
            BillingMode="PAY_PER_REQUEST",
        )
        yield resource.Table("t")
    handler._table.cache_clear()


@pytest.fixture
def bedrock(monkeypatch):
    fake = FakeBedrock()
    monkeypatch.setattr(handler, "_bedrock", lambda: fake)
    return fake


def put_doc(table, status="PENDING_UPLOAD", filename="report.pdf", owner="alice"):
    table.put_item(
        Item={
            "PK": f"PROJECT#{PID}",
            "SK": f"DOC#{DID}",
            "doc_id": DID,
            "project_id": PID,
            "owner_id": owner,
            "filename": filename,
            "status": status,
            "ttl": 1234567890,
        }
    )


def event(key=KEY, name="ObjectCreated:Post"):
    return {"Records": [{"eventName": name, "s3": {"bucket": {"name": "docs"}, "object": {"key": key}}}]}


def record(table):
    return table.get_item(Key={"PK": f"PROJECT#{PID}", "SK": f"DOC#{DID}"})["Item"]


def test_happy_path(table, bedrock):
    put_doc(table)

    assert handler.main(event()) == {"started": 1}

    saved = record(table)
    assert saved["status"] == "INGESTING" and "ttl" not in saved  # expiry removed, the record survives
    (call,) = bedrock.calls
    assert call["knowledgeBaseId"] == "KB1" and call["dataSourceId"] == "DS1" and call["clientToken"] == DID
    document = call["documents"][0]
    assert document["content"]["s3"]["s3Location"]["uri"] == f"s3://docs/{KEY}"
    attributes = {a["key"]: a["value"]["stringValue"] for a in document["metadata"]["inlineAttributes"]}
    assert attributes == {"project_id": PID, "owner_id": "alice", "doc_id": DID, "filename": "report.pdf"}


def test_duplicate_event_is_a_no_op(table, bedrock):
    put_doc(table)
    handler.main(event())
    assert handler.main(event()) == {"skipped": 1}
    assert len(bedrock.calls) == 1


@pytest.mark.parametrize("status", ["INGESTING", "READY", "FAILED"])
def test_already_handled_records_are_skipped(table, bedrock, status):
    put_doc(table, status=status)
    assert handler.main(event()) == {"skipped": 1}
    assert bedrock.calls == [] and record(table)["status"] == status


def test_object_without_record_is_ignored(table, bedrock):
    assert handler.main(event()) == {"skipped": 1}
    assert bedrock.calls == []
    assert table.scan()["Count"] == 0  # nothing was created by the claim


def test_unexpected_key_shapes_are_ignored(table, bedrock):
    for key in ("elsewhere/a/b/c.pdf", f"projects/{PID}/{DID}", "projects//x/y"):
        assert handler.main(event(key)) == {"ignored": 1}
    assert bedrock.calls == []


def test_url_encoded_key_is_decoded(table, bedrock):
    put_doc(table, filename="my report.pdf")
    handler.main(event(f"projects/{PID}/{DID}/my+report.pdf"))
    assert bedrock.calls[0]["documents"][0]["content"]["s3"]["s3Location"]["uri"].endswith("/my report.pdf")


def test_filename_mismatch_fails_the_record_and_skips_bedrock(table, bedrock):
    put_doc(table, filename="other.pdf")
    assert handler.main(event()) == {"mismatch": 1}
    assert bedrock.calls == [] and record(table)["status"] == "FAILED"


def test_owner_comes_from_the_record_not_the_key(table, bedrock):
    put_doc(table, owner="alice")
    handler.main(event(f"projects/{PID}/{DID}/report.pdf"))
    owners = {a["value"]["stringValue"] for a in bedrock.calls[0]["documents"][0]["metadata"]["inlineAttributes"]}
    assert "alice" in owners


def test_bedrock_error_marks_failed(table, bedrock):
    put_doc(table)
    bedrock.error = ClientError({"Error": {"Code": "ValidationException", "Message": "bad"}}, "IngestKnowledgeBaseDocuments")
    assert handler.main(event()) == {"failed": 1}
    saved = record(table)
    assert saved["status"] == "FAILED" and saved["failure_reason"].startswith("Indexing was rejected")


def test_immediate_failed_status_marks_failed(table, bedrock):
    put_doc(table)
    bedrock.detail_status = "FAILED"
    assert handler.main(event()) == {"failed": 1}
    assert record(table)["status"] == "FAILED"


def test_non_create_events_and_test_events_are_ignored(table, bedrock):
    assert handler.main(event(name="ObjectRemoved:Delete")) == {}
    assert handler.main({"Service": "Amazon S3", "Event": "s3:TestEvent"}) == {}
    assert bedrock.calls == []


def test_batch_of_records(table, bedrock):
    put_doc(table)
    two = event()
    two["Records"].append(event("junk/key")["Records"][0])
    assert handler.main(two) == {"started": 1, "ignored": 1}
