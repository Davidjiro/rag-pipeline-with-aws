/**
 * ingest-function.ts  -  the Lambda that turns an uploaded file into searchable knowledge.
 *
 * WHAT IT DOES
 *   When a file lands in the documents bucket, S3 calls this function directly with an `ObjectCreated` event. The function
 *   looks the document up in DynamoDB (the record was created by the API before the upload), marks it `INGESTING`, and calls
 *   `IngestKnowledgeBaseDocuments` with the file's S3 location and inline metadata (`project_id`, `owner_id`, `doc_id`,
 *   `filename`). Then it exits. It does NOT wait for indexing: the API checks the status later, when the UI asks for it.
 *
 * WHY THERE IS NO WORKFLOW
 *   An earlier design used EventBridge and a Step Functions polling loop. It was removed: an S3 trigger plus a lazy status
 *   check does the same job with fewer services, fewer IAM roles, and nothing polling when nobody is watching.
 *
 * WHY IT READS DYNAMODB INSTEAD OF TRUSTING THE S3 OBJECT
 *   The owner of a document comes from the record the API created for the verified user, never from the uploaded object
 *   or its key. An upload with no matching record is ignored.
 *
 * COST AND LIMITS
 *   Python 3.15 on arm64 (Graviton) with 256 MB. The function runs for a fraction of a second per file. Optional reserved
 *   concurrency bounds the Knowledge Base calls during a burst of uploads. S3's asynchronous invocation queue holds the rest
 *   and retries, so nothing is lost. Leave it unset on accounts with a low Lambda quota (see config/environments.ts).
 *
 * LEAST PRIVILEGE
 *   The role may only call `IngestKnowledgeBaseDocuments` on this Knowledge Base and `GetItem` / `UpdateItem` on the table.
 *   It cannot read the file: the Knowledge Base's own role does that.
 *
 * TRAPS
 *   - S3 event notifications are delivered at least once. The handler must be safe to run twice for the same file.
 *   - The notification prefix matters: without it, writes elsewhere in the bucket would also trigger the function.
 */
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { Construct } from 'constructs';
import { IngestFunctionProps } from '../props/knowledge-props';
import { createLogOnlyRole } from './lambda-log-role';

export class IngestFunction extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: IngestFunctionProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: props.logRetention,
      removalPolicy: props.removalPolicy === RemovalPolicy.RETAIN ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.function = new lambda.Function(this, 'Function', {
      functionName: props.name,
      description: 'Starts Knowledge Base ingestion for a file uploaded to the documents bucket.',
      runtime: lambda.Runtime.PYTHON_3_15,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.main',
      code: lambda.Code.fromAsset(props.codeDir),
      memorySize: 256,
      timeout: Duration.seconds(60),
      reservedConcurrentExecutions: props.reservedConcurrency,
      // S3 invokes asynchronously: two retries, and give up after one hour instead of the default six.
      retryAttempts: 2,
      maxEventAge: Duration.hours(1),
      environment: {
        TABLE_NAME: props.table.tableName,
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        DATA_SOURCE_ID: props.dataSourceId,
      },
      logGroup,
      role: createLogOnlyRole(this, 'Role', logGroup),
    });

    // Least privilege: exactly the calls the handler makes.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'IngestIntoThisKnowledgeBase',
        actions: ['bedrock:IngestKnowledgeBaseDocuments'],
        resources: [props.knowledgeBaseArn],
      }),
    );
    props.table.grant(this.function, 'dynamodb:GetItem', 'dynamodb:UpdateItem');

    // The trigger. The prefix keeps unrelated writes from invoking the function.
    props.bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(this.function), {
      prefix: props.prefix,
    });
  }
}
