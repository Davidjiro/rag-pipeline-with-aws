# Architecture: Bedrock Knowledge Chat

A web app where users create **projects**, **upload documents** into a project's knowledge base, and **chat** with an AI that answers
from those documents and cites its sources. Parsing, chunking, embedding and vector search are handled by Amazon Bedrock Knowledge Bases.
The agent runs on Amazon Bedrock AgentCore. Everything is deployed with TypeScript AWS CDK.

**Design goal: economical.** Nothing in this design bills by the hour. With no traffic the bill is a few cents.
Under normal use the cost is dominated by model tokens (section 11).

## Implementation status

| Stage | Scope | Status |
|-------|-------|--------|
| 1 | Architecture (this document) | done |
| 2 | **CDK infrastructure** (`infra/`), with placeholder application code so every image and asset builds | **done and verified**: format, types, unit tests, cdk-nag, cfn-lint, AWS template validation, local arm64 container checks. Deployed once to a development account, smoke-tested, then destroyed |
| 3 | **Backend** (`backend/`): FastAPI routes and the ingest Lambda | **done and verified**: 138 tests (auth, tenancy, uploads, indexing state, streaming, deletion, ingest) with simulated AWS, lint, arm64 image import check. Not yet exercised against real AWS |
| 4 | **Agent** (`agent/`): boto3 tool loop, search tool, streaming and citations | **done and verified**: 69 tests (the loop against scripted Bedrock streams in the real event format), lint, arm64 container checks. Deployed with the backend and tested end to end against real AWS and Nova 2 Lite: 39 of 39 checks passed (see below), then destroyed |
| 5 | **Web UI** (`web/`): React app | **done, local checks**: 49 tests, strict TypeScript, production build checked against the CSP. Browser test on a deployment pending |

- Building the UI found that boto3 signs us-east-1 upload links for the global S3 host, which the site's CSP blocks. The API now uses the regional endpoint.

### End-to-end test on a real deployment (39 checks, all passed)

The test is `scripts/e2e-test.py`. `.github/workflows/deploy-test.yml` runs it on demand: deploy, smoke test, end-to-end test, teardown, through a
GitHub OIDC role limited to this repository's `main` branch and to `dev` resources (`infra/lib/stacks/ci-access-stack.ts`).


Run against a fresh `dev` deployment with two test users, then destroyed. Covered: sign-in and 401s; presigned uploads, the S3 size policy and the
reserved `.metadata.json` name; ingestion to `READY`; streamed answers through CloudFront (first byte about 0.3 s, a short answer in about 3 s,
several token events); citations whose `[n]` matches the text and whose download link works; history on a follow-up; `multi_query`; an off-topic
question (no general-knowledge answer, no sources); the prompt-attack guardrail; test retrieval; every cross-user access answered 404, and user B's
answers and retrieval never contained user A's document; file and project deletion leaving nothing in the index or in S3.

### Findings during implementation (all reflected in this document)

- A new AWS account has a Lambda concurrency quota of 10, which makes **reserved concurrency fail to deploy**. It is therefore optional.
- The `ingest` Lambda uses Python 3.15: it satisfies the cdk-nag runtime rule, and AWS's CloudFormation schema lists it.
- With the default `*.cloudfront.net` certificate, CloudFront fixes TLS 1.0 as the minimum viewer version. Only a custom domain fixes that.
- AgentCore and Lambda helpers create log groups outside CloudFormation, which `cdk destroy` leaves behind. `scripts/teardown.sh` removes them.
- On the first real deployment: `IngestKnowledgeBaseDocuments` and `DeleteKnowledgeBaseDocuments` are authorised as `bedrock:StartIngestionJob` too, so both roles need it.
- A Knowledge Base with an S3 data source rejects inline metadata. Metadata is written as a `<file>.metadata.json` object next to each document.
- Anthropic models refuse every call until a one-time per-account use-case form is submitted, even when the model shows as `ACTIVE`. The default model is therefore Amazon Nova 2 Lite, which needs no form. `preflight.sh` checks the form when an Anthropic model is chosen.
- Nova may wrap reasoning in `<thinking>` tags around tool calls. The agent removes them from the streamed answer.
- Semantic search always returns the nearest passages, even for an off-topic question. Sources are therefore listed only when the answer cites them as `[n]`; a refusal shows none.

---

## 0. Cost-driven design choices

