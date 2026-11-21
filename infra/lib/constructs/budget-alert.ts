/**
 * budget-alert.ts  -  an AWS Budgets alert that e-mails you before the bill surprises you.
 *
 * WHAT IT WATCHES
 *   Total monthly cost of the WHOLE AWS account, not only this project. (Filtering by tag needs a cost allocation tag to
 *   be activated first, which takes up to a day, so it is left out of v1.) Use a dedicated or sandbox account if you
 *   want the alert to mean "this project".
 *
 * ALERTS
 *   - 80% of the limit, based on actual spend so far.
 *   - 100% of the limit, based on the forecast for the month. This fires early, when the trend is bad.
 *
 * COST
 *   AWS Budgets gives the first two budgets per account for free.
 *
 * TRAPS
 *   - The alert is a notification, not a cut-off. Nothing stops spending when the limit is reached.
 *   - Budgets is a global service. The resource can be created from any region.
 *   - Subscribers must confirm nothing, but check the spam folder for the first e-mail.
 */
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';
import { BudgetAlertProps } from '../props/data-props';

export class BudgetAlert extends Construct {
  constructor(scope: Construct, id: string, props: BudgetAlertProps) {
    super(scope, id);

    const subscriber = { subscriptionType: 'EMAIL', address: props.email };

    new budgets.CfnBudget(this, 'Budget', {
      budget: {
        budgetName: props.name,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.monthlyUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [subscriber],
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [subscriber],
        },
      ],
    });
  }
}
