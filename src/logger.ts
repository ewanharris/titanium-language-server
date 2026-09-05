/**
 * The sink a logger writes to when one is attached.
 *
 * Structural rather than the protocol's own `RemoteConsole` type, so that `core/` can log without
 * importing `vscode-languageserver`, which it must not. A `RemoteConsole` satisfies this shape.
 */
export interface LogSink {
	log (message: string): void;
	error (message: string): void;
}

/**
 * A logger for the language server.
 *
 * The server communicates with the client over stdio by default, so anything written to
 * process.stdout corrupts the JSON-RPC stream. `vscode-languageserver` does not patch the global
 * console, so `console.log` must never be used anywhere in this package. Instead everything is
 * routed through the connections RemoteConsole, which sends `window/logMessage` notifications, and
 * falls back to stderr before a connection has been established.
 */
class Logger {

	private remoteConsole: LogSink|undefined;

	/**
	 * Attaches the connections RemoteConsole so that log calls are sent to the client
	 *
	 * @param {LogSink} remoteConsole - The RemoteConsole from the server connection
	 * @memberof Logger
	 */
	public attach (remoteConsole: LogSink): void {
		this.remoteConsole = remoteConsole;
	}

	/**
	 * Detaches the RemoteConsole, subsequent log calls will be written to stderr
	 *
	 * @memberof Logger
	 */
	public detach (): void {
		this.remoteConsole = undefined;
	}

	public log (message: string): void {
		if (this.remoteConsole) {
			this.remoteConsole.log(message);
		} else {
			process.stderr.write(`${message}\n`);
		}
	}

	public error (message: string): void {
		if (this.remoteConsole) {
			this.remoteConsole.error(message);
		} else {
			process.stderr.write(`${message}\n`);
		}
	}
}

export const logger = new Logger();
