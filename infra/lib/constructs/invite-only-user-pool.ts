/**
 * invite-only-user-pool.ts  -  Amazon Cognito user pool for sign-in, with NO public sign-up.
 *
 * WHY INVITE-ONLY
 *   Every signed-in user can ask questions, and every question costs model tokens. If anyone could create an account,
 *   a stranger could run up your bill. With `selfSignUpEnabled: false` only an administrator can create users
 *   (`aws cognito-idp admin-create-user ...`), who then receive a temporary password by e-mail.
 *
 * HOW SIGN-IN WORKS
 *   The browser signs in with SRP (Secure Remote Password) directly against Cognito, so the password never travels.
 *   Cognito returns a JWT access token. The API Lambda verifies it itself (signature, issuer, expiry, client id), using
 *   the pool's public keys. There is no hosted UI and no OAuth flow, which keeps the setup small.
 *
 * COST
 *   The LITE feature plan is the cheapest tier and covers password sign-in. The first 10,000 monthly active users are
 *   free on the Lite and Essentials plans (check the Cognito pricing page). The default Cognito e-mail sender is free but
 *   limited to a small number of e-mails a day, which is plenty for invitations.
 *
 * KEY CONCEPTS / TRAPS
 *   - A public client (no secret) is correct for a browser app: a secret in JavaScript is not a secret.
 *   - `preventUserExistenceErrors` stops the sign-in form from revealing whether an e-mail address has an account.
 *   - Token lifetimes: a short access token limits damage if one leaks. The refresh token keeps the user signed in.
 *   - The e-mail attribute is immutable so an identity cannot be moved to another address.
 */
import { Duration, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { InviteOnlyUserPoolProps } from '../props/auth-props';

export class InviteOnlyUserPool extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly client: cognito.UserPoolClient;
  /** The `iss` claim every token from this pool carries. The API compares against it. */
  public readonly issuerUrl: string;

  constructor(scope: Construct, id: string, props: InviteOnlyUserPoolProps) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'Pool', {
      userPoolName: props.name,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.LITE,
      userInvitation: {
        emailSubject: 'You have been invited to Bedrock Knowledge Chat',
        emailBody:
          'Hello, you have been invited to Bedrock Knowledge Chat. Your username is {username} and your temporary ' +
          'password is {####}. You will be asked to choose a new password the first time you sign in.',
      },
      removalPolicy: props.removalPolicy,
      deletionProtection: props.deletionProtection,
    });

    this.client = this.userPool.addClient('WebClient', {
      userPoolClientName: `${props.name}-web`,
      generateSecret: false,
      authFlows: { userSrp: true },
      disableOAuth: true,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(30),
    });

    this.issuerUrl = `https://cognito-idp.${Stack.of(this).region}.amazonaws.com/${this.userPool.userPoolId}`;
  }
}