| Choice | Why | Effect |
|--------|-----|--------|
| **Hybrid search is out of scope** | it needs a vector store with a fixed monthly cost (OpenSearch Serverless or Aurora) | S3 Vectors stays. Strategies are `basic` and `multi-query` |
| **No API Gateway.** The API Lambda is exposed through a Function URL behind CloudFront | one fewer service and no per-request API fee. Lambda response streaming over a Function URL is a long-documented pattern | the JWT is checked in code. Throttling comes from optional Lambda concurrency limits and per-user caps |
| **No EventBridge or Step Functions** | an S3 event can call a Lambda directly. Status is checked when the UI lists files, so nothing polls in the background | fewer services and IAM roles |
| **No AgentCore Memory in v1** | DynamoDB already stores every chat message, so Memory would store the same turns twice | one resource fewer, no Memory billing |
| **No customer-managed KMS key** | a key has a monthly fee and needs a key policy. S3-managed encryption is free | SSE-S3 on buckets, AWS-owned key on DynamoDB |
| **One input guardrail check** | each filter bills per 1,000 characters checked. Grounding checks also bill on the source text | one prompt-attack filter on the input |
| **Minimal observability** | X-Ray, trace analytics and model-invocation logging cost extra | CloudWatch logs only, kept 7 days |
| **Single-table DynamoDB** | fewer resources to manage, same on-demand billing | one table |
| **Only `dev` is deployed** | `prod` stays as configuration in code | no duplicate resources |
| **512-dimension embeddings** | AWS reports 512-dimension Titan v2 vectors keep about 99% of the accuracy of 1024 | half the vector storage and query work |
| **`global.` model profile** | the global Nova 2 Lite list price is about 10% below the US-only profile | check data-residency needs (R9) |
| **Cost controls** | bound the worst case | per-user daily cap, upload limits, optional concurrency caps, budget alert, short agent idle timeout |

---

## 1. Managed services versus a hand-built RAG stack

| Concern | Typical hand-built stack | This project (AWS-managed) |
|---------|--------------------------|----------------------------|
| UI | single-page app with a hosted auth provider | React single-page app + Cognito |
| API | application server with background workers | FastAPI on Lambda, plus one small Lambda triggered by S3 (replaces the worker queue) |
| Metadata (projects, chats, files) | relational database | DynamoDB, one table |
| File storage | S3 | S3, also the Knowledge Base source |
| Parsing, chunking, summarising | parsing library and custom code | **Bedrock Knowledge Base** ingestion (parser and chunking are configuration) |
| Embeddings and vector store | external embedding API, Postgres with pgvector | **Titan Text Embeddings v2** in **S3 Vectors** |
| Retrieval | custom SQL: vector, keyword, weighted fusion, multi-query | **`Retrieve`** with a metadata filter. Multi-query and fusion run in the agent. No hybrid |
| LLM and agent | an agent framework inside the API process | **AgentCore Runtime** (a boto3 tool loop over the Converse API) + Amazon Nova 2 Lite on Bedrock |
| Safety | often none | **Bedrock Guardrails** (prompt-attack check) |
| Agent memory | custom tables | DynamoDB chat history, sent to the agent with each question |

**What a managed service gives up.** A hand-built pipeline can show each document's parsing and chunking steps and offer per-project tuning.
Bedrock runs those steps internally and does not expose them, so the UI shows a **document status** and a **"test retrieval" panel**
(what would the AI retrieve for this question?). Per-project embedding model and chunking settings, and keyword-versus-vector weights,
are not offered: they are properties of the shared Knowledge Base or of hybrid search.

---

## 2. Key decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | What "knowledge graph" means here | A **vector Knowledge Base** on S3 Vectors. GraphRAG (Neptune Analytics) is out: it has an always-on graph cost |
| D2 | Tenancy | **One shared Knowledge Base.** Every chunk carries `project_id` and `owner_id`, and the backend always adds the filter |
| D3 | Auth | **Cognito**, free tier, **invite-only** (an admin creates users, no public sign-up) so strangers cannot create accounts and run up model cost |
| D4 | UI hosting | **S3 + CloudFront**, built as a single-page app |
| D5 | Backend and front door | **FastAPI on Lambda** (Lambda Web Adapter), response streaming over a **Function URL**, reached through CloudFront at `/api/*`. No API Gateway |
| D6 | Chat history | **DynamoDB only.** The API sends the last few messages to the agent. No AgentCore Memory in v1 |
| D7 | Agent | **AgentCore Runtime**, no agent framework: a short boto3 loop over the Bedrock Converse API, so every event and failure path is visible and tested. One tool: search the Knowledge Base. No Gateway, no Memory in v1 |
| D8 | URL ingestion | Out of v1 |
| D9 | Retrieval strategies | `basic` (default) and `multi-query` (opt-in per project). **Hybrid and multi-query hybrid are out of scope** |

The other cost-driven choices in section 0 (SSE-S3 instead of KMS, one input guardrail, 512-dimension embeddings, the `global.` model profile,
only `dev` deployed) are easy to reverse if requirements change.

---

## 3. System overview

Read it top to bottom. Each band is one kind of component. Numbers are explained in the table below the picture.

