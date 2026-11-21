/**
 * app-table.ts  -  the single DynamoDB table that stores the application's own records.
 *
 * WHAT IT HOLDS
 *   Projects, document records (with their ingestion status), chats, messages and per-user daily question counters.
 *   It holds NO chunks and NO vectors: those live in the Knowledge Base's vector store (S3 Vectors).
 *
 * SINGLE-TABLE DESIGN
 *   One table with a generic partition key `PK` and sort key `SK`. Different entities share the table and are told apart
 *   by key prefixes (`USER#`, `PROJECT#`, `CHAT#` ...). The access patterns are all "read items under one partition":
 *
 *     list my projects            PK = USER#<sub>        SK begins with PROJECT#
 *     list a project's documents  PK = PROJECT#<id>      SK begins with DOC#
 *     read a chat in order        PK = CHAT#<id>         SK begins with MSG#
 *
 *   The exact key layout is documented in ARCHITECTURE.md section 8 and implemented in the backend stage.
 *
 * COST
 *   On-demand billing: no cost when idle, and no capacity to plan. Point-in-time recovery is OFF in dev and ON in prod
 *   (it bills per GB-month, so it is only worth paying for where losing the data would hurt).
 *   Time to live (`ttl`) removes short-lived items for free: documents whose upload never happened, and daily counters.
 *   Encryption uses the default AWS-owned key, which is free (a customer-managed KMS key has a monthly fee).
 *
 * KEY CONCEPTS / TRAPS
 *   - TTL deletion is lazy: items may live up to a few days after they expire. Never use TTL for security decisions.
 *   - `deletionProtection` makes `cdk destroy` fail on purpose in prod, so the table cannot be removed by accident.
 */
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { AppTableProps } from '../props/data-props';

export class AppTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: AppTableProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: props.name,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.pointInTimeRecovery },
      deletionProtection: props.deletionProtection,
      removalPolicy: props.removalPolicy,
    });
  }
}
