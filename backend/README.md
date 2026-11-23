# backend/  -  the application code that runs on Lambda

| Folder | Runs on | What it does |
|--------|---------|--------------|
| `api/` | Lambda (container image) behind a streaming Function URL | FastAPI: projects, uploads, file status, chats, streamed answers, test retrieval |
| `ingest/` | Lambda (zip), triggered by S3 `ObjectCreated` | starts indexing of each uploaded document, once |
| `tests/` | developer machine and CI | contract tests that tie the two together |

Design: `../ARCHITECTURE.md` sections 4 to 9.

## Run the checks

```bash
python3 -m venv .venv
.venv/bin/pip install -r api/requirements.txt -r requirements-dev.txt     # includes boto3
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/python -m pytest
```

The tests use no real AWS. DynamoDB and S3 are simulated by `moto`. Bedrock and AgentCore are replaced by small fakes that record every call,
so the tests can assert the exact retrieval filter, agent payload and index requests. `scripts/verify.sh` runs these checks as layer 8
(it uses `backend/.venv` when it exists).

| File | Purpose |
|------|---------|
| `pyproject.toml` | ruff (lint rules include security checks) and pytest settings |
| `requirements-dev.txt` | test and lint tools, never shipped in the Lambda image |
| `conftest.py` | shared fixtures: fake AWS, fake Bedrock, fake agent, a client that acts as a chosen user |

## What the tests prove

- **Authentication**: expired, wrong-issuer, wrong-client, ID-token, unsigned, wrong-algorithm and bad-signature tokens are all refused; a key-set outage gives 503, not 401.
- **Tenancy**: for every route under `/projects/{id}`, another user gets 404 and nothing changes. A chat of one project is not reachable through another.
- **Uploads**: the signed POST policy fixes the key, the content type and the size range. Unsupported types, path tricks and the per-project document limit are refused.
- **Indexing state**: every Bedrock document status maps to the right application status; a stuck document becomes `FAILED`.
- **Answers**: event order, nothing saved on failure, the daily cap (including that rejected requests do not use it up), citations restricted to the project, history limit.
- **Deletion**: index entries are removed first and a failure there stops everything else, so no searchable vectors outlive their source.
- **Ingest**: duplicate S3 events are harmless; the owner written to the index comes from the database record, never from the object key.
