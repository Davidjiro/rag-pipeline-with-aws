# lib/props/ - the contracts

A **props interface** lists every input a construct needs. It is the construct's public API.

| File                 | Interfaces                                                               |
| -------------------- | ------------------------------------------------------------------------ |
| `auth-props.ts`      | `InviteOnlyUserPoolProps`                                                |
| `data-props.ts`      | `AppTableProps`, `BudgetAlertProps`                                      |
| `knowledge-props.ts` | `SecureBucketProps`, `S3VectorKnowledgeBaseProps`, `IngestFunctionProps` |
| `agent-props.ts`     | `ChatGuardrailProps`, `ChatAgentRuntimeProps`                            |
| `api-props.ts`       | `ApiFunctionProps`                                                       |
| `web-props.ts`       | `WebDistributionProps`                                                   |

## Conventions

- Every field is `readonly` and documented, including what happens if you change it.
- **Plain values** (strings, numbers) come from `config/`. **Live objects** (a bucket, a table, a Knowledge Base id token) are added by the
  stack, because they exist only after another construct is created. That is why config functions often return `Omit<...>` or `Pick<...>`.
- Constructs never import `config/`, so they stay reusable and testable with hand-written props.
