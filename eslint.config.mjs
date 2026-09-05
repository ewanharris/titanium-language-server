import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: [ 'out/**', 'node_modules/**', 'src/test/fixtures/**' ]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: [ '**/*.ts' ],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			indent: [ 'error', 'tab', { SwitchCase: 1 } ],
			quotes: [ 'error', 'single', { avoidEscape: true } ],
			semi: [ 'error', 'always' ],
			'comma-dangle': [ 'error', 'never' ],
			'eol-last': 'error',
			'no-trailing-spaces': 'error',
			// stdout is the JSON-RPC transport; a stray console.log corrupts the protocol stream
			'no-console': 'error',
			'@typescript-eslint/explicit-function-return-type': [ 'error', { allowExpressions: true } ],
			'@typescript-eslint/no-unused-vars': [ 'error', { argsIgnorePattern: '^_' } ]
		}
	},
	{
		files: [ 'src/test/**/*.ts' ],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off'
		}
	}
);
