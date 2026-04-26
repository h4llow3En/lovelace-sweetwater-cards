import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';

const production = process.env.BUILD === 'production';

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
  ].filter(Boolean),
};
