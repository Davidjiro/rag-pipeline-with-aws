/**
 * web-stack.ts  -  the public entry point: CloudFront, the web bucket and the deployed single-page app.
 *
 * Deployed last: CloudFront needs the API's Function URL as an origin, and the app's runtime configuration needs the Cognito
 * ids. Its output `WebUrl` is the address to open in the browser.
 */
import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config/environments';
import { PATHS } from '../config/paths';
import { WebDistribution } from '../constructs/web-distribution';
import { ApiStack } from './api-stack';
import { AuthStack } from './auth-stack';
import { KnowledgeStack } from './knowledge-stack';

export interface WebStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly auth: AuthStack;
  readonly knowledge: KnowledgeStack;
  readonly api: ApiStack;
}

export class WebStack extends Stack {
  public readonly web: WebDistribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    this.web = new WebDistribution(this, 'Web', {
      webDistDir: PATHS.webDistDir,
      apiFunctionUrl: props.api.api.functionUrl,
      docsBucketDomainName: props.knowledge.docsBucket.bucketRegionalDomainName,
      userPoolId: props.auth.pool.userPool.userPoolId,
      userPoolClientId: props.auth.pool.client.userPoolClientId,
      removalPolicy: props.config.removalPolicy,
    });

    new CfnOutput(this, 'WebUrl', { value: `https://${this.web.distribution.distributionDomainName}` });
    new CfnOutput(this, 'DistributionId', { value: this.web.distribution.distributionId });
  }
}
