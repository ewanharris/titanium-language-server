import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface Message {
	id?: number;
	method?: string;
	result?: unknown;
	params?: unknown;
}

type MessageHandler = (message: Message) => void;

export interface LspTestClientOptions {
	/**
	 * Let the server fetch `@types/titanium` from the registry.
	 *
	 * Off by default. A spawned server has the real npm acquirer, so a project with no types of
	 * its own would otherwise reach the network — from a suite that runs on six CI jobs and must
	 * not go red when the registry does. Offline, npm answers from an empty cache and fails in
	 * well under a second, which is what a machine with no network looks like to the server.
	 */
	network?: boolean;
	/** Where the server keeps fetched types. A fresh temporary directory when not given */
	typesCache?: string;
	/** How long to wait for any one request, in milliseconds */
	timeout?: number;
	/**
	 * Variables to set in the server's environment, over the test's own.
	 *
	 * A name replaces any spelling of it the test's environment has, because Windows has one
	 * variable called `Path` and `PATH` alike, and a child given both picks one of them.
	 */
	env?: NodeJS.ProcessEnv;
}

/**
 * A deliberately strict language server client, used for testing.
 *
 * Unlike a real client it refuses to skip over anything that is not a Content-Length framed
 * message, so anything the server writes to stdout directly — a stray console.log, say — fails the
 * test rather than being silently tolerated.
 */
export class LspTestClient {

	private child: ChildProcessWithoutNullStreams;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private pending = new Map<number, MessageHandler>();
	private rejectors = new Map<number, (error: Error) => void>();
	private spawnError: Error|undefined;

	public notifications: Message[] = [];
	public stderr = '';
	/** Where the server keeps fetched types, so a test can look at what landed there */
	public readonly typesCache: string;

	private timeout: number;
	/** A cache this client made, and so removes; one a test passed in is the test's to keep */
	private ownedCache: string|undefined;

	constructor (server?: string, args: string[] = [ '--stdio' ], options: LspTestClientOptions = {}) {
		// The sources, since that is what the suite runs: Node strips the types, so the server a
		// test drives is the one being edited. The tests that must drive the built artifact
		// instead — the bin, the installed command — pass its path in, and live in test/package.
		const target = server ?? path.join(import.meta.dirname, '..', '..', 'server.ts');

		this.timeout = options.timeout ?? 10000;
		this.ownedCache = options.typesCache ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'ti-ls-client-types-'));
		this.typesCache = options.typesCache ?? this.ownedCache as string;

		const overridden = new Set(Object.keys(options.env ?? {}).map(name => name.toLowerCase()));
		const inherited = Object.entries(process.env).filter(([ name ]) => !overridden.has(name.toLowerCase()));
		const env: NodeJS.ProcessEnv = { ...Object.fromEntries(inherited), ...options.env, TITANIUM_LANGUAGE_SERVER_TYPES_CACHE: this.typesCache };
		if (!options.network) {
			// only-if-cached against a cache that has never been written to: every lookup fails
			// fast and the same way on every machine, where the developer's own npm cache would
			// otherwise decide whether a test fetched anything
			env.npm_config_offline = 'true';
			env.npm_config_cache = path.join(this.typesCache, '.npm');
		}

		this.child = spawn(process.execPath, [ target, ...args ], { stdio: 'pipe', env });

		// A server that never starts is otherwise an uncaught exception or a ten second timeout
		// rather than a failing assertion. It can fail either way round: a spawn that never
		// produces a process, or one that starts and then leaves without answering.
		this.child.on('error', error => this.fail(error.message));
		this.child.on('exit', (code, signal) => {
			if (this.rejectors.size) {
				this.fail(`exited with ${signal ?? code}. stderr: ${this.stderr.trim()}`);
			}
		});
		this.child.stdout.on('data', data => this.onData(data));
		this.child.stderr.on('data', data => {
			this.stderr += data.toString();
		});
	}

	public sendNotification (method: string, params: unknown): void {
		this.write({ jsonrpc: '2.0', method, params });
	}

	public sendRequest<T> (method: string, params: unknown): Promise<T> {
		if (this.spawnError) {
			return Promise.reject(this.spawnError);
		}

		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), this.timeout);
			this.rejectors.set(id, error => {
				clearTimeout(timeout);
				reject(error);
			});
			this.pending.set(id, message => {
				clearTimeout(timeout);
				this.rejectors.delete(id);
				resolve(message.result as T);
			});
			this.write({ jsonrpc: '2.0', id, method, params });
		});
	}

	/**
	 * Shuts the server down through the protocol so it exits cleanly, which matters for coverage —
	 * a killed process never writes its coverage out.
	 */
	public async dispose (): Promise<void> {
		if (this.spawnError || this.child.exitCode !== null || this.child.signalCode !== null) {
			this.removeCache();
			return;
		}
		const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
		try {
			await this.sendRequest('shutdown', null);
			this.sendNotification('exit', null);
			await Promise.race([ exited, new Promise(resolve => setTimeout(resolve, 5000)) ]);
		} finally {
			this.child.kill();
			this.removeCache();
		}
	}

	private removeCache (): void {
		if (this.ownedCache) {
			fs.rmSync(this.ownedCache, { recursive: true, force: true });
		}
	}

	/**
	 * Fails every request in flight, so a server that never starts is a failing assertion rather
	 * than an uncaught exception or a ten second timeout
	 */
	private fail (reason: string): void {
		const error = new Error(`Server did not start: ${reason}`);
		this.spawnError = error;
		for (const reject of this.rejectors.values()) {
			reject(error);
		}
		this.rejectors.clear();
		this.pending.clear();
	}

	private write (message: unknown): void {
		if (this.spawnError) {
			return;
		}
		const content = JSON.stringify(message);
		this.child.stdin.write(`Content-Length: ${Buffer.byteLength(content, 'utf-8')}\r\n\r\n${content}`);
	}

	private onData (data: Buffer): void {
		this.buffer = Buffer.concat([ this.buffer, data ]);

		for (;;) {
			const headerEnd = this.buffer.indexOf('\r\n\r\n');
			if (headerEnd === -1) {
				this.assertLooksLikeHeader(this.buffer.toString('utf-8'));
				return;
			}

			const header = this.buffer.subarray(0, headerEnd).toString('utf-8');
			this.assertLooksLikeHeader(header);

			const length = /Content-Length: (\d+)/.exec(header);
			if (!length) {
				throw new Error(`Message header without a Content-Length: ${JSON.stringify(header)}`);
			}

			const start = headerEnd + 4;
			const contentLength = parseInt(length[1], 10);
			if (this.buffer.length < start + contentLength) {
				return;
			}

			const content = this.buffer.subarray(start, start + contentLength).toString('utf-8');
			this.buffer = this.buffer.subarray(start + contentLength);
			this.dispatch(JSON.parse(content) as Message);
		}
	}

	/**
	 * Fails if anything other than a message header has been written to stdout
	 */
	private assertLooksLikeHeader (text: string): void {
		if (text.length && !/^(Content-Length|Content-Type)/.test(text)) {
			throw new Error(`Unframed output on the server's stdout: ${JSON.stringify(text.slice(0, 200))}`);
		}
	}

	private dispatch (message: Message): void {
		if (message.id !== undefined && message.method === undefined) {
			const resolve = this.pending.get(message.id);
			this.pending.delete(message.id);
			resolve?.(message);
			return;
		}
		this.notifications.push(message);
	}
}
