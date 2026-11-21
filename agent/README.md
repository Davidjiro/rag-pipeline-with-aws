# agent/  -  the chat agent container (placeholder)

Runs on **Amazon Bedrock AgentCore Runtime**, which starts the container per session and talks to it on port 8080:

| Endpoint | Purpose |
|----------|---------|
| `POST /invocations` | the request |
| `GET /ping` | health check |

| File | Purpose |
|------|---------|
| `Dockerfile` | arm64 image (AgentCore Runtime runs ARM64), non-root user, port 8080 |
| `app/main.py` | **placeholder**: implements the HTTP contract with the Python standard library and returns a fixed reply |

## What the real agent will be

A Strands agent with one tool, `search_knowledge_base`, that calls `bedrock:Retrieve` with a metadata filter **built in code** from the trusted
`{user_id, project_id}` the API sends (never chosen by the model); the guardrail on input; streaming text then a citations event;
`basic` and `multi-query` retrieval. Configuration arrives as environment variables set by the CDK: `MODEL_ID`, `KNOWLEDGE_BASE_ID`,
`GUARDRAIL_ID`, `GUARDRAIL_VERSION`, `TOP_K`, `MAX_OUTPUT_TOKENS`, `AWS_REGION`. Credentials come from the runtime's execution role.
