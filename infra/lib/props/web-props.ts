/**
 * web-props.ts  -  inputs of the web hosting building block.
 */
import { RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export interface WebDistributionProps {
  /** Folder with the built single-page app. */
  readonly webDistDir: string;
  /** Function URL of the API. CloudFront forwards `/api/*` to it. */
  readonly apiFunctionUrl: lambda.IFunctionUrl;
  /** Regional domain of the documents bucket, allowed by the Content Security Policy for uploads. */
  readonly docsBucketDomainName: string;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  /** Upload limits the app checks before asking for an upload (the API enforces them again). */
  readonly maxFileMb: number;
  readonly allowedExtensions: readonly string[];
  /** DESTROY for dev (also empties the bucket), RETAIN for prod. */
  readonly removalPolicy: RemovalPolicy;
}
