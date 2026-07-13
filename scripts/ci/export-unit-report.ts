/**
 * Convert Bun JUnit output to JSON + Markdown test reports for CI artifacts.
 *
 *   bun test test/rpc/ --reporter=junit --reporter-outfile=test-results/unit.junit.xml
 *   bun run scripts/ci/export-unit-report.ts
 */
import { readFile } from 'node:fs/promises';
import { reportFromJUnit, writeReport } from '../../test/ci/report.js';

const junitPath = process.argv[2] || 'test-results/unit.junit.xml';
const dir = process.env.TEST_RESULTS_DIR || 'test-results';

const xml = await readFile(junitPath, 'utf8');
const report = reportFromJUnit('unit-rpc', xml);
if (process.env.GITHUB_SHA) {
    report.meta = { ...(report.meta || {}), github_sha: process.env.GITHUB_SHA };
}
if (process.env.GITHUB_RUN_ID) {
    report.meta = { ...(report.meta || {}), github_run_id: process.env.GITHUB_RUN_ID };
}

const base = await writeReport(dir, report);
console.log(`Wrote ${base}.json and ${base}.md`);
console.log(
    `pass=${report.statistics.pass} fail=${report.statistics.fail} skip=${report.statistics.skip} total=${report.statistics.total}`,
);