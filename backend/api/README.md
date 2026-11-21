# backend/api/  -  FastAPI on Lambda

A container image: Python 3.13, FastAPI, and the **Lambda Web Adapter** extension, which turns each Lambda invocation into a normal HTTP request
to the app on the container's port 8080. The Function URL streams responses (`AWS_LWA_INVOKE_MODE=response_stream`).

| File | Purpose |
|------|---------|
| `Dockerfile` | arm64 image, adapter extension `0.9.1`, base image from the ECR Public mirror (avoids Docker Hub rate limits) |
| `requirements.txt` | pinned runtime dependencies |
| `app/` | the application, see `app/README.md` |
| `tests/` | API tests |

## Routes (all under `/api`; all but `health` need `Authorization: Bearer <access token>`)

| Method and path | Purpose |
|-----------------|---------|
| `GET /health` | no auth. Readiness check of the Lambda Web Adapter |
| `GET /projects`, `POST /projects` | list mine, create |
| `GET /projects/{pid}`, `DELETE /projects/{pid}` | read, delete with everything in it |
| `POST /projects/{pid}/files` | create the document record, return a presigned POST (body: `{"filename"}`) |
| `GET /projects/{pid}/files` | list documents; refreshes the status of those being indexed |
| `DELETE /projects/{pid}/files/{doc_id}` | remove from the index, S3 and the database |
| `POST /projects/{pid}/chats`, `GET .../chats` | create (`{"title"?, "strategy": "basic" or "multi_query"}`), list |
| `DELETE /projects/{pid}/chats/{cid}` | delete a chat and its messages |
| `GET /projects/{pid}/chats/{cid}/messages` | the conversation, citations with fresh download links |
| `POST /projects/{pid}/chats/{cid}/messages` | ask (`{"text"}`); the answer streams as Server-Sent Events |
| `POST /projects/{pid}/retrieve` | test retrieval: top passages and scores, no model call, not counted in the daily cap |

Errors: `401` bad token, `404` not found or not yours, `409` document limit, `422` invalid input, `429` daily cap, `502` Knowledge Base failure,
`503` sign-in keys unreachable.

Answer events (`data: <json>` lines, preceded by a `: keep-alive` comment): `token`, `citations`, `done`, `error`.

## Run it locally

Set the variables listed in `app/config.py`, then start `uvicorn app.main:app` from this folder. Without AWS credentials only `/api/health` works.
Inside Lambda the adapter forwards requests to the app; locally it is not involved.

```bash
docker build --platform linux/arm64 -t kc-api backend/api
```
