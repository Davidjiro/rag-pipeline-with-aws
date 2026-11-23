# lib/ - the CDK library code

| Path                  | Holds                                                                             |
| --------------------- | --------------------------------------------------------------------------------- |
| `config/`             | values per environment: model, limits, names, regions, cost controls              |
| `props/`              | interfaces: the contract of each construct                                        |
| `constructs/`         | one class per building block, each opening with a docstring of concepts and traps |
| `stacks/`             | six stacks that assemble the constructs                                           |
| `app-factory.ts`      | builds the whole app: stacks, tags, and the cdk-nag security checks               |
| `nag-suppressions.ts` | every accepted security finding, each with a written reason                       |

Read in this order: `app-factory.ts` (the picture), `config/environments.ts` (the knobs), then any construct.