```
              ┌────────────────────────────────────────────────────────────────────────────────────┐
  CLIENT      │ Browser: React app                                                                 │
              │ [ Projects ]    [ Upload documents + status ]    [ Chat with citations ]           │
              └─────────┬─────────────────────┬───────────────────────────────────────────┬────────┘
                        │                     │                                           │
                        │(1) app + API calls  │(2) sign in, get a JWT                     │(3) presigned upload
                        │                     │                                           │
                        ▼                     ▼                                           ▼
              ┌───────────────────┐ ┌───────────────────┐                       ┌───────────────────┐
  EDGE        │ CloudFront + S3   │ │ Cognito           │                       │ S3 docs bucket    │
              │ (web app, /api/*) │ │ (sign-in, JWT)    │                       │ (private, SSE-S3) │
              └─────────┬─────────┘ └───────────────────┘                       └─────────┬─────────┘
                        │(4) /api/* to the Function URL                                   │(5) ObjectCreated
                        ▼                                                                 ▼
              ┌────────────────────────────────────────────────────────────┐    ┌───────────────────┐
              │ API Lambda (FastAPI)   ◄──►   DynamoDB                     │    │ Ingest Lambda     │
  APPLICATION │ Function URL (public): JWT checked in code                 │    │ (S3 event; sets   │
              │ projects, files, chats, messages, retrieve                 │    │ DynamoDB status)  │
              └─────────────────────────┬──────────────────────────────────┘    └─────────┬─────────┘
                                        │(6) invoke agent, streaming                      │(7) ingest document
                                        │                                                 │
                                        ▼                                                 ▼
              ┌────────────────────────────────────────────────┐                ┌───────────────────┐
              │ AgentCore Runtime: the chat agent              │ (8) Retrieve   │ Bedrock Knowledge │
              │   ├ Guardrail (prompt-attack check)            │───────────────►│ Base (managed RAG)│
  AI SERVICES │   ├ Bedrock model (reasoning)                  │                │ parse/chunk/embed │
              │   └ tool: search_knowledge_base                │                └───────────────────┘
              └────────────────────────────────────────────────┘                          │(9) vectors
                                                                                          ▼
                                                                                ┌───────────────────┐
                                                                                │ S3 Vectors index  │
                                                                                │ + project metadata│
                                                                                └───────────────────┘
```

| # | What happens |
|---|--------------|
| 1 | The browser loads the web app from CloudFront and sends all API calls to the same domain under `/api/*`. |
| 2 | The user signs in with Cognito and receives a JWT. |
| 3 | The browser uploads a file straight to S3 with a short-lived presigned URL. The API never handles file bytes. |
| 4 | CloudFront forwards `/api/*` to the API Lambda's Function URL. The API Lambda verifies the JWT itself. |
| 5 | An uploaded object raises an `ObjectCreated` event that calls the Ingest Lambda directly. |
| 6 | For a question, the API Lambda checks the user owns the project, invokes the agent and streams the reply back. |
| 7 | The Ingest Lambda tells the Knowledge Base to ingest that one document. The KB reads the file from the docs bucket. |
| 8 | The agent calls `Retrieve` as a tool. The code adds the project filter, not the model. |
| 9 | The Knowledge Base writes and reads vectors and project metadata in the S3 Vectors index. |

The user's JWT is checked by the API Lambda only. File bytes go **straight from the browser to S3**.
There is no VPC, no NAT gateway and no VPC endpoint, because nothing here needs a private network. Those would be the biggest fixed costs.

---

## 4. Flow A: upload and ingest a document

```
       Browser              API Lambda               S3 docs                Ingest                 Bedrock
                                                     bucket                 Lambda             Knowledge Base
          │                      │                      │                      │                      │
          │ 1 upload-url         │                      │                      │                      │
          ├─────────────────────►┤                      │                      │                      │
          │                      │ 2 owner check        │                      │                      │
          │                      │ 3 save PENDING       │                      │                      │
          │ 4 presigned POST     │                      │                      │                      │
          ├◄─────────────────────┤                      │                      │                      │
          │ 5 upload the file (direct to S3)            │                      │                      │
          ├────────────────────────────────────────────►┤                      │                      │
          │                      │                      │ 6 ObjectCreated      │                      │
          │                      │                      ├─────────────────────►┤                      │
          │                      │                      │                      │ 7 status INGESTING   │
          │                      │                      │                      │ 8 Ingest document    │
          │                      │                      │                      ├─────────────────────►┤
          │                      │                      │                      │                      │ parse, chunk, embed,
          │                      │                      │                      │                      │ write vectors
          │                      │                      │                      │                      │
          │ 9 GET /files         │                      │                      │                      │
          ├─────────────────────►┤                      │                      │                      │
          │                      │ 10 INGESTING docs:   │                      │                      │
          │                      │ ask the KB           │                      │                      │
          │                      │ 11 GetKnowledgeBaseDocuments                │                      │
          │                      ├───────────────────────────────────────────────────────────────────►┤
          │                      │ INDEXED or FAILED    │                      │                      │
          │                      ├◄───────────────────────────────────────────────────────────────────┤
          │                      │ 12 save READY/FAILED │                      │                      │
          │ documents + status   │                      │                      │                      │
          ├◄─────────────────────┤                      │                      │                      │
```

