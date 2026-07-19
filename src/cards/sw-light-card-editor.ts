import { LitElement, html } from 'lit';
import { state } from 'lit/decorators.js';
import type { HomeAssistant } from '../types/ha';
import type { LightCardConfig } from './sw-light-card';

const SCHEMA = [
  { name: 'name', selector: { text: {} } },
  { name: 'area', selector: { area: {} } },
  { name: 'entities', selector: { entity: { domain: 'light', multiple: true } } },
  { name: 'main_entity', selector: { entity: { domain: 'light' } } },
  { name: 'scenes', selector: { entity: { domain: 'scene', multiple: true } } },
  { name: 'transition', default: 1, selector: { number: { min: 0, max: 10, step: 0.5, mode: 'box' } } },
  { name: 'show_color_temp', default: true, selector: { boolean: {} } },
] as const;

const LABELS: Record<string, string> = {
  name: 'Name (optional)',
  area: 'Area (auto-discovers lights)',
  entities: 'Lights (overrides area discovery)',
  main_entity: 'Main light (turn-on target when all lights are off; default: first light)',
  scenes: 'Scenes (shown as pills below the light chips)',
  transition: 'Scene transition (seconds)',
  show_color_temp: 'Show color temperature mode',
};

const computeLabel = (schema: { name: string }) => LABELS[schema.name] ?? schema.name;

interface ConfigChangedDetail { config: LightCardConfig }

export class SwLightCardEditor extends LitElement {
  @state() private _config?: LightCardConfig;
  private _hass?: HomeAssistant;

  setConfig(config: LightCardConfig) {
    this._config = config;
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    this.requestUpdate();
  }

  // Note: the entity multi-selector round-trips plain strings only. Per-chip
  // name/icon overrides (object form) are YAML-only and get flattened if the
  // entities field is edited here — documented in the README.
  private _valueChanged(ev: CustomEvent) {
    ev.stopPropagation();
    if (!this._config) return;
    this._dispatch({ ...this._config, ...ev.detail.value });
  }

  private _dispatch(config: LightCardConfig) {
    this.dispatchEvent(new CustomEvent<ConfigChangedDetail>('config-changed', {
      detail: { config },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    if (!this._hass || !this._config) return html``;
    // ha-form chokes on object-form entities; present entity ids only
    const data = {
      ...this._config,
      entities: (this._config.entities ?? []).map(e => (typeof e === 'string' ? e : e.entity)),
      scenes: (this._config.scenes ?? []).map(s => (typeof s === 'string' ? s : s.entity)),
    };
    return html`
      <ha-form
        .hass=${this._hass}
        .data=${data}
        .schema=${SCHEMA}
        .computeLabel=${computeLabel}
        @value-changed=${this._valueChanged}
      ></ha-form>
    `;
  }
}
