/**
 * web-distribution.ts  -  the public front door: CloudFront serving the web app and forwarding `/api/*` to the API.
 *
 *   browser ──► CloudFront ──┬── everything else ──► private S3 bucket (the single-page app), through Origin Access Control
 *                            └── /api/*           ──► the API Lambda's Function URL (streaming, never cached)
 *
 * WHY ONE DOMAIN FOR BOTH
 *   The app and the API share an origin, so the browser needs no CORS for API calls and the app needs no API address baked
 *   in. It also gives one place to add a custom domain, a WAF, or logging later.
 *
 * WHAT IS CONFIGURED
 *   - The web bucket is PRIVATE. Only this distribution may read it (Origin Access Control). The bucket policy is added
 *     automatically.
 *   - HTTPS only (`/api/*`) or redirected to HTTPS (app), HTTP/2 and HTTP/3. With the default `*.cloudfront.net` certificate,
 *     CloudFront fixes the minimum TLS version at 1.0 and ignores any setting. Requiring TLS 1.2 needs a custom domain with an
 *     ACM certificate (out of scope for now), which is the only way to fix that.
 *   - PRICE_CLASS_100 serves from North America and Europe edges only, which is the cheapest class.
 *   - A response-headers policy adds HSTS, `nosniff`, clickjacking protection, a referrer policy and a Content Security
 *     Policy. The CSP lets the page talk only to itself, Cognito, and the documents bucket (for uploads).
 *   - `/api/*` uses the managed "caching disabled" policy and forwards all viewer headers except `Host`. The Authorization header
 *     must reach the Lambda, and the Host header must NOT be forwarded: a Function URL answers only to its own host name.
 *   - Compression is off for `/api/*` so Server-Sent Events are delivered as they are produced.
 *
 * SINGLE-PAGE APP ROUTING (the classic trap)
 *   The app handles routes like `/projects/42` in the browser, so any path that is not a file must return `index.html`.
 *   The usual fix, a distribution-wide error response for 403 and 404, also rewrites real API errors (a "project not found"
 *   404 from the API would come back as the HTML page). So a tiny CloudFront Function rewrites the request path instead,
 *   and only on the app behaviour.
 *
 * RUNTIME CONFIGURATION
 *   `config.json` (region, Cognito pool and client ids) is generated at deploy time and copied next to the app, so the same
 *   build runs in every environment. The deployment also invalidates the CloudFront cache.
 *
 * COST
 *   CloudFront's free tier is generous for a project of this size (1 TB and 10 million requests a month, to be checked on
 *   the pricing page). The CloudFront Function costs a fraction of a cent per million requests.
 *
 * TRAPS
 *   - CloudFront waits at most 60 s for the next byte from an origin (the default quota maximum). The API sends a keep-alive
 *     line right away so a slow agent start does not time out the stream.
 *   - `default root object` only applies to `/`. Deep links need the rewrite function above.
 */
import { Duration, Stack } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { WebDistributionProps } from '../props/web-props';
import { SecureBucket } from './secure-bucket';

/** Viewer-request function: any path without a file extension is a client-side route, so serve the app shell. */
const SPA_REWRITE = `function handler(event) {
  var request = event.request;
  var lastSegment = request.uri.split('/').pop();
  if (lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`;

export class WebDistribution extends Construct {
  public readonly distribution: cloudfront.Distribution;
  public readonly webBucket: SecureBucket;

  constructor(scope: Construct, id: string, props: WebDistributionProps) {
    super(scope, id);
    const { region } = Stack.of(this);

    this.webBucket = new SecureBucket(this, 'WebBucket', { removalPolicy: props.removalPolicy });

    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      code: cloudfront.FunctionCode.fromInline(SPA_REWRITE),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Serve index.html for client-side routes',
    });

    const csp = [
      `default-src 'self'`,
      `script-src 'self'`,
      `style-src 'self' 'unsafe-inline'`,
      `img-src 'self' data:`,
      `font-src 'self'`,
      `connect-src 'self' https://cognito-idp.${region}.amazonaws.com https://${props.docsBucketDomainName}`,
      `form-action 'self' https://${props.docsBucketDomainName}`,
      `object-src 'none'`,
      `base-uri 'self'`,
      `frame-ancestors 'none'`,
    ].join('; ');

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: 'Security headers for the web app and the API',
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          override: true,
        },
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Bedrock Knowledge Chat: web app and /api',
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.webBucket.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: headers,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.FunctionUrlOrigin(props.apiFunctionUrl, { readTimeout: Duration.seconds(60) }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: false,
          responseHeadersPolicy: headers,
        },
      },
    });

    // Copy the built app and the generated config.json into the bucket, then invalidate the cache.
    new s3deploy.BucketDeployment(this, 'DeployWebApp', {
      sources: [
        s3deploy.Source.asset(props.webDistDir),
        s3deploy.Source.jsonData('config.json', {
          region,
          userPoolId: props.userPoolId,
          userPoolClientId: props.userPoolClientId,
          apiBasePath: '/api',
        }),
      ],
      destinationBucket: this.webBucket.bucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      prune: true,
    });
  }
}