| Step | What happens |
|------|--------------|
| 1-3 | The browser asks the API (through CloudFront) for an upload URL. The API checks that the JWT's user owns the project and that the file is within the limits (type, size, documents per project). It creates the document record with status `PENDING_UPLOAD`. |
| 4 | The API returns a presigned POST. Its conditions fix the file type, maximum size and the exact S3 key. |
| 5 | The browser uploads the file directly to S3. |
| 6 | S3 calls the Ingest Lambda directly with an `ObjectCreated` event. There is no workflow in between. |
| 7-8 | The Ingest Lambda sets the status to `INGESTING` and writes the metadata (`project_id`, `owner_id`, `doc_id`, `filename`) as `<file>.metadata.json` next to the file, then calls `IngestKnowledgeBaseDocuments` with both S3 locations. (A Knowledge Base with an S3 data source rejects inline metadata. The ingest function ignores the event its own metadata write causes, and the API refuses uploads with that suffix.) If that call fails, it records `FAILED` with the reason. Then it exits. It does not wait. |
| 9-12 | When the UI lists files, the API Lambda asks the Knowledge Base about documents still `INGESTING` (`GetKnowledgeBaseDocuments`) and saves `READY` or `FAILED`. A document stuck for more than 30 minutes becomes `FAILED (timed out)`. |

**Status shown in the UI:** `PENDING_UPLOAD` → `INGESTING` → `READY` or `FAILED`.

Design points:
- **No polling workflow.** Status is looked up only when someone is looking. A background poller would pay for transitions or invocations with nobody watching.
- **Direct ingestion, not a sync job.** `IngestKnowledgeBaseDocuments` indexes one document right away. AWS says not to run it at the same time as `StartIngestionJob`, so this project never uses sync jobs.
- **Burst control.** S3's asynchronous invocation queue holds a burst of uploads and retries, so nothing is lost. The Ingest Lambda can also be given a low reserved concurrency (2) to bound Knowledge Base calls. That is optional, because it needs a Lambda quota of at least 100 (see section 14, R6).
- **Why an S3 event, not a "confirm" call from the browser?** The event still fires if the browser tab closes after the upload. Records stuck in `PENDING_UPLOAD` expire with a DynamoDB TTL.
- **Delete** is the mirror image: `DeleteKnowledgeBaseDocuments`, then the S3 object, then the DynamoDB record. Deleting a project repeats that for each document.

---

## 5. Flow B: ask a question

```
       Browser              API Lambda             Chat agent              Knowledge            Bedrock model
                                                   (AgentCore)               Base                + Guardrail
          │                      │                      │                      │                      │
          │ 1 POST .../stream    │                      │                      │                      │
          ├─────────────────────►┤                      │                      │                      │
          │                      │ 2 owner check        │                      │                      │
          │                      │ 3 save user msg      │                      │                      │
          │                      │ load last N msgs     │                      │                      │
          │                      │ 4 InvokeAgentRuntime │                      │                      │
          │                      ├─────────────────────►┤                      │                      │
          │                      │                      │ 5 check input, then reason                  │
          │                      │                      ├────────────────────────────────────────────►┤
          │                      │                      │ 6 "search for: ..."  │                      │
          │                      │                      ├◄────────────────────────────────────────────┤
          │                      │                      │ 7 code adds filter:  │                      │
          │                      │                      │ project_id, owner_id │                      │
          │                      │                      │ 8 Retrieve + filter  │                      │
          │                      │                      ├─────────────────────►┤                      │
          │                      │                      │ 9 chunks + sources   │                      │
          │                      │                      ├◄─────────────────────┤                      │
          │                      │                      │ 10 write answer from chunks                 │
          │                      │                      ├────────────────────────────────────────────►┤
          │                      │                      │ tokens               │                      │
          │                      │                      ├◄────────────────────────────────────────────┤
          │                      │ 11 stream tokens     │                      │                      │
          │                      ├◄─────────────────────┤                      │                      │
          │ 12 SSE + links       │                      │                      │                      │
          ├◄─────────────────────┤                      │                      │                      │
          │                      │ 13 save answer       │                      │                      │
```

| Step | What happens |
|------|--------------|
| 1-3 | The browser posts the question. The API verifies the JWT, checks the user owns the project, checks the user's daily question cap, saves the user message and loads the last few messages of this chat. |
| 4 | The API invokes the agent on AgentCore Runtime with `{user_id, project_id, chat_id, text, history, strategy}`. The session id is the chat id. It starts streaming to the browser right away (a keep-alive line), so CloudFront does not time out while the agent starts. |
| 5 | The agent sends the text through the **input guardrail** to the Bedrock model. |
| 6 | The model replies that it needs evidence and asks for the search tool with some search words. |
| 7 | The agent's own code builds the filter from the trusted payload. The model never sees or controls it. |
| 8-9 | The agent calls `Retrieve` on the Knowledge Base with the query and the filter. It gets the top chunks, scores and source S3 URIs. |
| 10 | The model writes the answer from those chunks. |
| 11-12 | The agent streams text and then a citations event. The API relays them as Server-Sent Events and turns each source URI into a short-lived presigned link. |
| 13 | After the stream ends, the API saves the assistant message (text, citations) in DynamoDB. |

Design points:
- **The model never chooses the filter.** Steps 7 and 8 use the `project_id` and `owner_id` from the trusted payload the API built.
  The model only supplies the search words. This keeps one user's documents out of another user's answers (section 7).
