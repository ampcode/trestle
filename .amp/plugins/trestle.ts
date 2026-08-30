import type { PluginAPI } from '@ampcode/plugin'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const description =
	'Query remote Trestle knowledge graphs through Amp portals. trestle_auth redeems a one-time portal login URL, trestle_query runs Cypher, trestle_call reaches survey/status/doctor.'

/**
 * Auth model: the portal stays private. The agent mints a one-time login URL
 * with the thread_portal_login_url tool, trestle_auth redeems it into a
 * session cookie (~12h) stored under ~/.cache/trestle/, and queries reuse it.
 * When the session expires, queries return the mint instruction and the agent
 * re-auths mid-conversation.
 */

interface Jar {
	cookies: string[]
	expiresAt: number | null
}

const stateDir = (): string => {
	const dir = process.env.TRESTLE_COOKIE_DIR ?? join(homedir(), '.cache', 'trestle')
	mkdirSync(dir, { recursive: true })
	return dir
}
const jarPath = (portal: URL): string =>
	join(stateDir(), `portal-${createHash('sha256').update(portal.host).digest('hex').slice(0, 16)}.json`)
const defaultPortalPath = (): string => join(stateDir(), 'default-portal')

function loadJar(portal: URL): Jar | null {
	try {
		const jar = JSON.parse(readFileSync(jarPath(portal), 'utf8')) as Jar
		if (jar.expiresAt !== null && jar.expiresAt <= Date.now()) return null
		return jar.cookies.length > 0 ? jar : null
	} catch {
		return null
	}
}

function saveJar(portal: URL, jar: Jar): void {
	writeFileSync(jarPath(portal), JSON.stringify(jar))
	chmodSync(jarPath(portal), 0o600)
}

function resolvePortal(portalUrl: unknown): URL | null {
	if (typeof portalUrl === 'string' && portalUrl !== '') return new URL(portalUrl)
	if (existsSync(defaultPortalPath())) return new URL(readFileSync(defaultPortalPath(), 'utf8').trim())
	return null
}

const mintInstruction = (portal: URL): string =>
	`Not authenticated to ${portal.origin}. Mint a one-time login URL for exactly ${portal.origin}/ ` +
	`with the thread_portal_login_url tool, then call trestle_auth with it. The session lasts ~12 hours.`

/** Redeem a one-time login URL: follow redirects manually, collecting cookies. */
async function redeem(loginUrl: URL): Promise<Jar> {
	const cookies = new Map<string, string>()
	let expiresAt: number | null = null
	let current = loginUrl.toString()
	for (let hop = 0; hop < 5; hop++) {
		const res = await fetch(current, {
			redirect: 'manual',
			headers: cookies.size > 0 ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
		})
		for (const sc of res.headers.getSetCookie()) {
			const pair = sc.split(';')[0]!.trim()
			const eq = pair.indexOf('=')
			if (eq > 0) cookies.set(pair.slice(0, eq), pair.slice(eq + 1))
			// Max-Age wins over Expires per RFC 6265.
			const maxAge = /max-age=(\d+)/i.exec(sc)
			const expires = /expires=([^;]+)/i.exec(sc)
			const t = maxAge ? Date.now() + Number(maxAge[1]) * 1000 : expires ? Date.parse(expires[1]!) : NaN
			if (!Number.isNaN(t)) expiresAt = expiresAt === null ? t : Math.min(expiresAt, t)
		}
		const location = res.headers.get('location')
		if (res.status >= 300 && res.status < 400 && location) {
			current = new URL(location, current).toString()
			continue
		}
		break
	}
	if (cookies.size === 0) {
		throw new Error('login URL set no session cookie — it is single-use and expires in ~60s; mint a fresh one')
	}
	return { cookies: [...cookies].map(([k, v]) => `${k}=${v}`), expiresAt }
}

