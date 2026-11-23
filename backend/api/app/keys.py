"""The single-table key layout and the S3 key layout, in ONE place.

DynamoDB (one table, generic keys `PK` and `SK`, see ARCHITECTURE.md section 8):

    entity       PK                SK                          read pattern
    ----------   ---------------   -------------------------   ----------------------------------------
    project      USER#<sub>        PROJECT#<project_id>        list my projects; GetItem = ownership check
    document     PROJECT#<pid>     DOC#<doc_id>                list a project's documents
    chat         PROJECT#<pid>     CHAT#<chat_id>              list a project's chats
    message      CHAT#<chat_id>    MSG#<timestamp>#<id>        read a chat in order
    usage        USER#<sub>        USAGE#<yyyy-mm-dd>          one counter per user per day (TTL)

S3: `projects/<project_id>/<doc_id>/<filename>`. The ingest Lambda parses the same layout; a contract test keeps the two in step.

WHY IDS ARE VALIDATED ELSEWHERE
    Every id that reaches a key is a UUID: FastAPI parses path parameters as `UUID`, and the server generates the rest.
    A user-supplied string never becomes part of a key except the file name,
    which `sanitize_filename` reduces to a safe set of characters.
"""

from __future__ import annotations

import re
import unicodedata

PROJECT_PREFIX = "PROJECT#"
DOC_PREFIX = "DOC#"
CHAT_PREFIX = "CHAT#"
MSG_PREFIX = "MSG#"
USAGE_PREFIX = "USAGE#"

# The file types the Knowledge Base parser reads, and the content type the upload must declare for each.
CONTENT_TYPES = {
    "pdf": "application/pdf",
    "txt": "text/plain",
    "md": "text/markdown",
    "html": "text/html",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "csv": "text/csv",
}

MAX_FILENAME_LENGTH = 100

# The ingest function stores each document's metadata (owner, project) in an object next to it, named `<file>` + this suffix.
# The Knowledge Base reads it from there. Users must never be able to upload an object with such a name.
METADATA_SUFFIX = ".metadata.json"


def user_pk(user_id: str) -> str:
    return f"USER#{user_id}"


def project_pk(project_id: str) -> str:
    return f"PROJECT#{project_id}"


def chat_pk(chat_id: str) -> str:
    return f"CHAT#{chat_id}"


def project_sk(project_id: str) -> str:
    return f"{PROJECT_PREFIX}{project_id}"


def doc_sk(doc_id: str) -> str:
    return f"{DOC_PREFIX}{doc_id}"


def chat_sk(chat_id: str) -> str:
    return f"{CHAT_PREFIX}{chat_id}"


def message_sk(timestamp: str, message_id: str) -> str:
    return f"{MSG_PREFIX}{timestamp}#{message_id}"


def usage_sk(day: str) -> str:
    return f"{USAGE_PREFIX}{day}"


def s3_key(docs_prefix: str, project_id: str, doc_id: str, filename: str) -> str:
    return f"{docs_prefix}{project_id}/{doc_id}/{filename}"


def project_s3_prefix(docs_prefix: str, project_id: str) -> str:
    return f"{docs_prefix}{project_id}/"


def parse_s3_key(docs_prefix: str, key: str) -> tuple[str, str, str] | None:
    """Split `<prefix><project_id>/<doc_id>/<filename>` into its three parts, or None if the key does not have that shape."""
    if not key.startswith(docs_prefix):
        return None
    parts = key[len(docs_prefix) :].split("/", 2)
    if len(parts) != 3 or not all(parts):
        return None
    return parts[0], parts[1], parts[2]


def extension_of(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def sanitize_filename(raw: str) -> str:
    """Reduce a user-supplied file name to a safe, short one that keeps its extension.

    - drops any directory part (`C:\\x\\y.pdf` and `../../y.pdf` both become `y.pdf`),
    - normalises Unicode, then replaces everything outside letters, digits, dot, dash and underscore with `_`,
    - collapses repeats, removes leading dots, and limits the length while keeping the extension.

    Raises ValueError if nothing usable remains or there is no extension.
    """
    name = unicodedata.normalize("NFKC", raw).replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    name = re.sub(r"_{2,}", "_", name).lstrip(".")
    if "." not in name:
        raise ValueError("The file name needs an extension, for example report.pdf.")
    stem, ext = name.rsplit(".", 1)
    stem = stem.strip("._-")[: MAX_FILENAME_LENGTH - len(ext) - 1]
    if not stem or not ext:
        raise ValueError("The file name is empty after cleaning.")
    return f"{stem}.{ext.lower()}"