- **Citations are structured data**, not text the model writes. The tool returns the source URI and chunk text, so the UI can show "[1] policy.pdf" with an "open" link.
- **No evidence, no answer.** If retrieval returns nothing relevant, the agent says it found nothing in the documents, instead of answering from general knowledge.
- **History is bounded.** Only the last few messages are sent to the agent. Long histories cost tokens on every question.

### Retrieval strategies: `basic` and `multi-query`

DynamoDB only stores app records (projects, document status, chats, messages). It holds no chunks and no vectors.
Those live in the Knowledge Base's vector store (S3 Vectors).

| Strategy | What the agent tool does | Cost of a question |
|----------|--------------------------|--------------------|
| `basic` (default) | one `Retrieve` call, top 5 chunks | baseline |
| `multi-query` (opt-in per project) | the model writes N rewrites of the question, N `Retrieve` calls in parallel with the same filter, merge and de-duplicate with Reciprocal Rank Fusion (RRF), keep the top 5 | one extra short model call, N times the retrievals |

```
 question
    │  the model writes N rewrites
    ▼
 N x Retrieve  (in parallel, same project filter)
    │
    ▼
 merge and de-duplicate (RRF)  ─►  top 5 chunks
```

- **Hybrid and multi-query hybrid are out of scope.** S3 Vectors is semantic only. Exact-term questions (IDs, codes, names) are where this shows up.
  If it matters later, it means a different vector store (D9, section 12).
- **Multi-query is not a Knowledge Base feature.** Bedrock's `QUERY_DECOMPOSITION` exists only on `RetrieveAndGenerate` and splits multi-part questions. The agent uses `Retrieve`, so it does multi-query itself.
- **Not carried over:** `vector_weight` and `keyword_weight` (they belong to hybrid). `similarity_threshold` becomes a score cutoff in the agent tool.
- **Reranking is off by default.** `Retrieve` can rerank, and a separate Rerank API can re-score merged multi-query results, but each rerank is another billed call. Add it only if a test set shows poor ordering.

---

## 6. Guardrail: where it applies

```
  user text ─► [ input guardrail: prompt-attack check ] ─► model ─► answer
```

One guardrail with one policy: the **prompt-attack** content filter, on the input. Each filter bills per 1,000 characters it checks,
so v1 checks only what users type, once per question.

| Risk | What covers it in v1 |
|------|----------------------|
| User tries to override the system prompt | the input guardrail |
| An uploaded document contains "ignore your instructions" (indirect prompt injection) | the prompt fences retrieved text as data, and the agent has **read-only tools**: it can only write answer text. It cannot change data or call other systems, so the damage is limited to a bad answer |
| Model invents facts | the "no evidence, no answer" rule and citations the user can open |

Not in v1, because they add per-character cost: output PII masking, a contextual-grounding check, and scanning retrieved chunks.

---

## 7. Security and multi-tenancy

```
   Browser ──(JWT)──► CloudFront ──► API Lambda ──(IAM, trusted payload)──► AgentCore Runtime ──► Bedrock KB
   UNTRUSTED                         verifies the JWT,     the ONLY caller          builds the filter
                                     checks owner in       of the runtime           from the payload
                                     DynamoDB
```

The rule: **identity comes from the verified JWT, never from the request body.** The API Lambda checks the token (signature using Cognito's
public keys, issuer, expiry, token type, client id), takes `user_id` from `sub`, checks the project belongs to that user in DynamoDB,
and only then calls the agent with `{user_id, project_id}`.

| Principal | May do | May NOT do |
|-----------|--------|-----------|
| **Browser (user)** | load the app, sign in, call the API with a JWT, upload to ONE presigned key, open ONE presigned link | reach S3, DynamoDB, Bedrock or the agent directly |
| **API Lambda** | read and write the DynamoDB table, presign S3 URLs, `InvokeAgentRuntime` on one runtime, `Retrieve` (test panel), get and delete Knowledge Base documents | call models directly, change IAM |
| **Ingest Lambda** | `IngestKnowledgeBaseDocuments`, update document items | read chats |
| **Agent execution role** | invoke the one chosen model, `ApplyGuardrail` on this guardrail, `Retrieve` on this Knowledge Base, write logs | read S3, S3 Vectors or DynamoDB |
| **Knowledge Base role** | read the docs bucket, embed with Titan, read and write its index | anything else |

Other controls:
- S3: block public access, SSL only, S3-managed encryption, presigned POST limits file type, size and key prefix. Presigned links expire in minutes.
- Cognito: invite-only, no public sign-up.
- The Function URL is public. Every route except a health check requires a valid JWT. Optional reserved concurrency can cap how much a flood costs,
  and a per-user daily cap limits legitimate overuse. Hardening for later: signed access from CloudFront only, and a WAF.
- Logs: API and agent logs in CloudWatch, 7-day retention. Do not log prompts or document text.
- The shared-KB design means **a bug in the filter code leaks across projects**. Mitigation: one function builds the filter, it is
  unit-tested, and an integration test uploads documents for two projects and asserts neither sees the other.

---

## 8. Data model (DynamoDB sketch, one table)

