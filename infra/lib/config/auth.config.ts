/**
 * auth.config.ts  -  VALUES for the authentication layer.
 */
import { InviteOnlyUserPoolProps } from '../props/auth-props';
import { EnvironmentConfig, resourceName } from './environments';

export function userPoolConfig(env: EnvironmentConfig): InviteOnlyUserPoolProps {
  return {
    name: resourceName(env, 'users'),
    removalPolicy: env.removalPolicy,
    deletionProtection: env.protectedEnvironment,
  };
}
