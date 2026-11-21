"""Turn the sources an agent reports into safe citations.

The agent output is not trusted. A citation is kept only if its `source` is an object under THIS project's prefix in OUR bucket.
Anything else (another bucket, another project, a malformed value) is dropped, so a confused or manipulated agent cannot make
the API hand out a download link to a file the user does not own.

Stored form (in DynamoDB):  {"key", "filename", "snippet", "score"}
Returned form:              the stored form plus `url`, a presigned download link valid for 5 minutes.
"""

from __future__ import annotations

import re
from typing import Any
from uuid import UUID

from . import keys
from .config import Settings

SNIPPET_CHARS = 500
LINK_SECONDS = 300
MAX_CITATIONS = 20
_PLAIN_NAME = re.compile(r"[A-Za-z0-9._-]+")  # what keys.sanitize_filename produces


def _is_our_layout(parsed: tuple[str, str, str], project_id: str) -> bool:
    """The key must be exactly `<prefix><project_id>/<doc_id>/<file name>` with a UUID doc id and a plain file name."""
    key_project, doc_id, filename = parsed
    try:
        UUID(doc_id)
    except ValueError:
        return False
    return key_project == project_id and _PLAIN_NAME.fullmatch(filename) is not None


def sanitize(raw: Any, settings: Settings, project_id: str) -> list[dict]:
    """Keep only citations that point into this project, with bounded text."""
    if not isinstance(raw, list):
        return []
    bucket_uri = f"s3://{settings.docs_bucket}/"
    project_prefix = keys.project_s3_prefix(settings.docs_prefix, project_id)
    clean: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("source"), str):
            continue
        source = item["source"]
        if not source.startswith(bucket_uri):
            continue
        key = source[len(bucket_uri) :]
        parsed = keys.parse_s3_key(settings.docs_prefix, key)
        if not key.startswith(project_prefix) or parsed is None or key in seen or not _is_our_layout(parsed, project_id):
            continue
        seen.add(key)
        score = item.get("score")
        snippet = item.get("snippet")
        clean.append(
            {
                "key": key,
                "filename": parsed[2],
                "snippet": snippet[:SNIPPET_CHARS] if isinstance(snippet, str) else "",
                "score": float(score) if isinstance(score, int | float) else None,
            }
        )
        if len(clean) >= MAX_CITATIONS:
            break
    return clean


def with_links(citations: list[dict], s3_client: Any, bucket: str) -> list[dict]:
    """Add a presigned download link to each stored citation."""
    return [
        {
            **c,
            "url": s3_client.generate_presigned_url(
                "get_object", Params={"Bucket": bucket, "Key": c["key"]}, ExpiresIn=LINK_SECONDS
            ),
        }
        for c in citations
    ]
