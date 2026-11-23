/**
 * Sign-in with the Cognito user pool, through Amplify's Auth module only.
 *
 * Amplify uses SRP (Secure Remote Password): the password is never sent to the server. It stores the tokens and
 * refreshes the access token before it expires, so `accessToken()` always returns a usable token or null.
 *
 * Accounts are created by invitation. The first sign-in with the temporary password must choose a new one.
 */

import { Amplify } from 'aws-amplify';
import { confirmSignIn, fetchAuthSession, getCurrentUser, signIn, signOut } from 'aws-amplify/auth';
import type { AppConfig } from './config';

export type SignInResult = 'signedIn' | 'newPasswordRequired';

export const PASSWORD_RULE = 'At least 12 characters, with upper and lower case letters, a digit and a symbol.';

export function configureAuth(config: AppConfig): void {
  Amplify.configure({
    Auth: { Cognito: { userPoolId: config.userPoolId, userPoolClientId: config.userPoolClientId } },
  });
}

/** The signed-in user's email (the sign-in name), or null. */
export async function currentUser(): Promise<string | null> {
  try {
    const user = await getCurrentUser();
    return user.signInDetails?.loginId ?? user.username;
  } catch {
    return null;
  }
}

export async function accessToken(): Promise<string | null> {
  try {
    const session = await fetchAuthSession();
    return session.tokens?.accessToken?.toString() ?? null;
  } catch {
    return null;
  }
}

export async function startSignIn(email: string, password: string): Promise<SignInResult> {
  const result = await signIn({ username: email.trim(), password });
  return finish(result.nextStep.signInStep);
}

export async function setNewPassword(password: string): Promise<SignInResult> {
  const result = await confirmSignIn({ challengeResponse: password });
  return finish(result.nextStep.signInStep);
}

function finish(step: string): SignInResult {
  if (step === 'DONE') return 'signedIn';
  if (step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') return 'newPasswordRequired';
  throw new Error('This account needs a step the app does not support. Contact the administrator.');
}

export async function endSession(): Promise<void> {
  await signOut();
}

/** A message for a Cognito error, without revealing whether an account exists. */
export function authErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return 'Incorrect email or password.';
    case 'InvalidPasswordException':
      return `The new password does not meet the rules. ${PASSWORD_RULE}`;
    case 'PasswordResetRequiredException':
      return 'A password reset is required. Contact the administrator.';
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      return 'Too many attempts. Wait a minute and try again.';
    case 'NetworkError':
      return 'Network error. Check your connection and try again.';
    default:
      return error instanceof Error && error.message ? error.message : 'Sign-in failed. Please try again.';
  }
}
