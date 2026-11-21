"""PLACEHOLDER ingest Lambda.

Triggered by S3 `ObjectCreated` events under `projects/`. In the infrastructure stage it only logs what it receives, so the
trigger, the permissions and the environment can be verified. The real handler (look up the document record in DynamoDB,
mark it INGESTING, call IngestKnowledgeBaseDocuments with metadata) is implemented in the backend stage.

Environment: TABLE_NAME, KNOWLEDGE_BASE_ID, DATA_SOURCE_ID.
"""

import json
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def main(event, context):
    """Lambda entry point (handler is `handler.main`)."""
    records = event.get("Records", [])
    logger.info("placeholder ingest handler received %d record(s)", len(records))
    for record in records:
        logger.info(json.dumps({"bucket": record["s3"]["bucket"]["name"], "key": record["s3"]["object"]["key"]}))
    return {"processed": len(records), "placeholder": True}
