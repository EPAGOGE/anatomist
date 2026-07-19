// Doctor entry point — `npm run -w @epagoge/api doctor`.
//
// Loads default checks, runs them sequentially, prints a structured report,
// and exits non-zero if any check failed.

import { runDoctor, formatReport } from '../src/doctor/index.js';

const report = await runDoctor();
console.log(formatReport(report));
process.exit(report.ok ? 0 : 1);
