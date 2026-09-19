/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/test/env.setup.js'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {}],
  },
};
