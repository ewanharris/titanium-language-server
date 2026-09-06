import { logger } from '../logger.ts';

/**
 * Runs a provider, containing anything it throws.
 *
 * A failed request is worse than an empty answer. An editor showing "request failed" for every
 * keystroke in a file the server cannot read is unusable, where "nothing to suggest" is merely
 * unhelpful — and the reason still reaches the client, through the log rather than through the
 * request.
 *
 * @param what - What was being attempted, for the log
 * @param fallback - What to answer instead
 * @param work - The provider
 * @returns {Promise<T>} What the provider answered, or the fallback
 */
export async function safely<T> (what: string, fallback: T, work: () => Promise<T>|T): Promise<T> {
	try {
		return await work();
	} catch (error) {
		logger.error(`Failed ${what}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		return fallback;
	}
}
