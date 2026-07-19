import { LitElement, html } from 'lit';
import { state } from 'lit/decorators.js';
import type { HomeAssistant } from '../types/ha';
import type { ScheduleCardConfig } from './sw-schedule-card';

const SCHEMA = [
  { name: 'name', selector: { text: {} } },
  { name: 'entities', selector: { entity: { multiple: true } } },
  { name: 'schedules', selector: { entity: { domain: 'switch', multiple: true } } },
  { name: 'discover', default: false, selector: { boolean: {} } },
  { name: 'time_step', default: 15, selector: { number: { min: 1, max: 60, mode: 'box' } } },
] as const;

const LABELS: Record<string, string> = {
  name: 'Title (optional)',
  entities: 'Target entities (show their schedules, offer creation)',
  schedules: 'Explicit schedule switches (optional, overrides target filter)',
  discover: 'Show all schedules when no filter is set',
  time_step: 'Editor time step (minutes)',
};

const computeLabel = (schema: { name: string }) => LABELS[schema.name] ?? schema.name;

interface ConfigChangedDetail { config: ScheduleCardConfig }

export class SwScheduleCardEditor extends LitElement {
  @state() private _config?: ScheduleCardConfig;
  private _hass?: HomeAssistant;

  setConfig(config: ScheduleCardConfig) {
    this._config = config;
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    this.requestUpdate();
  }

  private _valueChanged(ev: CustomEvent) {
    ev.stopPropagation();
    if (!this._config) return;
    this._dispatch({ ...this._config, ...ev.detail.value });
  }

  private _dispatch(config: ScheduleCardConfig) {
    this.dispatchEvent(new CustomEvent<ConfigChangedDetail>('config-changed', {
      detail: { config },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    if (!this._hass || !this._config) return html``;
    // ha-form's entity multi-selector round-trips plain strings; object-form
    // entities (per-row name/icon) are YAML-only and get flattened here.
    const data = {
      ...this._config,
      entities: (this._config.entities ?? []).map(e => (typeof e === 'string' ? e : e.entity)),
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
