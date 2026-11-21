/**
 * data.config.ts  -  VALUES for the application-data layer (DynamoDB table and budget alert).
 */
import { AppTableProps, BudgetAlertProps } from '../props/data-props';
import { EnvironmentConfig, resourceName } from './environments';

export function tableConfig(env: EnvironmentConfig): AppTableProps {
  return {
    name: resourceName(env, 'app'),
    removalPolicy: env.removalPolicy,
    deletionProtection: env.protectedEnvironment,
    pointInTimeRecovery: env.protectedEnvironment,
  };
}

/** Returns undefined when no e-mail is configured: a budget alert without a recipient would be useless. */
export function budgetConfig(env: EnvironmentConfig): BudgetAlertProps | undefined {
  if (!env.budget.email) return undefined;
  return { name: resourceName(env, 'monthly'), monthlyUsd: env.budget.monthlyUsd, email: env.budget.email };
}
