# backend/api/app/  -  the API package

Request path: `main.py` -> router in `routes/` -> dependencies in `deps.py` (authentication, ownership check) -> `store.py` (DynamoDB),
`kb.py` (Knowledge Base), `agent.py` (AgentCore), S3.

| Module | Responsibility |
|--------|----------------|
| `main.py` | assembles the routers; turns a Knowledge Base failure into a generic 502 |
| `config.py` | all settings from environment variables (set by the CDK); nothing secret |
| `auth.py` | verifies the Cognito access token: signature, issuer, expiry, token type, client id |
| `deps.py` | dependency providers, and `owned_project`, the check every project route goes through |
| `keys.py` | the DynamoDB and S3 key layout in one place, and file name sanitising |
| `store.py` | every DynamoDB read and write, including the atomic daily-cap counter |
| `kb.py` | document status, removal from the index, retrieval; maps Bedrock statuses to ours |
| `agent.py` | calls the AgentCore Runtime; defines the request and response contract with the agent |
| `citations.py` | keeps only citations that point into the caller's project, adds download links |
| `services.py` | work across stores: status refresh, cascading deletes |
| `sse.py` | Server-Sent Events formatting and parsing |
| `schemas.py` | request bodies and response shapes (internal attributes never leave the API) |
| `clients.py` | boto3 clients with retries and timeouts |
| `routes/` | `health`, `projects`, `files`, `chats`, `retrieve` |

## Agent contract (the agent stage implements the other side)

Request: `{"user_id", "project_id", "chat_id", "text", "history": [{"role","text"}], "strategy": "basic" | "multi_query"}`;
the runtime session id is the chat id.

Reply, either one JSON document `{"answer": "...", "citations": [{"source": "s3://...", "snippet": "...", "score": 0.5}]}` or an event stream of
`data: {"type":"token","text":"..."}` lines and one `data: {"type":"citations","citations":[...]}` line.
The API never trusts the citations: it keeps only objects under the caller's own project folder.
