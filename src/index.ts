import { SwRoomCard } from './cards/sw-room-card';
import { SwRoomCardEditor } from './cards/sw-room-card-editor';
import { SwTabCard } from './cards/sw-tab-card';
import { SwTabCardEditor } from './cards/sw-tab-card-editor';
import { SwClimateCard } from './cards/sw-climate-card';
import { SwClimateCardEditor } from './cards/sw-climate-card-editor';
import { SwLightCard } from './cards/sw-light-card';
import { SwLightCardEditor } from './cards/sw-light-card-editor';
import { version as VERSION } from '../package.json';

customElements.define('sw-room-card', SwRoomCard);
customElements.define('sw-room-card-editor', SwRoomCardEditor);
customElements.define('sw-tab-card', SwTabCard);
customElements.define('sw-tab-card-editor', SwTabCardEditor);
customElements.define('sw-climate-card', SwClimateCard);
customElements.define('sw-climate-card-editor', SwClimateCardEditor);
customElements.define('sw-light-card', SwLightCard);
customElements.define('sw-light-card-editor', SwLightCardEditor);

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
  {
    type: 'sw-climate-card',
    name: 'SW Climate Card',
    description: 'Climate card showing temperature, humidity, graph and optional thermostat controls',
    preview: true,
    documentationURL: 'https://github.com/h4llow3En/lovelace-sweetwater-cards',
  },
  {
    type: 'sw-light-card',
    name: 'SW Light Card',
    description: 'Room light dial with proportional master dimming, per-light chips and color temperature',
    preview: true,
    documentationURL: 'https://github.com/h4llow3En/lovelace-sweetwater-cards',
  },
);

console.info(
  `%c SWEETWATER-CARDS %c v${VERSION} `,
  'color:#c9a96e;background:#141416;font-weight:bold;',
  'background:#c9a96e;color:#141416;font-weight:bold;',
);
