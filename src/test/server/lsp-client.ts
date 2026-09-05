import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';

interface Message {
	id?: number;
	method?: string;
	result?: unknown;
	params?: unknown;
}

type MessageHandler = (message: Message) => void;

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

	constructor (server?: string, args: string[] = [ '--stdio' ]) {
		// The same file an editor spawns, whether it found it through the bin, serverPath or
		// require.resolve. npm's generated shims run it under node, and so does this.
		const target = server ?? path.join(import.meta.dirname, '..', '..', 'server.js');
		this.child = spawn(process.execPath, [ target, ...args ], { stdio: 'pipe' });

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
			const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 10000);
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
			return;
		}
		const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
		try {
			await this.sendRequest('shutdown', null);
			this.sendNotification('exit', null);
			await Promise.race([ exited, new Promise(resolve => setTimeout(resolve, 5000)) ]);
		} finally {
			this.child.kill();
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
