import { RemoteConsole } from 'vscode-languageserver/node';

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

	private remoteConsole: RemoteConsole|undefined;

	/**
	 * Attaches the connections RemoteConsole so that log calls are sent to the client
	 *
	 * @param {RemoteConsole} remoteConsole - The RemoteConsole from the server connection
	 * @memberof Logger
	 */
	public attach (remoteConsole: RemoteConsole): void {
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
