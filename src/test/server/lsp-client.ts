import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import path from 'path';

type MessageHandler = (message: Message) => void;
type RequestHandler = (params: unknown) => unknown;

interface Message {
	id?: number;
	method?: string;
	result?: unknown;
	params?: unknown;
}

/**
 * A deliberately strict language server client used for testing.
 *
 * Unlike the real clients it refuses to skip over anything that is not part of a Content-Length
 * framed message, so that anything the server writes to stdout directly, such as a stray
 * console.log, fails the test rather than being silently tolerated.
 */
export class LspTestClient {

	private child: ChildProcessWithoutNullStreams;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private pending = new Map<number, MessageHandler>();
	private handlers = new Map<string, RequestHandler>();

	public notifications: Message[] = [];
	public requests: Message[] = [];
	public stderr = '';

	constructor () {
		const serverPath = path.join(__dirname, '..', '..', 'server.js');
		this.child = spawn(process.execPath, [ serverPath, '--stdio' ], { stdio: 'pipe' });
		this.child.stdout.on('data', data => this.onData(data));
		this.child.stderr.on('data', data => {
			this.stderr += data.toString();
		});
	}

	/**
	 * Registers a handler for a request sent from the server to the client
	 *
	 * @param {string} method - The method to handle
	 * @param {Function} handler - Returns the result to respond with
	 */
	public onRequest (method: string, handler: RequestHandler): void {
		this.handlers.set(method, handler);
	}

	public sendNotification (method: string, params: unknown): void {
		this.write({ jsonrpc: '2.0', method, params });
	}

	public sendRequest<T> (method: string, params: unknown): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error(`Timed out waiting for a response to ${method}`)), 10000);
			this.pending.set(id, message => {
				clearTimeout(timeout);
				resolve(message.result as T);
			});
			this.write({ jsonrpc: '2.0', id, method, params });
		});
	}

	/**
	 * Waits for a request from the server with the given method
	 *
	 * @param {string} method - The method to wait for
	 * @param {number} timeoutMs - How long to wait before giving up
	 * @returns {Promise<Message>} The request that was received
	 */
	public waitForRequest (method: string, timeoutMs = 10000): Promise<Message> {
		const start = Date.now();
		return new Promise((resolve, reject) => {
			const check = (): void => {
				const request = this.requests.find(message => message.method === method);
				if (request) {
					return resolve(request);
				}
				if (Date.now() - start > timeoutMs) {
					return reject(new Error(`Timed out waiting for a ${method} request`));
				}
				setTimeout(check, 25);
			};
			check();
		});
	}

	/**
	 * Shuts the server down through the protocol so that it exits cleanly, which matters for
	 * coverage as a killed process never writes its coverage out
	 *
	 * @returns {Promise<void>}
	 */
	public async dispose (): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) {
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

	private write (message: unknown): void {
		const content = JSON.stringify(message);
		this.child.stdin.write(`Content-Length: ${Buffer.byteLength(content, 'utf-8')}\r\n\r\n${content}`);
	}

	private onData (data: Buffer): void {
		this.buffer = Buffer.concat([ this.buffer, data ]);

		for (;;) {
			const headerEnd = this.buffer.indexOf('\r\n\r\n');
			if (headerEnd === -1) {
				// Anything that is not the start of a valid header can never become one, so fail
				// fast rather than buffering junk until the test times out
				this.assertLooksLikeHeader(this.buffer.toString('utf-8'));
				return;
			}

			const header = this.buffer.subarray(0, headerEnd).toString('utf-8');
			this.assertLooksLikeHeader(header);

			const length = /Content-Length: (\d+)/.exec(header);
			if (!length) {
				throw new Error(`Message header without a Content-Length: ${JSON.stringify(header)}`);
			}

			const contentLength = parseInt(length[1], 10);
			const start = headerEnd + 4;
			if (this.buffer.length < start + contentLength) {
				return;
			}

			const content = this.buffer.subarray(start, start + contentLength).toString('utf-8');
			this.buffer = this.buffer.subarray(start + contentLength);
			this.dispatch(JSON.parse(content) as Message);
		}
	}

	/**
	 * Fails if anything other than message headers has been written to stdout
	 *
	 * @param {string} text - The unparsed text at the head of the buffer
	 */
	private assertLooksLikeHeader (text: string): void {
		if (text.length && !/^(Content-Length|Content-Type)/.test(text)) {
			throw new Error(`Unframed output on the servers stdout: ${JSON.stringify(text.slice(0, 200))}`);
		}
	}

	private dispatch (message: Message): void {
		if (message.id !== undefined && message.method === undefined) {
			const resolve = this.pending.get(message.id);
			this.pending.delete(message.id);
			resolve?.(message);
			return;
		}

		if (message.id !== undefined && message.method !== undefined) {
			this.requests.push(message);
			const handler = this.handlers.get(message.method);
			this.write({ jsonrpc: '2.0', id: message.id, result: handler ? handler(message.params) : null });
			return;
		}

		this.notifications.push(message);
	}
}
