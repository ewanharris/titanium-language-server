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
 */
export const serverPath = require.resolve('./server');