On-demand billing, no point-in-time recovery, TTL on short-lived items. Access patterns: list my projects, list a project's documents and chats, read a chat's messages in order, count a user's questions today.

| Entity | Partition key | Sort key | Main attributes |
|--------|---------------|----------|-----------------|
| Project | `USER#<sub>` | `PROJECT#<id>` | name, owner_id, created_at |
| Document | `PROJECT#<id>` | `DOC#<id>` | filename, content_type, owner_id, status, warning, failure_reason, created_at, updated_at, `ttl` while `PENDING_UPLOAD` |
| Chat | `PROJECT#<id>` | `CHAT#<id>` | title, strategy (`basic` or `multi_query`), owner_id, created_at |
| Message | `CHAT#<id>` | `MSG#<timestamp>#<id>` | role, text, citations (JSON text), created_at |
| Daily usage | `USER#<sub>` | `USAGE#<yyyy-mm-dd>` | questions, ttl 3 days |

Every request first reads the project item with `USER#<sub>` + `PROJECT#<id>`: that read is the ownership check, and it is a dependency of every
project route, so a route cannot skip it. Chats are addressed through their project (`/projects/{id}/chats/{chatId}`), which needs no secondary index.

Notes from the implementation:

- A document that is never uploaded expires through `ttl` (2 hours). The ingest function removes `ttl` in the same conditional write that moves the record to `INGESTING`, so an indexed document never expires. DynamoDB deletes expired items lazily, so `ttl` is never used for a security decision.
- The daily cap is one conditional `UpdateItem` (`ADD` while below the cap), so parallel requests cannot exceed it.
- Document status is refreshed when the file list is read, in batches of 10 (the API limit). `PARTIALLY_INDEXED` shows as `READY` with a warning, `NOT_FOUND` is treated as pending for 5 minutes and then as failed, and a document still indexing after 30 minutes is marked `FAILED`.
- Deleting a project removes its documents from the index first. If that fails the request stops with 502 and nothing else is deleted, so no vectors outlive their source file.

--------|---------------|----------|-----------------|
| Project | `USER#<sub>` | `PROJECT#<id>` | name, description, retrieval_strategy, created_at |
| Document | `PROJECT#<id>` | `DOC#<id>` | filename, s3_key, size, type, status, failure_reason, created_at, ttl while pending |
| Chat | `PROJECT#<id>` | `CHAT#<id>` | title, created_at |
| Message | `CHAT#<id>` | `MSG#<timestamp>#<id>` | role, content, citations |
| Daily usage | `USER#<sub>` | `USAGE#<yyyy-mm-dd>` | question_count, ttl 2 days |

Every request first reads the project item with `USER#<sub>` + `PROJECT#<id>`: that read is the ownership check.
(A sketch. The final key design is part of the next stage.)

---

## 9. API surface

All routes sit under `/api` and need `Authorization: Bearer <JWT>`.

| Method and path | Purpose |
|-----------------|---------|
| `GET /projects`, `POST /projects` | list, create |
| `GET /projects/{id}`, `DELETE /projects/{id}` | read, delete (index entries, files, records) |
| `POST /projects/{id}/files` | document record + presigned POST (type, size and key fixed by the signed policy) |
| `GET /projects/{id}/files` | list documents, refresh the status of those being indexed |
| `DELETE /projects/{id}/files/{docId}` | remove from the index, S3 and DynamoDB |
| `POST /projects/{id}/retrieve` | test retrieval: top passages and scores for a query (`basic` strategy, no model call) |
| `GET /projects/{id}/chats`, `POST /projects/{id}/chats` | list, create (the body picks the strategy) |
| `DELETE /projects/{id}/chats/{chatId}` | delete a chat and its messages |
| `GET /projects/{id}/chats/{chatId}/messages` | read the conversation |
| `POST /projects/{id}/chats/{chatId}/messages` | ask a question, stream the answer (SSE: `token`, `citations`, `done`, `error`) |
| `GET /health` | no auth, for monitoring |
| not planned: a browser "confirm upload" call, URL ingestion, a separate download-link route | the S3 event replaces the first; citations carry short-lived links |

The contract between the API and the agent (request payload, JSON or event-stream reply, and why citations are filtered) is in `backend/api/app/README.md`.

---

## 10. Infrastructure layout (CDK, TypeScript)

Layered as `config` → `props` → `constructs` → `stacks`. Six stacks:

```
 AuthStack ─────────────────────────────────────────────────────┐   user pool, app client (invite-only)
                                                                 ▼
 DataStack ──► KnowledgeStack ──► AgentStack ──► ApiStack ──► WebStack
 DynamoDB,     docs bucket, KB,   guardrail,     API Lambda,   S3 + CloudFront,
 budget alert  S3 Vectors,        AgentCore      Function URL  routes /api/*,
               ingest Lambda      Runtime                      runtime config
```

