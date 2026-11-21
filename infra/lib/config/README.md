# lib/config/  -  the values

Config files turn "which environment is this?" into concrete **props** for the constructs. A change to a model id, a limit or a retention
period should only ever need an edit here.

| File | Provides |
|------|----------|
| `environments.ts` | **single source of truth**: dev and prod, account and region, chat model, embedding settings, application limits, cost controls. Also `resourceName()` and `agentName()` (validated) and `baseModelId()` |
| `paths.ts` | where the application code lives (`backend/api`, `backend/ingest`, `agent`, `web/dist`) |
| `auth.config.ts` | user pool props |
| `data.config.ts` | table and budget props (no e-mail, no budget) |
| `knowledge.config.ts` | Knowledge Base, chunking and ingest function props. `DOCS_PREFIX = 'projects/'` |
| `agent.config.ts` | guardrail and agent runtime props |
| `api.config.ts` | API function props |

Environment variables are read **only** in `environments.ts` (see the table in `../../README.md`).

## Initial application limits (all in `environments.ts`)

| Limit | Value | Why |
|-------|-------|-----|
| file size | 20 MB | bounds ingestion cost and storage |
| file types | pdf, txt, md, html, docx, csv | what the Knowledge Base parser reads |
| documents per project | 25 | bounds storage and ingestion |
| question length | 2,000 characters | bounds tokens and guardrail cost |
| questions per user per day | 50 | bounds one account's model spend |
| history sent to the agent | 6 messages | tokens grow with history |
| chunks retrieved | 5 | bounds the tokens sent to the model |
| answer length | 1,024 tokens | caps output cost |

## Naming rule that bites

AgentCore runtime names allow letters, digits and underscores only. A hyphen fails at deploy time with a confusing validation error, so
`agentName()` builds the name and throws at synth time instead.
