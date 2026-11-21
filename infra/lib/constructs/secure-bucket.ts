/**
 * secure-bucket.ts  -  an S3 bucket with safe, low-cost defaults.
 *
 * USED FOR
 *   1. The documents bucket: uploaded files, which are also the Knowledge Base source.
 *   2. The web bucket: the built single-page app, served only through CloudFront.
 *
 * DEFAULTS APPLIED
 *   - Block ALL public access.
 *   - Encryption at rest with S3-managed keys (SSE-S3). It is free. A customer-managed KMS key would add a monthly fee
 *     and a key policy to maintain, which this project does not need.
 *   - `enforceSSL` adds a bucket policy that denies requests that do not use TLS.
 *   - Bucket-owner-enforced ownership: ACLs are disabled, so permissions come only from IAM and bucket policies.
 *   - NO versioning. Uploaded documents are never overwritten (every upload has a new key), so versions would only
 *     add storage cost.
 *   - A lifecycle rule aborts incomplete multipart uploads after one day. Without it, abandoned uploads are stored and
 *     billed forever without showing up in the console listing.
 *
 * BROWSER UPLOADS (CORS)
 *   The browser uploads straight to S3 with a presigned POST, which is a cross-origin request, so the bucket needs a
 *   CORS rule. It allows POST only, from the configured origins. The presigned policy, not CORS, is what restricts who
 *   may upload, which file type and size, and to which key. CORS only tells browsers which sites may read the response.
 *
 * DEV vs PROD
 *   DESTROY (dev) also empties the bucket on `cdk destroy`, using a small helper Lambda that CDK adds.
 *   RETAIN (prod) keeps the bucket and its contents when the stack is deleted.
 */
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { SecureBucketProps } from '../props/knowledge-props';

export class SecureBucket extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: SecureBucketProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: false,
      lifecycleRules: [{ id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      cors: props.uploadAllowedOrigins
        ? [
            {
              allowedMethods: [s3.HttpMethods.POST],
              allowedOrigins: [...props.uploadAllowedOrigins],
              allowedHeaders: ['*'],
              exposedHeaders: ['ETag'],
              maxAge: 3000,
            },
          ]
        : undefined,
      removalPolicy: props.removalPolicy,
      autoDeleteObjects: props.removalPolicy === RemovalPolicy.DESTROY,
    });
  }
}
