import { fileURLToPath } from 'node:url';
import { RequestType } from 'vscode-languageserver/node';

export interface TitaniumSDK {
	version: string;
	path: string;
	platforms: string[];
	githash: string;
	timestamp: string;
	fullversion?: string;
}

/**
 * Custom requests the server may make of a client.
 *
 * The target is for this to stay empty. Every entry here is something each editor has to
 * implement before the server works there, which is the opposite of the point.
 */
export const CustomRequests: Record<string, RequestType<unknown, unknown, void>> = {};

/**
 * The path to the server module, so an editor extension can bundle the server and spawn it
 * directly rather than requiring a global install.
 *
 * This is the same file the `titanium-language-server` command runs — the bin field points at it,
 * so there is one artifact and not two.
 *
 * This package is ESM, so a CommonJS extension host cannot always import this module to reach it —
 * `require(esm)` needs Node 20.19 or 22.12, and VS Code has shipped older. Resolution does not run
 * the module though, so such a host can get the same path from
 * `require.resolve('titanium-language-server/server')`.
 */
export const serverPath = fileURLToPath(import.meta.resolve('./server.js'));
