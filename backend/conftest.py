"""Shared test fixtures: a fake AWS (moto) for DynamoDB and S3, fakes for Bedrock and AgentCore, and an authenticated client.

Nothing here touches real AWS. Bedrock and AgentCore are replaced by small fakes that record their calls, so the tests can assert
exactly what the API sent (filters, payloads, identifiers).
"""

import os

import boto3
import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from moto import mock_aws

ENV = {
    "AWS_ACCESS_KEY_ID": "test",
    "AWS_SECRET_ACCESS_KEY": "test",  # noqa: S105
    "AWS_DEFAULT_REGION": "us-east-1",
    "AWS_REGION": "us-east-1",
    "TABLE_NAME": "test-table",
    "DOCS_BUCKET": "test-docs",
    "DOCS_PREFIX": "projects/",
    "KNOWLEDGE_BASE_ID": "KBTEST1234",
    "DATA_SOURCE_ID": "DSTEST1234",
    "AGENT_RUNTIME_ARN": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test",
    "COGNITO_USER_POOL_ID": "us-east-1_TESTPOOL",
    "COGNITO_CLIENT_ID": "testclient",
    "MAX_FILE_MB": "1",
    "MAX_DOCUMENTS_PER_PROJECT": "3",
    "MAX_QUESTION_CHARS": "200",
    "DAILY_QUESTION_CAP": "3",
    "HISTORY_MESSAGES": "4",
    "TOP_K": "5",
}


@pytest.fixture(autouse=True)
def environment(monkeypatch):
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    from app import clients, config

    config.get_settings.cache_clear()
    for fn in (clients.dynamodb_table, clients.s3, clients.bedrock_agent, clients.bedrock_agent_runtime, clients.agentcore):
        fn.cache_clear()
    yield
    config.get_settings.cache_clear()


@pytest.fixture
def aws(environment):
    """A fake DynamoDB table and S3 bucket, shaped like the ones the CDK creates."""
    with mock_aws():
        boto3.resource("dynamodb").create_table(
            TableName=ENV["TABLE_NAME"],
            AttributeDefinitions=[{"AttributeName": "PK", "AttributeType": "S"}, {"AttributeName": "SK", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}],
            BillingMode="PAY_PER_REQUEST",
        )
        boto3.client("s3").create_bucket(Bucket=ENV["DOCS_BUCKET"])
        yield


class FakeKb:
    """Stands in for app.kb.KnowledgeBase."""

    def __init__(self):
        self.status_by_uri: dict[str, str] = {}
        self.deleted: list[list[str]] = []
        self.status_calls: list[list[str]] = []
        self.retrieve_calls: list[tuple] = []
        self.results: list[dict] = []
        self.fail_delete = False
        self.fail_status = False

    def statuses(self, uris):
        from app.kb import KnowledgeBaseError

        self.status_calls.append(list(uris))
        if self.fail_status:
            raise KnowledgeBaseError("boom")
        return {u: self.status_by_uri[u] for u in uris if u in self.status_by_uri}

    def delete_documents(self, uris):
        from app.kb import KnowledgeBaseError

        if self.fail_delete:
            raise KnowledgeBaseError("boom")
        self.deleted.append(list(uris))

    def retrieve(self, query, project_id, owner_id, top_k):
        self.retrieve_calls.append((query, project_id, owner_id, top_k))
        return self.results


class FakeAgent:
    """Stands in for app.agent.AgentClient. `script` is the list of events (or an exception) to produce."""

    def __init__(self):
        self.calls: list[tuple[dict, str]] = []
        self.script: list[dict] | Exception = [{"type": "token", "text": "An answer."}]

    def stream(self, payload, session_id):
        self.calls.append((payload, session_id))
        if isinstance(self.script, Exception):
            raise self.script
        yield from self.script


@pytest.fixture
def kb():
    return FakeKb()


@pytest.fixture
def agent():
    return FakeAgent()


class UserClient:
    """A TestClient that acts as a chosen user. Switch with `as_user("bob")`."""

    def __init__(self, client):
        self.client = client
        self.user = "alice"

    def as_user(self, name: str):
        self.user = name
        return self

    def request(self, method, url, **kwargs):
        headers = {"x-test-user": self.user, **kwargs.pop("headers", {})}
        return self.client.request(method, f"/api{url}", headers=headers, **kwargs)

    def get(self, url, **kw):
        return self.request("GET", url, **kw)

    def post(self, url, **kw):
        return self.request("POST", url, **kw)

    def delete(self, url, **kw):
        return self.request("DELETE", url, **kw)


@pytest.fixture
def api(aws, kb, agent):
    from app import auth, deps
    from app.main import app

    def fake_user(request: Request) -> str:
        return request.headers["x-test-user"]

    app.dependency_overrides[auth.current_user] = fake_user
    app.dependency_overrides[deps.get_kb] = lambda: kb
    app.dependency_overrides[deps.get_agent] = lambda: agent
    yield UserClient(TestClient(app))
    app.dependency_overrides.clear()


@pytest.fixture
def store(aws):
    from app import clients
    from app.store import Store

    return Store(clients.dynamodb_table())


@pytest.fixture
def s3(aws):
    return boto3.client("s3")


def pytest_configure(config):
    os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
