# backend/ingest/  -  the S3-triggered ingest Lambda

`handler.py` is called by S3 for every object created under `projects/`. Key layout: `projects/<project_id>/<doc_id>/<filename>`.

For each object:

1. read the document record the API created when it issued the upload (`PK = PROJECT#<project_id>`, `SK = DOC#<doc_id>`);
2. move it from `PENDING_UPLOAD` to `INGESTING` in one conditional write, and remove its `ttl` so the record is kept;
3. call `IngestKnowledgeBaseDocuments` with the S3 location and inline metadata `project_id`, `owner_id`, `doc_id`, `filename`;
4. if Bedrock rejects the request, set `FAILED` with a short reason.

Safety properties, each covered by a test:

- **Safe to run twice.** S3 delivers events at least once. Step 2 succeeds only once, and the Bedrock `clientToken` is the document id.
- **The owner comes from the database record,** never from the object or its key. An object with no record is ignored, and one whose file name differs from the record is marked `FAILED`.
- **Least privilege.** The role can start ingestion, read and update document items, and write its own logs. It cannot read the bucket contents; Bedrock reads the file with the Knowledge Base's own role.

Environment: `TABLE_NAME`, `KNOWLEDGE_BASE_ID`, `DATA_SOURCE_ID`. Only `handler.py` is deployed; `tests/` is excluded from the package.
