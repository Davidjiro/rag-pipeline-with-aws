/** Jest configuration: TypeScript tests under test/, run with ts-jest. */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  // Synthesising all six stacks (with Docker asset hashing) takes a few seconds.
  testTimeout: 120000,
};
