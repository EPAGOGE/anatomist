import { makeCheck } from '../runner.js';
import type { Check } from '../types.js';

const REQUIRED_MAJOR = 24;

export const nodeVersionCheck: Check = makeCheck('node-version', async () => {
  const version = process.versions.node;
  const [majorStr] = version.split('.');
  const major = Number(majorStr);
  if (!Number.isFinite(major) || major < REQUIRED_MAJOR) {
    throw new Error(`Node ${version} is below required v${REQUIRED_MAJOR} LTS`);
  }
  return `node v${version}`;
});

export const envVarsCheck: Check = makeCheck('env-vars', async () => {
  const required = ['DATABASE_URL', 'REDIS_URL'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`missing required env vars: ${missing.join(', ')}`);
  }
  return `${required.length} required vars present`;
});
