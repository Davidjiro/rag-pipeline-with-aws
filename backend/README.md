# backend/  -  the application code that runs on Lambda

| Folder | Runs on | Status |
|--------|---------|--------|
| `api/` | Lambda (container image) behind a streaming Function URL | **placeholder**: health check only. Implemented in the backend stage |
| `ingest/` | Lambda (zip), triggered by S3 `ObjectCreated` | **placeholder**: logs the event. Implemented in the backend stage |

The infrastructure stage ships these placeholders so the images, the S3 trigger and the permissions can be built, deployed and checked
by `scripts/smoke-test.sh` before any real logic exists. See `../ARCHITECTURE.md` sections 4 and 5 for what they will do.
