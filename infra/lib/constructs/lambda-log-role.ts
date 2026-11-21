/**
 * lambda-log-role.ts  -  an execution role that can write logs to ONE log group and do nothing else.
 *
 * WHY NOT THE DEFAULT ROLE
 *   If you do not pass a role, CDK attaches the AWS managed policy `AWSLambdaBasicExecutionRole`, which allows creating log
 *   groups and writing to ANY log group in the account. Because this project creates each function's log group itself (to set
 *   the retention), the function only needs `logs:CreateLogStream` and `logs:PutLogEvents` on that single group.
 *
 * Other permissions (DynamoDB, Bedrock, S3 ...) are added to the role by the construct that owns the function.
 */
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export function createLogOnlyRole(scope: Construct, id: string, logGroup: logs.ILogGroup): iam.Role {
  const role = new iam.Role(scope, id, {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: 'Lambda execution role: write to its own log group only',
  });
  logGroup.grantWrite(role);
  return role;
}