/** POST one JSON-RPC message. Non-JSON or non-200 means the session is gone. */
async function rpc(portal: URL, jar: Jar, method: string, params?: unknown): Promise<{ ok: boolean; json?: any }> {
	const res = await fetch(portal, {
		method: 'POST',
		redirect: 'manual',
		headers: { 'content-type': 'application/json', cookie: jar.cookies.join('; ') },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	})
	if (res.status === 200 && (res.headers.get('content-type') ?? '').includes('application/json')) {
		return { ok: true, json: await res.json() }
	}
	await res.body?.cancel().catch(() => {})
	return { ok: false }
}

async function callRemote(portalUrl: unknown, tool: string, args: Record<string, unknown>): Promise<string> {
	const portal = resolvePortal(portalUrl)
	if (!portal) {
		return 'No portal known. Pass portal_url, or authenticate once with trestle_auth to set the default.'
	}
	const jar = loadJar(portal)
	if (!jar) return mintInstruction(portal)
	const res = await rpc(portal, jar, 'tools/call', { name: tool, arguments: args })
	if (!res.ok) return `Session rejected. ${mintInstruction(portal)}`
	if (res.json.error) throw new Error(`${tool}: ${res.json.error.message}`)
	const text = res.json.result?.content?.[0]?.text ?? JSON.stringify(res.json.result)
	if (res.json.result?.isError) throw new Error(text)
	return text
}

export default function (amp: PluginAPI) {
	amp.registerTool({
		name: 'trestle_auth',
		description:
			'Authenticate to a Trestle graph portal. First mint a one-time login URL for the portal with the ' +
			'thread_portal_login_url tool, then pass it here. Stores a ~12h session and sets the default portal.',
		inputSchema: {
			type: 'object',
			properties: {
				login_url: { type: 'string', description: 'One-time login URL minted by thread_portal_login_url' },
			},
			required: ['login_url'],
		},
		async execute(input) {
			const loginUrl = new URL(String(input.login_url))
			const portal = new URL(`${loginUrl.origin}/`)
			const jar = await redeem(loginUrl)
			const probe = await rpc(portal, jar, 'ping')
			if (!probe.ok) throw new Error('login redeemed but the portal still rejects requests — mint a fresh URL')
			saveJar(portal, jar)
			writeFileSync(defaultPortalPath(), portal.toString())
			const until = jar.expiresAt === null ? 'the portal session ends' : new Date(jar.expiresAt).toISOString()
			return `Authenticated to ${portal.host} (now the default portal); session valid until ${until}.`
		},
	})

	amp.registerTool({
		name: 'trestle_query',
		description:
			'Run a raw Cypher query against a Trestle knowledge graph served behind an Amp portal. ' +
			'Uses the default portal from the last trestle_auth unless portal_url is given. ' +
			'If not authenticated, the result explains how to log in.',
		inputSchema: {
			type: 'object',
			properties: {
				cypher: { type: 'string', description: 'Cypher query, e.g. MATCH (n) RETURN count(n)' },
				portal_url: { type: 'string', description: 'Portal URL of the trestle serve endpoint (optional)' },
			},
			required: ['cypher'],
		},
		execute: (input) => callRemote(input.portal_url, 'graph_query', { cypher: String(input.cypher) }),
	})

	amp.registerTool({
		name: 'trestle_call',
		description:
			'Call any other tool on a remote Trestle graph server: survey (unresolved work), status (counts), ' +
			'doctor (graph health checks). Uses the default portal unless portal_url is given.',
		inputSchema: {
			type: 'object',
			properties: {
				tool: { type: 'string', description: 'Remote tool name: survey, status, or doctor' },
				arguments: { type: 'object', description: 'Arguments for the remote tool (optional)' },
				portal_url: { type: 'string', description: 'Portal URL of the trestle serve endpoint (optional)' },
			},
			required: ['tool'],
		},
		execute: (input) =>
			callRemote(input.portal_url, String(input.tool), (input.arguments as Record<string, unknown>) ?? {}),
	})
}