| Stack | Building blocks (constructs) |
|-------|------------------------------|
| auth | `InviteOnlyUserPool` |
| data | `AppTable`, `BudgetAlert` |
| knowledge | `SecureBucket`, `S3VectorKnowledgeBase`, `IngestFunction` |
| agent | `ChatGuardrail`, `ChatAgentRuntime` |
| api | `ApiFunction` |
| web | `WebDistribution` |

Environments: `dev` is deployable. `prod` exists as configuration only (`RETAIN`, termination protection, point-in-time recovery).

---

## 11. Cost

### 11.1 Where the money goes

Nothing bills by the hour. Idle cost is a few cents (S3 storage and vectors). What you pay is usage:

| Item | Billed by | Idle cost |
|------|-----------|-----------|
| **Model tokens (chat)** | tokens in and out | none |
| Guardrail | per 1,000 characters checked | none |
| AgentCore Runtime | memory held and CPU used per session | none |
| Knowledge Base ingestion | embedding tokens, once per document | none |
| S3 Vectors | storage and queries | cents |
| Lambda, DynamoDB, S3, CloudFront, Cognito | requests and storage, mostly inside free tiers at low volume | none or cents |
| CloudWatch logs | ingested GB, 7-day retention | none |

### 11.2 Levers already applied (initial values, all configurable)

| Lever | Value | Why |
|-------|-------|-----|
| Chat model | Amazon Nova 2 Lite, `global.` profile | low price per token, supports tool use, and needs no per-account use-case form (Anthropic models do), so a new account deploys with no manual step. Any `global.` profile can be set with `KC_MODEL_PROFILE_ID` |
| Embedding dimensions | 512 | half the vector size of 1024 |
| Chunk size | about 300 tokens, top 5 chunks | bounds the tokens sent to the model |
| History sent to the agent | last 6 messages | tokens grow with history |
| Max answer length | 1,024 tokens | caps output cost |
| Question length | 2,000 characters | caps input cost and guardrail cost |
| Daily cap per user | 50 questions | bounds a single account's spend |
| Upload limits | 20 MB per file, 25 documents per project, listed file types | bounds ingestion cost and storage |
| Default strategy | `basic` | multi-query adds a model call and more retrievals |
| Reranking | off | each rerank is another billed call |
| AgentCore idle timeout | 300 seconds (default is 900) | memory is billed while a session sits idle. CPU is not |
| AgentCore max session lifetime | 1 hour (default is 8 hours) | stops a stuck session from billing |
| Lambda reserved concurrency | optional: API 10, Ingest 2 | caps a flood and bounds Knowledge Base calls. **Off by default**: it fails to deploy when the account's Lambda quota is below 100 (a new account has 10) |
| Log retention | 7 days | small CloudWatch bill |
| Budget alert | in AWS Budgets, threshold in config | early warning (the first budgets are free) |

### 11.3 Worked estimate

Per 1,000 questions, `basic` strategy. **These are estimates built from the assumptions shown, not quotes.**

| Item | Assumption | About |
|------|------------|-------|
| Model tokens | 2 model calls per question, about 3,900 input and 410 output tokens in total. Nova 2 Lite at $0.30 per million input and $2.50 per million output tokens | $2.20 |
| Guardrail | about 2 text units per question at $0.15 per 1,000 text units (a text unit is up to 1,000 characters) | $0.30 |
| AgentCore Runtime | about 250 chat sessions, 1 GB held about 7 minutes each, at $0.00945 per GB-hour, plus a little CPU | $0.30 to $0.50 |
| API Lambda | about 25 s at 0.5 GB per question | about $0.21, usually inside the free tier |
| S3 Vectors queries | $2.50 per million queries plus processing | under $0.01 |
| DynamoDB, S3, CloudFront, Cognito, logs | free tiers or cents | under $0.50 |
| **Total** | | **about $3 to $4 per 1,000 questions** |

Other numbers:
- `multi-query` adds about $0.50 per 1,000 questions (one extra short model call), plus more retrievals that cost almost nothing.
- With Claude Haiku 4.5 instead ($1 and $5 per million tokens) model tokens are about $5.95, for a total of about $7 to $8.
- Ingestion is a one-time cost of about $0.02 per million tokens (Titan v2). 100 MB of text is roughly 25 million tokens, so about $0.50.
- Vector storage for that corpus is about 0.3 GB at $0.06 per GB-month: cents.
- With no questions at all the bill is a few cents a month.

Sources, as quoted: Bedrock pricing page (Guardrails per text unit); AWS Builder Center article on AgentCore Runtime billing (v1 rates);
a third-party article quoting AWS examples for S3 Vectors; public price trackers for Nova 2 Lite ($0.30 and $2.50, global profile; the US-only profile is listed about 10% higher) and Haiku 4.5 ($1 and $5);
the AWS Titan v2 launch post (price, and 512 dimensions keeping about 99% of accuracy). **Confirm on the AWS pricing pages and the Pricing Calculator before relying on any figure.**

### 11.4 What would make the bill jump

A larger chat model, `multi-query` as the default, long histories or large top-K, a hybrid-capable store (OpenSearch Serverless or Aurora),
GraphRAG, a VPC with NAT or endpoints, WAF, customer-managed KMS keys, X-Ray and model-invocation logging, long AgentCore idle timeouts,
and an unprotected public endpoint that gets flooded. Each is either excluded or capped above.

