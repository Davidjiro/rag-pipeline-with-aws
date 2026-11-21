# backend/ingest/  -  the S3-triggered ingest Lambda (placeholder)

`handler.py` is called by S3 for every object created under `projects/`. In this stage it only logs the bucket and key, which is what
`scripts/smoke-test.sh` looks for to prove the trigger works.

## What the real handler will do

1. read the document record from DynamoDB (`PK = PROJECT#<id>`, `SK = DOC#<id>`); ignore objects with no record;
2. set the status to `INGESTING`;
3. call `IngestKnowledgeBaseDocuments` with the S3 location and inline metadata (`project_id`, `owner_id`, `doc_id`, `filename`);
4. on failure, record `FAILED` with the reason.

It must be safe to run twice for the same object (S3 notifications are at least once). Environment: `TABLE_NAME`, `KNOWLEDGE_BASE_ID`, `DATA_SOURCE_ID`.
The owner always comes from the DynamoDB record, never from the object or its key.
