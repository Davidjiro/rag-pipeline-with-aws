"""Runtime configuration, read from environment variables.

The CDK sets every value (infra/lib/constructs/api-function.ts), so the same container image runs unchanged in dev and prod.
None of these values is a secret. Credentials come from the Lambda execution role, which boto3 picks up by itself.

`get_settings()` is cached for the life of the container. Tests call `get_settings.cache_clear()` after changing the environment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class Settings:
    """Everything the API needs to find its AWS dependencies and enforce its limits."""

    region: str
    table_name: str
    docs_bucket: str
    docs_prefix: str
    knowledge_base_id: str
    data_source_id: str
    agent_runtime_arn: str
    cognito_user_pool_id: str
    cognito_client_id: str
    max_file_mb: int
    allowed_extensions: tuple[str, ...]
    max_documents_per_project: int
    max_question_chars: int
    daily_question_cap: int
    history_messages: int
    top_k: int

    @property
    def max_file_bytes(self) -> int:
        return self.max_file_mb * 1024 * 1024

    @property
    def issuer(self) -> str:
        """The `iss` claim of every token from the user pool."""
        return f"https://cognito-idp.{self.region}.amazonaws.com/{self.cognito_user_pool_id}"

    @property
    def jwks_url(self) -> str:
        """Where the pool publishes the public keys that sign its tokens."""
        return f"{self.issuer}/.well-known/jwks.json"

    @classmethod
    def from_env(cls) -> Settings:
        """Read the settings. A missing required variable raises KeyError naming it, at the first request, not silently."""
        env = os.environ
        return cls(
            region=env.get("AWS_REGION") or env.get("AWS_DEFAULT_REGION") or "us-east-1",
            table_name=env["TABLE_NAME"],
            docs_bucket=env["DOCS_BUCKET"],
            docs_prefix=env.get("DOCS_PREFIX", "projects/"),
            knowledge_base_id=env["KNOWLEDGE_BASE_ID"],
            data_source_id=env["DATA_SOURCE_ID"],
            agent_runtime_arn=env["AGENT_RUNTIME_ARN"],
            cognito_user_pool_id=env["COGNITO_USER_POOL_ID"],
            cognito_client_id=env["COGNITO_CLIENT_ID"],
            max_file_mb=int(env.get("MAX_FILE_MB", "20")),
            allowed_extensions=tuple(
                e.strip().lower() for e in env.get("ALLOWED_EXTENSIONS", "pdf,txt,md,html,docx,csv").split(",") if e.strip()
            ),
            max_documents_per_project=int(env.get("MAX_DOCUMENTS_PER_PROJECT", "25")),
            max_question_chars=int(env.get("MAX_QUESTION_CHARS", "2000")),
            daily_question_cap=int(env.get("DAILY_QUESTION_CAP", "50")),
            history_messages=int(env.get("HISTORY_MESSAGES", "6")),
            top_k=int(env.get("TOP_K", "5")),
        )


@lru_cache
def get_settings() -> Settings:
    return Settings.from_env()
