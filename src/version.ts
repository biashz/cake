import pkg from '../package.json';

/** Single source of truth for the CLI version; inlined at build time. */
export const VERSION: string = pkg.version;