---

## 12. Out of scope for v1

Hybrid search and multi-query hybrid (D9), GraphRAG, output and grounding guardrails, reranking by default, AgentCore Memory (long-term facts),
AgentCore Gateway tools, AgentCore Identity, URL crawling, WAF, custom domain, X-Ray and trace analytics, model-invocation logging,
`prod` deployment, CI/CD pipeline, malware scanning of uploads, private networking, automated answer-quality evaluation.

If hybrid ever becomes a requirement, the options are OpenSearch Serverless, Aurora PostgreSQL (AWS announced hybrid support in April 2025,
to be confirmed), or the newer Bedrock Managed Knowledge Base, whose pricing page lists hybrid search in standard retrieval. Documents stay in S3,
so switching store means a new Knowledge Base and a re-ingest, not a re-upload.

---

## 13. Alternatives considered and left out

| Option | Why not for v1 |
|--------|----------------|
| API Gateway in front of the API Lambda | works, but adds a service and a per-request fee, and REST streaming is newer. Bring it back for WAF integration, usage plans or request validation |
| EventBridge + Step Functions ingest workflow | a polling workflow for something an S3 trigger plus a lazy status check already does |
| AgentCore Memory | duplicates the DynamoDB history. Revisit for long-term facts |
| Browser calls AgentCore Runtime directly with a JWT | saves one hop, but moves the project-ownership check into the agent and weakens the "trusted payload" rule. Browser access to the runtime is unverified |
| OpenSearch Serverless or Aurora | fixed monthly capacity cost, only needed for hybrid |
| Neptune Analytics (GraphRAG) | always-on graph cost, not needed for document Q&A |
| Bedrock Managed Knowledge Base | the pricing page lists $5 per GB of raw data per month plus $1 per 1,000 retrievals, with hybrid, parsing, embeddings and reranking included. It offers fewer tuning options (built-in or fixed-size chunking). Not chosen: the per-GB fee outgrows S3 Vectors as the corpus grows, and tenant filtering and CDK support are unverified |
| VPC mode, NAT gateway, VPC endpoints | hourly costs, and nothing here needs a private network |
| Customer-managed KMS keys | monthly fee per key. SSE-S3 is free |
| Running the agent inside the API Lambda (no AgentCore) | simpler and slightly cheaper, but AgentCore is a goal of this project, and its Runtime costs cents at this scale |

---

## 14. Open risks

| # | Risk | How we settle it |
|---|------|------------------|
| R1 | The routing path CloudFront → Function URL → FastAPI is proven by the deployment smoke test. Streaming a LONG answer through CloudFront without buffering is not yet tested, and CloudFront times out if no bytes arrive for a while | Spike in the backend stage: the API sends a keep-alive line immediately. Fallback: call the Function URL directly with CORS |
| R2 | AgentCore Runtime streaming: how the agent emits text and a final citations event, and how the API Lambda reads them | Spike during the agent stage |
| R3 | File size and type limits of the Knowledge Base parser, and rate limits of `IngestKnowledgeBaseDocuments` | Read the quotas page, test a batch upload. The Ingest Lambda concurrency cap already bounds the calls |
| R4 | A document can show `INDEXED` slightly before it is searchable | UI shows `READY` after a short delay or after a successful probe retrieve |
| R5 | S3 Vectors filter behaviour and metadata limits at scale with a shared index | Test with a few thousand chunks across several projects. Metadata stays small (4 keys) |
| R6 | A public Function URL can be flooded, which costs money even when requests are rejected. Reserved concurrency, the usual cap, cannot be set on an account whose Lambda quota is below 100 | JWT check first, daily caps, budget alert. Raise the Lambda quota, then set `KC_API_RESERVED_CONCURRENCY`. Later: CloudFront-only access and WAF |
| R7 | AgentCore cold starts versus the idle timeout. A short timeout saves memory cost but the next question after it starts a new session | Measure cold start. Try the runtime's `V2` platform version only if cold starts hurt (higher rate per GB-hour) |
| R8 | Guardrail billing when only the input filter is on | Check the first bill and adjust |
| R9 | The `global.` inference profile may process requests in other regions | Fine for a research project. Switch to a regional profile (about 10% dearer) if data residency matters |
| R10 | Own JWT verification code is security-critical | Use a vetted library. Test expiry, wrong client, wrong token type, and key rotation |

Verified so far: direct ingestion works with an S3 data source and must not overlap a sync job (Bedrock documentation); `HYBRID` search needs a
supporting store and S3 Vectors is semantic only; Lambda response streaming over Function URLs and with the Lambda Web Adapter is documented;
AgentCore idle sessions stop CPU charges but keep memory billing until the session ends, and the idle timeout can be set from 60 to 28,800 seconds
(default 900). A deployment to a development account was smoke-tested: CloudFront serves the app and `/api/health`, the single-page-app routing works,
AgentCore runs the placeholder container, the Knowledge Base is active, and an upload triggers the ingest Lambda.
