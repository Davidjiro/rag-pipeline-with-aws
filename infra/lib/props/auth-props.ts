/**
 * auth-props.ts  -  inputs of the authentication building block.
 */
import { RemovalPolicy } from 'aws-cdk-lib';

export interface InviteOnlyUserPoolProps {
  /** User pool name, for example `kc-dev-users`. */
  readonly name: string;
  /** DESTROY for dev, RETAIN for prod. */
  readonly removalPolicy: RemovalPolicy;
  /** Blocks deletion of the pool through the API while on. True for prod. */
  readonly deletionProtection: boolean;
}
