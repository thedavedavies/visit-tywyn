const DISPATCH_URL =
	'https://api.github.com/repos/thedavedavies/visit-tywyn/actions/workflows/refresh-conditions.yml/dispatches';

export default {
	async scheduled(_controller, env) {
		const res = await fetch(DISPATCH_URL, {
			method: 'POST',
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${env.GITHUB_TOKEN}`,
				'content-type': 'application/json',
				'user-agent': 'visit-tywyn/1.0 (+https://visit-tywyn.co.uk)',
			},
			body: JSON.stringify({ ref: 'main', inputs: { force: 'false' } }),
		});
		if (!res.ok) throw new Error(`dispatch failed: ${res.status} ${await res.text()}`);
	},
};
