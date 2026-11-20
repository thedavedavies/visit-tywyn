/**
 * Accessibility regression gate.
 *
 * Serves the built site with `astro preview`, then runs axe-core (via
 * puppeteer) against every page in the build at a desktop viewport,
 * failing on any WCAG A/AA *violation*. Run by `npm run test:a11y`,
 * which builds first. To scan only some pages, pass their paths:
 * `npm run test:a11y -- /eating/ /tide-times/`.
 *
 * Why a small custom runner rather than pa11y-ci: pa11y's axe runner
 * reports axe "incomplete" results (cannot-determine, e.g. a nav link
 * whose background axe could not measure because another element
 * overlaps it, or a single-glyph caret) as hard errors with the same
 * `color-contrast` code as real failures. On this site that meant a red
 * gate full of non-issues with no clean way to separate them. Running
 * axe directly lets us gate on `violations` only and scope to the WCAG
 * A/AA tag set. Pure axe also avoids HTML_CodeSniffer's false positive
 * on the footer's `content-visibility`.
 *
 * Pages may only load from the preview server: every other origin is
 * blocked, and the blocked hosts are listed at the end of the run. GA4
 * and Ahrefs are gated to the production host in BaseLayout, but the
 * AdSense loader is not, so without the block the scan would fetch
 * Google's ad script on localhost and could fail on whatever it injected
 * that day. The scan sees first-party markup only.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type BrowserContext } from 'puppeteer';

const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core');

const PORT = 4322;
const BASE = `http://localhost:${PORT}`;
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Pages are scanned a few at a time. Most of each page's time is the
// `networkidle0` quiet window rather than axe itself, so this cuts the run
// roughly by this factor. Each worker gets its own browser context, so its
// page is the active tab of its own window: a background tab is `hidden`,
// and a hidden document can skip rendering work axe needs to see.
const CONCURRENCY = 4;

/**
 * Every page in the build, at the URL the preview server serves it from:
 * each `index.html` as its directory (`trailingSlash: 'always'`), plus
 * `404.html`. Any other `.html` copied from `public/` (a search-console
 * verification file, say) isn't a page, so it's left out.
 */
function builtPages(): string[] {
	if (!existsSync(DIST)) {
		console.error(`✘ No build at ${DIST}. \`npm run test:a11y\` builds before it scans.`);
		process.exit(1);
	}
	return readdirSync(DIST, { recursive: true, encoding: 'utf8' })
		.map((file) => file.split(sep).join('/'))
		.filter((file) => file === 'index.html' || file.endsWith('/index.html') || file === '404.html')
		.map((file) => `/${file.replace(/index\.html$/, '')}`)
		.sort();
}

const requested = process.argv.slice(2).map((path) => (path.startsWith('/') ? path : `/${path}`));
const PATHS = requested.length > 0 ? requested : builtPages();

/** Whether anything answers HTTP at `url` right now. */
async function responds(url: string): Promise<boolean> {
	try {
		await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2_000) });
		return true;
	} catch {
		return false;
	}
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url, { method: 'HEAD' });
			if (res.status < 500) return;
		} catch {
			// not listening yet
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Preview server never responded at ${url} within ${timeoutMs}ms`);
}

interface Violation {
	id: string;
	impact: string | null;
	help: string;
	nodes: { target: string[]; summary: string }[];
}

/** Third-party hosts the scan refused to load, with request counts. */
const blocked = new Map<string, number>();

async function scan(context: BrowserContext, path: string): Promise<Violation[]> {
	const page = await context.newPage();
	try {
		await page.setViewport({ width: 1280, height: 900 });
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			const url = request.url();
			if (url.startsWith(`${BASE}/`) || url.startsWith('data:') || url.startsWith('blob:')) {
				void request.continue();
				return;
			}
			const host = new URL(url).host || url;
			blocked.set(host, (blocked.get(host) ?? 0) + 1);
			void request.abort('blockedbyclient');
		});
		await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle0' });
		await page.addScriptTag({ path: axePath });
		// Evaluate body passed as a string so the bundler cannot inject
		// helpers (e.g. __name) into the browser-side function.
		const result = (await page.evaluate(
			`(async () => {
				const r = await axe.run(document, { runOnly: ${JSON.stringify(TAGS)} });
				return {
					visibility: document.visibilityState,
					violations: r.violations.map((v) => ({
						id: v.id,
						impact: v.impact,
						help: v.help,
						nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
					})),
				};
			})()`,
		)) as { visibility: string; violations: Violation[] };
		if (result.visibility !== 'visible') {
			throw new Error(
				`${path} was ${result.visibility} while axe ran, so its result can't be trusted`,
			);
		}
		return result.violations;
	} finally {
		await page.close();
	}
}

/** Prints one page's result and returns its violation count (failing nodes). */
function report(path: string, violations: Violation[]): number {
	if (violations.length === 0) {
		console.log(`✓ ${path}`);
		return 0;
	}
	let count = 0;
	for (const v of violations) {
		count += v.nodes.length;
		console.log(`✘ ${path}`);
		console.log(`   [${v.impact ?? 'n/a'}] ${v.id}: ${v.help}`);
		for (const node of v.nodes) {
			console.log(`      ${node.target.join(' ')}`);
		}
	}
	return count;
}

// Anything already answering on PORT (for example a background `astro
// preview` an earlier agent-driven run left behind) would be scanned in
// place of this build, so stop rather than test the wrong site.
if (await responds(`${BASE}/`)) {
	console.error(
		`✘ Something is already serving ${BASE}. Stop it first; a leftover background preview server stops with \`npx astro preview stop\`.`,
	);
	process.exit(1);
}

// `detached: true` makes the child a process-group leader so the whole
// tree (npm + astro) can be killed on teardown via `process.kill(-pid)`.
// `--ignore-lock` makes it a one-off foreground server. Without it, when
// astro detects an AI agent (CLAUDECODE, AI_AGENT, ...) it relaunches the
// preview as a detached background server, which outlives that kill and
// keeps PORT busy after the run.
const server = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--ignore-lock'], {
	stdio: 'inherit',
	detached: true,
});

let totalViolations = 0;

try {
	await waitForServer(`${BASE}/`);
	const browser = await puppeteer.launch({
		args: ['--no-sandbox', '--disable-setuid-sandbox'],
	});
	try {
		// Workers take the next path as they free up; results print in path
		// order as soon as every earlier page is done, so the log is stable.
		const results: Violation[][] = [];
		let next = 0;
		let printed = 0;
		await Promise.all(
			Array.from({ length: Math.min(CONCURRENCY, PATHS.length) }, async () => {
				const context = await browser.createBrowserContext();
				try {
					while (next < PATHS.length) {
						const index = next++;
						results[index] = await scan(context, PATHS[index]);
						for (; printed < PATHS.length && results[printed]; printed++) {
							totalViolations += report(PATHS[printed], results[printed]);
						}
					}
				} finally {
					await context.close();
				}
			}),
		);
	} finally {
		await browser.close();
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	totalViolations = totalViolations || 1;
} finally {
	if (server.pid) {
		try {
			process.kill(-server.pid, 'SIGTERM');
		} catch {
			// already exited
		}
	}
}

if (blocked.size > 0) {
	const hosts = [...blocked.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([host, count]) => `${host} (${count})`);
	console.log(`\nBlocked third-party requests: ${hosts.join(', ')}`);
}
console.log(
	`\n${totalViolations ? '✘' : '✓'} ${totalViolations} WCAG A/AA violation(s) across ${PATHS.length} pages`,
);
process.exit(totalViolations ? 1 : 0);
