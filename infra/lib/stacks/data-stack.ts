/**
 * data-stack.ts  -  application data and cost protection.
 *
 *   - the single DynamoDB table (projects, documents, chats, messages, daily counters)
 *   - an optional AWS Budgets e-mail alert (created only when KC_BUDGET_EMAIL is set)
 *
 * It sits first in the deployment order because the Knowledge stack's ingest function and the API both use the table.
 */
import { Annotations, CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { budgetConfig, tableConfig } from '../config/data.config';
import { EnvironmentConfig } from '../config/environments';
import { AppTable } from '../constructs/app-table';
import { BudgetAlert } from '../constructs/budget-alert';

export interface DataStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

export class DataStack extends Stack {
  public readonly appTable: AppTable;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.appTable = new AppTable(this, 'AppTable', tableConfig(props.config));

    const budget = budgetConfig(props.config);
    if (budget) {
      new BudgetAlert(this, 'BudgetAlert', budget);
    } else {
      Annotations.of(this).addInfo('No budget alert created: set KC_BUDGET_EMAIL to receive spend alerts.');
    }

    new CfnOutput(this, 'TableName', { value: this.appTable.table.tableName });
  }
}
