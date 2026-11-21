# lib/stacks/  -  six stacks, one job each

A stack is a CloudFormation deployment unit. They are split by **rate of change** and **blast radius**, and CDK orders the deployment from
the references between them, so there is no `addDependency` anywhere.

| Stack | Changes | Contains |
|-------|---------|----------|
| `AuthStack` | rarely (holds users) | user pool and client |
| `DataStack` | rarely (holds data) | DynamoDB table, budget alert |
| `KnowledgeStack` | rarely (holds data) | docs bucket, Knowledge Base, S3 Vectors, ingest Lambda |
| `AgentStack` | often | guardrail, AgentCore runtime |
| `ApiStack` | often | API Lambda and Function URL |
| `WebStack` | often | CloudFront, web bucket, deployed app |

```
AuthStack ──────────────────────────────────────┐
DataStack ──► KnowledgeStack ──► AgentStack ──► ApiStack ──► WebStack
```

## A circular dependency the layout avoids

The docs bucket, its `ObjectCreated` notification and the ingest Lambda it triggers are in the **same** stack. If the Lambda lived elsewhere,
the bucket would need the Lambda (to notify it) and the Lambda would need the bucket (for permissions), and CloudFormation would report a cycle.

## Why Knowledge is separate from Agent

Stateful resources change rarely and hurt when deleted. The agent is redeployed whenever its code changes. Separating them lets prod
protect the data without slowing the agent loop. An exported value cannot change while another stack imports it, which is the usual cost of
splitting stacks.
