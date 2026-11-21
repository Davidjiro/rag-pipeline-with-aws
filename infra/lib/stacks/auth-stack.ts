/**
 * auth-stack.ts  -  who may sign in: an invite-only Cognito user pool.
 *
 * Stateful (it holds your users), so it is separate from the stacks that change often. Nothing here depends on another stack,
 * and the API and web stacks depend on it.
 *
 * Add a user after deployment (there is no public sign-up):
 *   aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username you@example.com \
 *     --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
 */
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { userPoolConfig } from '../config/auth.config';
import { EnvironmentConfig } from '../config/environments';
import { InviteOnlyUserPool } from '../constructs/invite-only-user-pool';

export interface AuthStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

export class AuthStack extends Stack {
  public readonly pool: InviteOnlyUserPool;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    this.pool = new InviteOnlyUserPool(this, 'UserPool', userPoolConfig(props.config));

    new CfnOutput(this, 'UserPoolId', { value: this.pool.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.pool.client.userPoolClientId });
    new CfnOutput(this, 'JwtIssuer', { value: this.pool.issuerUrl });
  }
}
