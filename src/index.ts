import { RequestType } from 'vscode-languageserver/node';

export interface TitaniumSDK {
	version: string;
	path: string;
	platforms: string[];
	githash: string;
	timestamp: string;
	fullversion?: string;
}

export const CustomRequests = {
	InstalledSdks: new RequestType<void, TitaniumSDK[], void>('titanium/installedSdks')
};

export const serverPath = require.resolve('./server');
