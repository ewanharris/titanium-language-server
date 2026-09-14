/**
 * The Alloy runtime, as much of it as a controller reaches.
 *
 * Transcribed from `Alloy/lib/alloy/controllers/BaseController.js` and the controller template.
 * Deliberately shallow: `unknown` where the real answer is "whatever that id is", because a
 * confident wrong type is worse than an honest unknown, and the view members beside it carry the
 * types that matter.
 *
 * This is the members of the namespace rather than the namespace itself, so that the generator
 * writing the project declaration can put the project's own `CFG` and `create…` names inside the
 * same braces. It has to be the same braces: two `declare namespace Alloy` blocks both carrying
 * `interface Controller` would be the same interface declared twice, which is an error rather than
 * a merge.
 *
 * It lives here rather than beside the `$` declaration because it belongs to the project, not to a
 * view. `Alloy.CFG` and `Alloy.createController` are written in controllers with no view at all,
 * in `alloy.js`, and in lib files, and a namespace emitted per view would be absent from every one
 * of them.
 */
export const ALLOY_RUNTIME = `
	/** The base class for Alloy controllers */
	interface Controller {
		/** The arguments the controller was created with */
		args: Record<string, unknown>;
		/** Every element of the view that has an id */
		__views: Record<string, unknown>;

		/** The view with this id, or the first top level view when none is given */
		getView (id?: string): unknown;
		/** Every element of the view that has an id */
		getViews (): Record<string, unknown>;
		getViewEx (options: { recurse: boolean }): unknown;
		/** The root view elements of this controller */
		getTopLevelViews (): unknown[];
		removeView (id: string): void;
		addTopLevelView (view: unknown): void;
		setParent (parent: unknown): void;

		getProxyProperty (name: string): unknown;
		getProxyPropertyEx (name: string, options: { recurse: boolean }): unknown;
		addProxyProperty (name: string, value: unknown): void;
		removeProxyProperty (name: string): void;

		/** The style a class or id resolves to in this controller's stylesheet */
		createStyle (options: unknown): Record<string, unknown>;
		addClass (proxy: unknown, classes: string | string[], options?: unknown): void;
		removeClass (proxy: unknown, classes: string | string[], options?: unknown): void;
		resetClass (proxy: unknown, classes?: string | string[], options?: unknown): void;
		updateViews (views: Record<string, unknown>): Controller;

		addListener (proxy: unknown, type: string, callback: (...args: unknown[]) => void): string;
		getListener (proxy?: unknown, type?: string): unknown[];
		removeListener (proxy?: unknown, type?: string, callback?: (...args: unknown[]) => void): void;

		destroy (): void;

		// Backbone.Events, which every controller is extended with
		on (event: string, callback: (...args: unknown[]) => void, context?: unknown): Controller;
		off (event?: string, callback?: (...args: unknown[]) => void, context?: unknown): Controller;
		once (event: string, callback: (...args: unknown[]) => void, context?: unknown): Controller;
		trigger (event: string, ...args: unknown[]): Controller;
		listenTo (other: unknown, event: string, callback: (...args: unknown[]) => void): Controller;
		stopListening (other?: unknown, event?: string, callback?: (...args: unknown[]) => void): Controller;
	}

	/** \`<Require>\` and \`<Widget>\` both compile to a controller */
	type Require = Controller;
	type Widget = Controller;

	/** A Backbone model, as \`<Model instance="true">\` puts one on \`$\` */
	interface Model {
		attributes: Record<string, unknown>;
		id: unknown;
		get (attribute: string): unknown;
		set (attribute: string | Record<string, unknown>, value?: unknown): Model;
		has (attribute: string): boolean;
		unset (attribute: string): Model;
		clear (): Model;
		toJSON (): Record<string, unknown>;
		fetch (options?: unknown): unknown;
		save (attributes?: unknown, options?: unknown): unknown;
		destroy (options?: unknown): unknown;
		on (event: string, callback: (...args: unknown[]) => void, context?: unknown): Model;
		off (event?: string, callback?: (...args: unknown[]) => void, context?: unknown): Model;
		trigger (event: string, ...args: unknown[]): Model;
	}

	/** A Backbone collection, as \`<Collection instance="true">\` puts one on \`$\` */
	interface Collection {
		models: Model[];
		length: number;
		at (index: number): Model;
		get (id: unknown): Model | undefined;
		add (models: unknown, options?: unknown): Collection;
		remove (models: unknown, options?: unknown): Collection;
		reset (models?: unknown, options?: unknown): Collection;
		each (iterator: (model: Model, index: number) => void): void;
		toJSON (): Record<string, unknown>[];
		fetch (options?: unknown): unknown;
		on (event: string, callback: (...args: unknown[]) => void, context?: unknown): Collection;
		off (event?: string, callback?: (...args: unknown[]) => void, context?: unknown): Collection;
		trigger (event: string, ...args: unknown[]): Collection;
	}`;
