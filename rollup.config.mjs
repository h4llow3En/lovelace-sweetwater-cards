import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const production = process.env.BUILD === 'production';
const haHost  = process.env.HA_HOST;   // e.g. user@homeassistant.local
const haPath  = process.env.HA_PATH;   // e.g. /config/www
const haUrl   = process.env.HA_URL;    // e.g. http://homeassistant.local:8123
const haToken = process.env.HA_TOKEN;  // long-lived access token

function deployPlugin() {
  if (!haHost || !haPath) return null;
  return {
    name: 'ha-deploy',
    writeBundle() {
      const src = 'sweetwater-cards.js';
      if (!existsSync(src)) return;
      try {
        execSync(`rsync -az ${src} ${haHost}:${haPath}/`, { stdio: 'inherit' });
        console.log(`[ha-deploy] deployed to ${haHost}:${haPath}/`);
      } catch {
        console.error('[ha-deploy] rsync failed');
        return;
      }
      if (haUrl && haToken) {
        try {
          execSync(
            `curl -sf -X POST "${haUrl}/api/services/frontend/reload_themes" ` +
            `-H "Authorization: Bearer ${haToken}" ` +
            `-H "Content-Type: application/json" -d "{}"`,
            { stdio: 'inherit' },
          );
          console.log('[ha-deploy] triggered Lovelace resource reload');
        } catch {
          console.warn('[ha-deploy] reload request failed (check HA_URL / HA_TOKEN)');
        }
      }
    },
  };
}

export default {
  input: 'src/index.ts',
  output: {
    file: 'sweetwater-cards.js',
    format: 'es',
    sourcemap: !production,
  },
  plugins: [
    json({ compact: true }),
    resolve(),
    typescript(),
    production && terser(),
    !production && deployPlugin(),
  ].filter(Boolean),
};
