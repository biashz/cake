import type { CakeApi } from '../../src/desktop/api.js';

declare global {
  interface Window {
    cake: CakeApi | undefined;
  }
}
