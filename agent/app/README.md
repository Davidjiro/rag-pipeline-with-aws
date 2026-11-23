# agent/app/  -  the agent package

Flow of one question: `main.py` (entrypoint) -> `request.py` (validate) -> `chat.py` (the flow) -> `guardrail.py`, then `runner.py` (the boto3 tool loop)
which calls the tool backed by `retrieval.py`, and `queries.py` for multi-query.

| Module | Responsibility |
|--------|----------------|
| `main.py` | AgentCore entrypoint (`BedrockAgentCoreApp`): `/ping`, `/invocations`, one SSE event per yielded dict. Builds the AWS clients and model once |
| `request.py` | validates the API's payload; cleans the history so roles alternate and start with the user |
| `chat.py` | the flow and the rules enforced in code: guardrail, evidence gate, citations, search limit, generic errors |
| `runner.py` | the tool loop over `ConverseStream`: streams text, runs `search_documents` when the model asks, at most 5 model turns; strips `<thinking>` tags |
| `retrieval.py` | filtered Knowledge Base search, Reciprocal Rank Fusion for multi-query, `Evidence` (numbers documents, builds citations) |
| `queries.py` | multi-query: one short model call that writes alternative queries; falls back to the original question |
| `guardrail.py` | `ApplyGuardrail` on the user's text; raises if it cannot decide |
| `prompts.py` | the system prompt and every fixed message |
| `config.py` | settings from environment variables, and the fixed limits |

## Events (what the API receives, one per `data:` line)

| Event | Meaning |
|-------|---------|
| `{"type":"token","text":"..."}` | a piece of the answer |
| `{"type":"citations","citations":[{"number","source","snippet","score"}]}` | sent last; the documents the answer cites, each with the `[n]` the text uses |
| `{"type":"error","message":"..."}` | the answer failed. The API saves nothing |

The API checks every citation again and keeps only files of the caller's project (`backend/api/app/citations.py`), so the contract does not rely on
this agent being correct. A test runs the API's own parser on this agent's real output.
