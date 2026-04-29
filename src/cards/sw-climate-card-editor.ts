import { LitElement, html, css } from 'lit';
import { state } from 'lit/decorators.js';
import type { HomeAssistant } from '../types/ha';
import type { ClimateCardConfig } from './sw-climate-card';

const MAIN_SCHEMA = [
  { name: 'title', selector: { text: {} } },
  { name: 'climate_entity', selector: { entity: { domain: 'climate' } } },
  { name: 'temp_entity', selector: { entity: { domain: ['sensor', 'climate'] } } },
  { name: 'humidity_entity', selector: { entity: { domain: ['sensor', 'climate'] } } },
  { name: 'hours_to_show', default: 24, selector: { number: { min: 1, max: 168, mode: 'box' } } },
] as const;

const SHOW_SCHEMA = [
  { name: 'graph', default: true, selector: { boolean: {} } },
  { name: 'humidity', default: true, selector: { boolean: {} } },
  { name: 'controls', default: false, selector: { boolean: {} } },
] as const;

const HOLD_ACTION_SCHEMA = [
  { name: 'hold_action', selector: { ui_action: {} } },
] as const;

const MAIN_LABELS: Record<string, string> = {
  title: 'Title (optional)',
  climate_entity: 'Climate Entity (optional)',
  temp_entity: 'Temperature Sensor (optional, fallback: climate.current_temperature)',
  humidity_entity: 'Humidity Sensor (optional, fallback: climate.current_humidity)',
  hours_to_show: 'Graph Hours to Show',
};

const SHOW_LABELS: Record<string, string> = {
  graph: 'Show Graph',
  humidity: 'Show Humidity',
  controls: 'Force Controls Visible (even without climate entity)',
};

const computeMainLabel = (schema: { name: string }) => MAIN_LABELS[schema.name] ?? schema.name;
const computeShowLabel = (schema: { name: string }) => SHOW_LABELS[schema.name] ?? schema.name;
const computeHoldLabel = () => 'Hold Action';

interface ConfigChangedDetail { config: ClimateCardConfig }

export class SwClimateCardEditor extends LitElement {
  @state() private _config?: ClimateCardConfig;
  private _hass?: HomeAssistant;

  setConfig(config: ClimateCardConfig) {
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

  private _showValueChanged(ev: CustomEvent) {
    ev.stopPropagation();
    if (!this._config) return;
    this._dispatch({ ...this._config, show: ev.detail.value });
  }

  private _holdActionChanged(ev: CustomEvent) {
    ev.stopPropagation();
    if (!this._config) return;
    this._dispatch({ ...this._config, hold_action: ev.detail.value.hold_action });
  }

  private _dispatch(config: ClimateCardConfig) {
    this.dispatchEvent(new CustomEvent<ConfigChangedDetail>('config-changed', {
      detail: { config },
      bubbles: true,
      composed: true,
    }));
  }

  static styles = css`
    .section {
      margin-top: 20px;
    }
    .section h3 {
      margin: 0 0 8px;
      font-size: 14px;
      font-weight: 500;
      color: var(--secondary-text-color);
    }
  `;

  render() {
    if (!this._hass || !this._config) return html``;
    return html`
      <ha-form
        .hass=${this._hass}
        .data=${this._config}
        .schema=${MAIN_SCHEMA}
        .computeLabel=${computeMainLabel}
        @value-changed=${this._valueChanged}
      ></ha-form>

      <div class="section">
        <h3>Visibility</h3>
        <ha-form
          .hass=${this._hass}
          .data=${this._config.show ?? {}}
          .schema=${SHOW_SCHEMA}
          .computeLabel=${computeShowLabel}
          @value-changed=${this._showValueChanged}
        ></ha-form>
      </div>

      <div class="section">
        <h3>Interactions</h3>
        <ha-form
          .hass=${this._hass}
          .data=${{ hold_action: this._config.hold_action ?? { action: 'none' } }}
          .schema=${HOLD_ACTION_SCHEMA}
          .computeLabel=${computeHoldLabel}
          @value-changed=${this._holdActionChanged}
        ></ha-form>
      </div>
    `;
  }
}
