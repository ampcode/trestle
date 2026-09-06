import type { PluginAPI, ThreadMessage } from '@ampcode/plugin'
import type { SessionRef, ArtifactInput, Unsupported, HarnessConnector } from '../../src/coordination/types.ts'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const description =
	'Query Trestle graphs and supporting evidence through Amp portals and coordinate migration units. Bind the current Amp thread as lead and bookmark verified message references without controlling session execution.'

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

/** POST one JSON-RPC message to the MCP endpoint. Non-JSON or non-200 means the session is gone. */
async function rpc(portal: URL, jar: Jar, method: string, params?: unknown): Promise<{ ok: boolean; json?: any }> {
	const res = await fetch(new URL('/mcp', portal), {
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
	// Orb networking may already authenticate portal requests without a local cookie.
	const res = await rpc(portal, jar ?? { cookies: [], expiresAt: null }, 'tools/call', { name: tool, arguments: args })
	if (!res.ok) return `Session rejected. ${mintInstruction(portal)}`
	if (res.json.error) throw new Error(`${tool}: ${res.json.error.message}`)
	const text = res.json.result?.content?.[0]?.text ?? JSON.stringify(res.json.result)
	if (res.json.result?.isError) throw new Error(text)
	return text
}

interface AmpThread {
	id: string
	title: { get(): Promise<string | null> }
	state: { get(): Promise<'idle' | 'running' | 'awaiting-approval' | 'error'> }
	messages(options: { full: boolean; from: 'start'; offset: number; limit: number }): Promise<ThreadMessage[]>
}
interface AmpHost { threads: { get(id: `T-${string}`): AmpThread } }

function artifact(message: ThreadMessage, ref: SessionRef, threadURL: string, captureText: boolean): ArtifactInput {
	return {
		session: ref, nativeId: JSON.stringify(message.id), kind: 'message',
		locator: { threadURL, messageID: message.id },
		metadata: { role: message.role, tools: message.content.flatMap(block => block.type === 'tool_use' ? [block.name] : []) },
		...(captureText ? { text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') } : {}),
	}
}

/** Provider adapter consumed by the coordination harness. It only reads Amp state. */
export function createAmpConnector(amp: AmpHost, options: { captureText?: boolean } = {}): HarnessConnector {
	const getThread = (ref: SessionRef): AmpThread | Unsupported => {
		if (ref.provider !== 'amp') return { unsupported: true, reason: `Amp connector cannot read provider ${ref.provider}` }
		if (!ref.sessionId.startsWith('T-')) return { unsupported: true, reason: 'Invalid Amp session ID' }
		return amp.threads.get(ref.sessionId as `T-${string}`)
	}
	return {
		provider: 'amp',
		capabilities: { activity: true, fullHistory: true, artifactContent: true } as const,
		async readSession(ref: SessionRef) {
			const thread = getThread(ref)
			if ('unsupported' in thread) return thread
			const [title, nativeState] = await Promise.all([thread.title.get(), thread.state.get()])
			const state = nativeState === 'running' ? 'working' : nativeState === 'awaiting-approval' ? 'awaiting-input' : nativeState === 'idle' ? 'idle' : 'unknown'
			return {
				session: { ref, url: `https://ampcode.com/threads/${ref.sessionId}`, ...(title ? { title } : {}) },
				observation: { session: ref, state, observedAt: new Date().toISOString(), nativeState },
			}
		},
		async readHistory(ref: SessionRef, cursor?: string) {
			const thread = getThread(ref)
			if ('unsupported' in thread) return thread
			const offset = cursor === undefined ? 0 : Number(cursor)
			if (!Number.isSafeInteger(offset) || offset < 0) return { unsupported: true, reason: 'Invalid Amp history cursor' }
			const messages = await thread.messages({ full: true, from: 'start', offset, limit: 20 })
			const url = `https://ampcode.com/threads/${ref.sessionId}`
			return { artifacts: messages.map(message => artifact(message, ref, url, options.captureText === true)),
				...(messages.length === 20 ? { nextCursor: String(offset + messages.length) } : {}) }
		},
	}
}

async function coordinate(portalUrl: unknown, operation: string, args: Record<string, unknown>, requestId?: string): Promise<string> {
	return callRemote(portalUrl, 'coordination', { operation, arguments: args, ...(requestId ? { requestId } : {}) })
}

function parseRemote(text: string, operation: string): any {
	try { return JSON.parse(text) } catch { throw new Error(`${operation} returned a non-JSON response: ${text}`) }
}

export default function (amp: PluginAPI) {
	amp.registerTool({
		name: 'trestle_amp',
		description:
			'Connect the current Amp thread to Trestle migration coordination. ' +
			'index lists message IDs, roles and tool names (including compacted history), without copying transcripts. ' +
			'Set persist to store the index page; capture_text additionally retains visible text (never thinking or tool payloads). ' +
			'Mutations require request_id, which is reused deterministically across retries. create binds this thread as lead. ' +
			'bookmark requires message_id and arguments.kind/description; verifies and indexes that message, then pins its artifact version. ' +
			'handoff makes this thread the replacement lead and requires message_id plus arguments.expectedRevision/description. ' +
			'Also supports register, observe and attach. No sessions are created, resumed or messaged.',
		inputSchema: {
			type: 'object',
			properties: {
				operation: { type: 'string', enum: ['index', 'create', 'bookmark', 'handoff', 'get', 'list', 'status', 'register', 'observe', 'attach'] },
				id: { type: 'string', description: 'Migration unit ID; not needed for index/list.' },
				request_id: { type: 'string', description: 'Required stable idempotency key for mutations.' },
				message_id: { type: ['string', 'number'], description: 'Exact message ID returned by index.' },
				offset: { type: 'integer', minimum: 0, description: 'Index offset from the start; pages contain up to 20 messages.' },
				persist: { type: 'boolean', description: 'Persist this index page to Trestle. Default false.' },
				capture_text: { type: 'boolean', description: 'Explicitly retain visible message text. Review for sensitive data first; no automatic redaction. Default false.' },
				arguments: { type: 'object', description: 'Migration operation fields; provider/session/locator are supplied by the adapter.' },
				portal_url: { type: 'string', description: 'Trestle portal; defaults to the authenticated portal.' },
			},
			required: ['operation'],
		},
		async execute(input, ctx) {
			const operation = input.operation
			if (!['index', 'create', 'bookmark', 'handoff', 'get', 'list', 'status', 'register', 'observe', 'attach'].includes(String(operation))) {
				throw new Error('Unknown Amp adapter operation')
			}
			const thread = ctx.thread
			const threadURL = `https://ampcode.com/threads/${thread.id}`
			const ref = { provider: 'amp', sessionId: thread.id }
			if (operation === 'index') {
				const offset = input.offset ?? 0
				if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset')
				const messages = await thread.messages({ full: true, from: 'start', offset, limit: 20 })
				let imported: unknown = undefined
				if (input.capture_text === true && input.persist !== true) throw new Error('capture_text requires persist for index')
				if (input.persist === true && messages.length) {
					if (typeof input.request_id !== 'string' || !input.request_id) throw new Error('request_id is required for mutations')
					await coordinate(input.portal_url, 'registerSession', { ref, url: threadURL }, `${input.request_id}:register`)
					const response = await coordinate(input.portal_url, 'indexArtifacts', {
						artifacts: messages.map(message => artifact(message, ref, threadURL, input.capture_text === true)),
					}, `${input.request_id}:index`)
					try { imported = JSON.parse(response) } catch { return response }
				}
				return JSON.stringify({ provider: 'amp', session: thread.id, threadURL,
					artifacts: imported,
					messages: messages.map(message => ({
						id: message.id, role: message.role,
						tools: message.content.flatMap(block => block.type === 'tool_use' ? [block.name] : []),
					})),
					nextOffset: messages.length === 20 ? offset + messages.length : null,
				})
			}
			if (input.arguments !== undefined && (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments))) {
				throw new Error('arguments must be an object')
			}
			const supplied = input.arguments as Record<string, unknown> ?? {}
			const requestId = input.request_id
			const mutations = ['create', 'bookmark', 'handoff', 'status', 'register', 'observe', 'attach']
			if (mutations.includes(String(operation)) && (typeof requestId !== 'string' || !requestId)) throw new Error('request_id is required for mutations')
			const register = () => coordinate(input.portal_url, 'registerSession', { ref, url: threadURL }, `${requestId}:register`)
			if (operation === 'get') return coordinate(input.portal_url, 'getUnit', { id: input.id })
			if (operation === 'list') return coordinate(input.portal_url, 'listUnits', supplied)
			if (operation === 'register') return register()
			if (operation === 'observe') { await register(); return coordinate(input.portal_url, 'observeSession', { session: ref, state: supplied.state, observedAt: supplied.observedAt, nativeState: supplied.nativeState }, `${requestId}:observe`) }
			if (operation === 'attach') { await register(); return coordinate(input.portal_url, 'attachSession', { unitId: input.id, ref }, `${requestId}:attach`) }
			if (operation === 'create') { await register(); return coordinate(input.portal_url, 'createUnit', { id: input.id, title: supplied.title, objective: supplied.objective, acceptance: supplied.acceptance, scope: supplied.scope, lead: ref }, `${requestId}:create`) }
			if (operation === 'status') { await register(); return coordinate(input.portal_url, 'setUnitStatus', { id: input.id, expectedRevision: supplied.expectedRevision, status: supplied.status, reason: supplied.reason }, `${requestId}:status`) }
			if (operation === 'bookmark' || operation === 'handoff') {
				if (typeof input.message_id !== 'string' && typeof input.message_id !== 'number') throw new Error('message_id is required')
				let found: ThreadMessage | undefined
				for (let offset = 0; ; offset += 20) {
					const page = await thread.messages({ full: true, from: 'start', offset, limit: 20 })
					found = page.find(message => message.id === input.message_id)
					if (found) break
					if (page.length < 20) break
				}
				if (!found) throw new Error('Message not found in the current Amp thread')
				await register()
				const response = await coordinate(input.portal_url, 'indexArtifacts', {
					artifacts: [artifact(found, ref, threadURL, input.capture_text === true)],
				}, `${requestId}:index`)
				let imported: unknown
				try { imported = JSON.parse(response) } catch { return response }
				if (!Array.isArray(imported) || typeof imported[0]?.id !== 'string') throw new Error('Invalid artifact import response')
				const bookmarkText = await coordinate(input.portal_url, 'createBookmark', {
					unitId: input.id, artifactId: imported[0].id, kind: operation === 'handoff' ? 'handoff' : supplied.kind, description: supplied.description,
				}, `${requestId}:bookmark`)
				if (operation === 'bookmark') return bookmarkText
				const bookmark = parseRemote(bookmarkText, 'createBookmark')
				return coordinate(input.portal_url, 'handoffLead', { id: input.id, expectedRevision: supplied.expectedRevision,
					newLead: ref, bookmarkId: bookmark.id }, `${requestId}:handoff`)
			}
			throw new Error('Unhandled Amp adapter operation')
		},
	})

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
			'Run a read-only Cypher query against a Trestle knowledge graph served behind an Amp portal. ' +
			'Return node/rel stableId, then use trestle_call graph_evidence for supporting source locations. ' +
			'With includeMetadata, returns {rows, sourceGeneration}; compare it with evidence generation to detect staleness. ' +
			'Uses the default portal from the last trestle_auth unless portal_url is given. ' +
			'If not authenticated, the result explains how to log in.',
		inputSchema: {
			type: 'object',
			properties: {
				cypher: { type: 'string', description: 'Cypher query, e.g. MATCH (n) RETURN count(n)' },
				includeMetadata: { type: 'boolean', description: 'Return rows with their source generation; null means a legacy projection needs rebuilding.' },
				portal_url: { type: 'string', description: 'Portal URL of the trestle serve endpoint (optional)' },
			},
			required: ['cypher'],
		},
		execute: (input) => callRemote(input.portal_url, 'graph_query', {
			cypher: String(input.cypher), includeMetadata: input.includeMetadata,
		}),
	})

	amp.registerTool({
		name: 'trestle_call',
		description:
			'Call a remote Trestle tool: graph_evidence (live evidence and source locations for a node/edge stableId), ' +
			'survey (unresolved work), status (counts), doctor (health). ' +
			'Coordination manages provider-neutral units, sessions, artifacts, and bookmarks; takes a camelCase operation, arguments object, and requestId for mutations. ' +
			'For graph_evidence pass arguments {entityType: "node"|"edge", stableId, limit?: 1..200, afterId?: nextAfterId, expectedGeneration?: generation}. ' +
			'Results distinguish live/retired/not_found; empty evidence is valid. Referenced facts may be retired. ' +
			'Page with nextAfterId and the first page generation as expectedGeneration; restart at afterId 0 on mismatch. ' +
			'Without the guard, discard pages if generation differs. Revision is provenance only. Uses the default portal unless portal_url is given.',
		inputSchema: {
			type: 'object',
			properties: {
				tool: { type: 'string', description: 'Remote tool name: graph_evidence, survey, status, doctor, or coordination' },
				arguments: { type: 'object', description: 'Arguments for the remote tool (optional)' },
				portal_url: { type: 'string', description: 'Portal URL of the trestle serve endpoint (optional)' },
			},
			required: ['tool'],
		},
		execute: (input) =>
			callRemote(input.portal_url, String(input.tool), (input.arguments as Record<string, unknown>) ?? {}),
	})
}
