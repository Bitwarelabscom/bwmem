// Vitest global setup: provide the env vars that production modules require.
// Without these, importing src/api/utils/api-keys.ts (which validates the
// pepper at module load) crashes any test file that touches the API layer —
// even if the test only exercises the schema/auth helpers and never calls
// the real DB. Setting them here keeps the unit suite hermetic without
// asking developers to remember to export them in their shell.
process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER
  ?? 'test-pepper-deterministic-32-chars-minimum-padding';
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY
  ?? 'test-admin-key-deterministic-32-chars-min';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
