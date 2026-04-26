import { SwRoomCard } from './cards/sw-room-card';
import { SwTabCard } from './cards/sw-tab-card';
import { version as VERSION } from '../package.json';

customElements.define('sw-room-card', SwRoomCard);
customElements.define('sw-tab-card', SwTabCard);

declare global {
  interface Window {
    customCards?: Array<Record<string, unknown>>;
  }
}

window.customCards ??= [];
window.customCards.push(
  {
    type: 'sw-room-card',
    name: 'SW Room Card',
    description: 'Elegant room overview card with area auto-discovery and flexible status rows',
    preview: true,
    documentationURL: 'https://github.com/h4llow3En/lovelace-sweetwater-cards',
  },
  {
    type: 'sw-tab-card',
    name: 'SW Tab Card',
    description: 'Tab card with named, reusable card definitions',
    preview: false,
    documentationURL: 'https://github.com/h4llow3En/lovelace-sweetwater-cards',
  },
);

console.info(
  `%c SWEETWATER-CARDS %c v${VERSION} `,
  'color:#c9a96e;background:#141416;font-weight:bold;',
  'background:#c9a96e;color:#141416;font-weight:bold;',
);
