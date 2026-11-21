/**
 * cost.test.ts  -  the project's cost promise, as a test: nothing in the deployment bills by the hour.
 *
 * The architecture (ARCHITECTURE.md section 11) says the bill is zero-ish with no traffic. That is only true while no resource
 * with a fixed hourly or monthly charge sneaks in. These resource types are the usual culprits.
 */
import { buildApp, StackKey } from './helpers';

const app = buildApp('dev');
const STACKS: StackKey[] = ['auth', 'data', 'knowledge', 'agent', 'api', 'web'];

const BILLS_WHEN_IDLE = [
  'AWS::EC2::NatGateway',
  'AWS::EC2::VPCEndpoint',
  'AWS::EC2::Instance',
  'AWS::EC2::EIP',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::OpenSearchServerless::Collection',
  'AWS::OpenSearchService::Domain',
  'AWS::RDS::DBCluster',
  'AWS::RDS::DBInstance',
  'AWS::Neptune::DBCluster',
  'AWS::NeptuneGraph::Graph',
  'AWS::KMS::Key',
  'AWS::WAFv2::WebACL',
  'AWS::ApiGateway::RestApi',
  'AWS::StepFunctions::StateMachine',
  'AWS::ECS::Cluster',
  'AWS::EKS::Cluster',
  'AWS::SecretsManager::Secret',
  'AWS::Route53::HostedZone',
  'AWS::CloudWatch::Alarm',
  'AWS::BedrockAgentCore::Memory',
  'AWS::BedrockAgentCore::Gateway',
];

describe('cost promise', () => {
  test.each(STACKS)('%s: no resource type that bills while idle', (key) => {
    const template = app.template(key).toJSON();
    const types = new Set(Object.values<any>(template.Resources).map((r) => r.Type));
    for (const type of BILLS_WHEN_IDLE) {
      expect(types).not.toContain(type);
    }
  });

  test('DynamoDB is on-demand and CloudFront uses the cheapest price class', () => {
    app.template('data').hasResourceProperties('AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST' });
    app.template('web').hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: { PriceClass: 'PriceClass_100' },
    });
  });

  test('every function runs on arm64, which is cheaper per millisecond', () => {
    for (const key of ['knowledge', 'api'] as StackKey[]) {
      const functions = Object.values<any>(app.template(key).findResources('AWS::Lambda::Function'));
      const own = functions.filter((f) => f.Properties.FunctionName?.startsWith('kc-dev-'));
      expect(own.length).toBeGreaterThan(0);
      for (const fn of own) expect(fn.Properties.Architectures).toEqual(['arm64']);
    }
  });

  test('the budget alert is created when an e-mail is given', () => {
    const previous = process.env.KC_BUDGET_EMAIL;
    process.env.KC_BUDGET_EMAIL = 'owner@example.com';
    try {
      jest.isolateModules(() => {
        const { buildApp: build } = require('./helpers');
        const withBudget = build('dev');
        withBudget.template('data').resourceCountIs('AWS::Budgets::Budget', 1);
        withBudget.template('data').hasResourceProperties('AWS::Budgets::Budget', {
          Budget: { BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: 10, Unit: 'USD' } },
        });
      });
    } finally {
      if (previous === undefined) delete process.env.KC_BUDGET_EMAIL;
      else process.env.KC_BUDGET_EMAIL = previous;
    }
  });
});
