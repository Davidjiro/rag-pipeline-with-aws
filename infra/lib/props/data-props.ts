/**
 * data-props.ts  -  inputs of the application-data building blocks.
 */
import { RemovalPolicy } from 'aws-cdk-lib';

export interface AppTableProps {
  /** Table name, for example `kc-dev-app`. */
  readonly name: string;
  /** DESTROY for dev, RETAIN for prod. */
  readonly removalPolicy: RemovalPolicy;
  /** Blocks deletion of the table while on. True for prod. */
  readonly deletionProtection: boolean;
  /** Continuous backups with point-in-time restore. Billed per GB-month, so on only where the data matters (prod). */
  readonly pointInTimeRecovery: boolean;
}

export interface BudgetAlertProps {
  /** Budget name, for example `kc-dev-monthly`. */
  readonly name: string;
  /** Monthly limit in US dollars. */
  readonly monthlyUsd: number;
  /** Receives the alert e-mails. */
  readonly email: string;
}
