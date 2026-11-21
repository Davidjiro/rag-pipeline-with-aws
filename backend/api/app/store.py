"""All DynamoDB access. Key layout is defined in keys.py.

Every read of user data goes through a key that contains the owner or a project the owner was already verified to hold, so no
query can return another user's data. Ownership of a project is checked with a GetItem on `USER#<sub> / PROJECT#<id>`: if the
item is absent the project does not exist for that user (the API answers 404 either way).
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from . import keys

PENDING_UPLOAD = "PENDING_UPLOAD"
INGESTING = "INGESTING"
READY = "READY"
FAILED = "FAILED"

PENDING_TTL = timedelta(hours=2)
USAGE_TTL = timedelta(days=3)


def now() -> datetime:
    return datetime.now(UTC)


def iso(moment: datetime) -> str:
    return moment.isoformat(timespec="milliseconds")


def _is_conditional_failure(exc: ClientError) -> bool:
    return exc.response["Error"]["Code"] == "ConditionalCheckFailedException"


class Store:
    """Thin repository over the single table."""

    def __init__(self, table: Any) -> None:
        self.table = table

    # ---- generic helpers -------------------------------------------------------------------------------------------------

    def _query_all(self, pk: str, sk_prefix: str, **kwargs: Any) -> list[dict]:
        items: list[dict] = []
        params = {"KeyConditionExpression": Key("PK").eq(pk) & Key("SK").begins_with(sk_prefix), **kwargs}
        while True:
            page = self.table.query(**params)
            items.extend(page["Items"])
            if "LastEvaluatedKey" not in page:
                return items
            params["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    def _batch_delete(self, items: list[dict]) -> None:
        with self.table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})

    # ---- projects --------------------------------------------------------------------------------------------------------

    def create_project(self, user_id: str, name: str) -> dict:
        project_id = str(uuid.uuid4())
        item = {
            "PK": keys.user_pk(user_id),
            "SK": keys.project_sk(project_id),
            "entity": "project",
            "project_id": project_id,
            "owner_id": user_id,
            "name": name,
            "created_at": iso(now()),
        }
        self.table.put_item(Item=item, ConditionExpression="attribute_not_exists(PK)")
        return item

    def get_project(self, user_id: str, project_id: str) -> dict | None:
        """The ownership check. None means: not found, or not yours."""
        response = self.table.get_item(Key={"PK": keys.user_pk(user_id), "SK": keys.project_sk(project_id)})
        return response.get("Item")

    def list_projects(self, user_id: str) -> list[dict]:
        items = self._query_all(keys.user_pk(user_id), keys.PROJECT_PREFIX)
        return sorted(items, key=lambda i: i["created_at"], reverse=True)

    def delete_project_item(self, user_id: str, project_id: str) -> None:
        self.table.delete_item(Key={"PK": keys.user_pk(user_id), "SK": keys.project_sk(project_id)})

    def delete_project_records(self, project_id: str) -> None:
        """Delete documents, chats and every chat's messages of a project (not the project item itself)."""
        chats = self.list_chats(project_id)
        for chat in chats:
            self._batch_delete(self._query_all(keys.chat_pk(chat["chat_id"]), keys.MSG_PREFIX))
        self._batch_delete(chats)
        self._batch_delete(self.list_documents(project_id))

    # ---- documents -------------------------------------------------------------------------------------------------------

    def create_document(self, user_id: str, project_id: str, filename: str, content_type: str) -> dict:
        doc_id = str(uuid.uuid4())
        moment = now()
        item = {
            "PK": keys.project_pk(project_id),
            "SK": keys.doc_sk(doc_id),
            "entity": "document",
            "doc_id": doc_id,
            "project_id": project_id,
            "owner_id": user_id,
            "filename": filename,
            "content_type": content_type,
            "status": PENDING_UPLOAD,
            "created_at": iso(moment),
            "updated_at": iso(moment),
            # An upload that never completes disappears by itself. The ingest Lambda removes this attribute when the file arrives.
            "ttl": int((moment + PENDING_TTL).timestamp()),
        }
        self.table.put_item(Item=item)
        return item

    def get_document(self, project_id: str, doc_id: str) -> dict | None:
        response = self.table.get_item(Key={"PK": keys.project_pk(project_id), "SK": keys.doc_sk(doc_id)})
        return response.get("Item")

    def list_documents(self, project_id: str) -> list[dict]:
        items = self._query_all(keys.project_pk(project_id), keys.DOC_PREFIX)
        return sorted(items, key=lambda i: i["created_at"])

    def delete_document(self, project_id: str, doc_id: str) -> None:
        self.table.delete_item(Key={"PK": keys.project_pk(project_id), "SK": keys.doc_sk(doc_id)})

    def set_document_status(self, doc: dict, status: str, expected: str, warning: str | None = None) -> bool:
        """Move a document from `expected` to `status`. Returns False if another request already changed it."""
        names = {"#s": "status"}
        values: dict[str, Any] = {":new": status, ":exp": expected, ":now": iso(now())}
        expression = "SET #s = :new, updated_at = :now"
        if warning:
            expression += ", warning = :w"
            values[":w"] = warning
        try:
            self.table.update_item(
                Key={"PK": doc["PK"], "SK": doc["SK"]},
                UpdateExpression=expression,
                ConditionExpression="#s = :exp",
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
        except ClientError as exc:
            if _is_conditional_failure(exc):
                return False
            raise
        return True

    # ---- chats and messages ----------------------------------------------------------------------------------------------

    def create_chat(self, user_id: str, project_id: str, title: str, strategy: str) -> dict:
        chat_id = str(uuid.uuid4())
        item = {
            "PK": keys.project_pk(project_id),
            "SK": keys.chat_sk(chat_id),
            "entity": "chat",
            "chat_id": chat_id,
            "project_id": project_id,
            "owner_id": user_id,
            "title": title,
            "strategy": strategy,
            "created_at": iso(now()),
        }
        self.table.put_item(Item=item)
        return item

    def get_chat(self, project_id: str, chat_id: str) -> dict | None:
        response = self.table.get_item(Key={"PK": keys.project_pk(project_id), "SK": keys.chat_sk(chat_id)})
        return response.get("Item")

    def list_chats(self, project_id: str) -> list[dict]:
        items = self._query_all(keys.project_pk(project_id), keys.CHAT_PREFIX)
        return sorted(items, key=lambda i: i["created_at"], reverse=True)

    def set_chat_title(self, chat: dict, title: str) -> None:
        self.table.update_item(
            Key={"PK": chat["PK"], "SK": chat["SK"]},
            UpdateExpression="SET title = :t",
            ExpressionAttributeValues={":t": title},
        )

    def delete_chat(self, project_id: str, chat_id: str) -> None:
        self._batch_delete(self._query_all(keys.chat_pk(chat_id), keys.MSG_PREFIX))
        self.table.delete_item(Key={"PK": keys.project_pk(project_id), "SK": keys.chat_sk(chat_id)})

    def add_exchange(self, chat_id: str, question: str, answer: str, citations: list[dict]) -> dict:
        """Save the question and its answer together. Called only after the answer completed."""
        moment = now()
        question_item = self._message_item(chat_id, "user", question, [], moment)
        answer_item = self._message_item(chat_id, "assistant", answer, citations, moment + timedelta(milliseconds=1))
        with self.table.batch_writer() as batch:
            batch.put_item(Item=question_item)
            batch.put_item(Item=answer_item)
        return answer_item

    @staticmethod
    def _message_item(chat_id: str, role: str, text: str, citations: list[dict], moment: datetime) -> dict:
        message_id = str(uuid.uuid4())
        created_at = iso(moment)
        return {
            "PK": keys.chat_pk(chat_id),
            "SK": keys.message_sk(created_at, message_id),
            "entity": "message",
            "message_id": message_id,
            "role": role,
            "text": text,
            # Stored as JSON text: DynamoDB numbers are Decimals, and the citation score is a float.
            "citations_json": json.dumps(citations),
            "created_at": created_at,
        }

    def list_messages(self, chat_id: str, limit: int | None = None) -> list[dict]:
        """Messages in time order. With `limit`, the most recent `limit` messages (still in time order)."""
        if limit is None:
            return self._query_all(keys.chat_pk(chat_id), keys.MSG_PREFIX)
        page = self.table.query(
            KeyConditionExpression=Key("PK").eq(keys.chat_pk(chat_id)) & Key("SK").begins_with(keys.MSG_PREFIX),
            ScanIndexForward=False,
            Limit=limit,
        )
        return list(reversed(page["Items"]))

    # ---- daily question cap ----------------------------------------------------------------------------------------------

    def consume_question(self, user_id: str, cap: int) -> bool:
        """Count one question against today's cap. One atomic conditional write, so concurrent requests cannot exceed the cap."""
        moment = now()
        try:
            self.table.update_item(
                Key={"PK": keys.user_pk(user_id), "SK": keys.usage_sk(moment.strftime("%Y-%m-%d"))},
                UpdateExpression="ADD #c :one SET #t = :ttl",
                ConditionExpression="attribute_not_exists(#c) OR #c < :cap",
                ExpressionAttributeNames={"#c": "questions", "#t": "ttl"},
                ExpressionAttributeValues={":one": 1, ":cap": cap, ":ttl": int((moment + USAGE_TTL).timestamp())},
            )
        except ClientError as exc:
            if _is_conditional_failure(exc):
                return False
            raise
        return True
