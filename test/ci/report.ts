/**
 * Write machine- and human-readable test reports for CI artifacts.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type TestRow = {
    name: string;
    status: 'pass' | 'fail' | 'skip';
    detail?: string;
    durationMs?: number;
};

export type TestReport = {
    suite: string;
    runAt: string;
    statistics: {
        pass: number;
        fail: number;
        skip: number;
        total: number;
    };
    tests: TestRow[];
    meta?: Record<string, string>;
};

export function buildReport(suite: string, tests: TestRow[], meta?: Record<string, string>): TestReport {
    const pass = tests.filter(t => t.status === 'pass').length;
    const fail = tests.filter(t => t.status === 'fail').length;
    const skip = tests.filter(t => t.status === 'skip').length;
    return {
        suite,
        runAt: new Date().toISOString(),
        statistics: { pass, fail, skip, total: tests.length },
        tests,
        meta,
    };
}

export function reportToMarkdown(report: TestReport): string {
    const { statistics: s } = report;
    const lines = [
        `# ${report.suite} — test report`,
        '',
        `Run at: ${report.runAt}`,
        '',
        '## Statistics',
        '',
        '| Metric | Count |',
        '|--------|------:|',
        `| Pass | ${s.pass} |`,
        `| Fail | ${s.fail} |`,
        `| Skip | ${s.skip} |`,
        `| Total | ${s.total} |`,
        '',
        '## Tests',
        '',
        '| Status | Test | Detail |',
        '|--------|------|--------|',
    ];
    for (const t of report.tests) {
        const detail = (t.detail || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
        lines.push(`| ${t.status} | ${t.name} | ${detail} |`);
    }
    lines.push('');
    return lines.join('\n');
}

export async function writeReport(dir: string, report: TestReport): Promise<string> {
    await mkdir(dir, { recursive: true });
    const base = join(dir, report.suite);
    await writeFile(`${base}.json`, JSON.stringify(report, null, 2));
    await writeFile(`${base}.md`, reportToMarkdown(report));
    await writeFile(join(dir, 'summary.json'), JSON.stringify({
        runAt: report.runAt,
        suites: [{ suite: report.suite, ...report.statistics }],
    }, null, 2));
    return base;
}

/** Parse Bun JUnit XML into a TestReport (unit / rpc suite). */
export function reportFromJUnit(suite: string, xml: string): TestReport {
    const tests: TestRow[] = [];
    const caseRe = /<testcase\s+([^>]+)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    let m: RegExpExecArray | null;
    while ((m = caseRe.exec(xml)) !== null) {
        const attrs = m[1];
        const body = m[2] || '';
        const name = /name="([^"]*)"/.exec(attrs)?.[1] || 'unknown';
        const timeSec = Number(/time="([^"]*)"/.exec(attrs)?.[1] || 0);
        let status: TestRow['status'] = 'pass';
        let detail: string | undefined;
        if (body.includes('<failure')) {
            status = 'fail';
            detail = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        } else if (body.includes('<skipped')) {
            status = 'skip';
        }
        tests.push({
            name,
            status,
            detail,
            durationMs: Math.round(timeSec * 1000),
        });
    }
    return buildReport(suite, tests);
}