"""boto3 clients, created once per container and shared by all requests.

Standard retry mode with 5 attempts absorbs throttling from Bedrock and DynamoDB. Timeouts are explicit so a slow dependency
fails the request instead of holding the Lambda until its own timeout.
"""

from __future__ import annotations

from functools import lru_cache

import boto3
from botocore.config import Config

from .config import get_settings

_RETRY = {"max_attempts": 5, "mode": "standard"}


@lru_cache
def dynamodb_table():
    """The single application table."""
    settings = get_settings()
    resource = boto3.resource("dynamodb", region_name=settings.region, config=Config(retries=_RETRY))
    return resource.Table(settings.table_name)


@lru_cache
def s3():
    """S3 client. Signature v4 is required for presigned POST and GET URLs.

    The regional endpoint matters: in us-east-1 boto3 otherwise signs URLs for the global host `<bucket>.s3.amazonaws.com`,
    and the web app's Content Security Policy allows only `<bucket>.s3.<region>.amazonaws.com`, so the browser would block
    every upload (found while building the web app; infra/lib/constructs/web-distribution.ts sets the policy).
    """
    settings = get_settings()
    config = Config(signature_version="s3v4", retries=_RETRY, s3={"us_east_1_regional_endpoint": "regional"})
    return boto3.client("s3", region_name=settings.region, config=config)


@lru_cache
def bedrock_agent():
    """Knowledge Base management API (document status and deletion)."""
    settings = get_settings()
    return boto3.client("bedrock-agent", region_name=settings.region, config=Config(retries=_RETRY))


@lru_cache
def bedrock_agent_runtime():
    """Knowledge Base query API (Retrieve)."""
    settings = get_settings()
    return boto3.client("bedrock-agent-runtime", region_name=settings.region, config=Config(retries=_RETRY))


@lru_cache
def agentcore():
    """AgentCore Runtime data plane. The read timeout covers a long streamed answer."""
    settings = get_settings()
    return boto3.client(
        "bedrock-agentcore",
        region_name=settings.region,
        config=Config(retries={"max_attempts": 2, "mode": "standard"}, read_timeout=120, connect_timeout=10),
    )
