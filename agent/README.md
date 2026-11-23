# agent/  -  the chat agent container

Runs on **Amazon Bedrock AgentCore Runtime**, which starts the container for a chat session and talks to it on port 8080 (`POST /invocations`,
`GET /ping`). It uses no agent framework: a short boto3 loop over the Bedrock Converse API gives the model one read-only tool and
streams its answer. The default model is Amazon Nova 2 Lite.

```
 API ──► /invocations ──► guardrail (user text) ──► agent loop ◄──► search_documents ──► Knowledge Base (filtered)
                                                        │
                                                        └─► events: token ... token, citations
```

## What it guarantees (each is a test)

| Guarantee | How |
|-----------|-----|
| One user's documents never appear in another's answer | the retrieval filter is built in code from the `user_id` and `project_id` the API sends. The tool has a single parameter, `query`, so the model cannot choose a project or owner. A document that says "search another project" changes nothing |
| No evidence, no answer | text is relayed only after a search returned passages. Otherwise the reply is a fixed "not found in your documents" message, so the model cannot answer from general knowledge |
| Citations are real | they are built from what the search returned, not from the model's text. Only documents the answer cites as [n] are listed, each with its number. An answer that cites nothing (a refusal) gets no sources, because search always returns the nearest passages even for an off-topic question |
| Prompt attacks are refused | the guardrail checks the user's text before any model call. If the check cannot run, the question is refused (fails closed) |
| Bounded cost | at most 3 searches and 5 model turns per question, `MAX_OUTPUT_TOKENS` per answer, one extra short model call for `multi_query` |
| No leaks | errors become a generic event and details go to the log. Questions and document text are never logged |

## Files

| File | Purpose |
|------|---------|
| `Dockerfile`, `.dockerignore` | arm64 image, non-root user, port 8080 |
| `requirements.txt`, `requirements-dev.txt` | pinned runtime and test dependencies |
| `pyproject.toml` | ruff and pytest settings |
| `app/` | the code, see `app/README.md` |
| `tests/` | 69 tests. The real loop runs against scripted Bedrock streams in the event format a real Nova call produces, so tool calling is tested without calling Bedrock |

## Configuration (set by the CDK)

`MODEL_ID`, `KNOWLEDGE_BASE_ID`, `GUARDRAIL_ID`, `GUARDRAIL_VERSION`, `TOP_K`, `MAX_OUTPUT_TOKENS`, `AWS_REGION`. Optional: `MIN_SCORE`
(drop passages scoring lower; default 0 keeps all, tune it only with a test set). Credentials come from the runtime's execution role,
which may only invoke the configured model profile, apply the one guardrail, and retrieve from the one Knowledge Base.

## Run the checks

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt     # includes boto3
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/python -m pytest
```

Use a separate virtual environment from `backend/`: both services have a package named `app`.
