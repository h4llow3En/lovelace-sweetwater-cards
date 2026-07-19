import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { HomeAssistant } from '../types/ha';
import {
  fetchHistory, getCachedHistory,
  fetchHistoryAttrTemp, getCachedHistoryAttrTemp,
  type HistoryPoint,
} from '../utils/history';
import { buildGraph } from '../utils/graph';

// ── Action types ─────────────────────────────────────────────────────────────

interface TapAction {
  action: 'none' | 'more-info' | 'navigate' | 'url' | 'toggle' | 'call-service';
  entity?: string;
  navigation_path?: string;
  url_path?: string;
  service?: string;
  service_data?: Record<string, unknown>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const FETCH_RETRY_BACKOFF_MS = 60_000;
const HOLD_DURATION_MS = 500;
const TARGET_TEMP_RESET_MS = 5_000;

// ── Mode icons ────────────────────────────────────────────────────────────────

const MODE_ICONS: Record<string, string> = {
  off: 'mdi:power',
  heat: 'mdi:fire',
  cool: 'mdi:snowflake',
  auto: 'mdi:autorenew',
  heat_cool: 'mdi:autorenew',
  dry: 'mdi:water-percent',
  fan_only: 'mdi:fan',
};

// ── Config types ──────────────────────────────────────────────────────────────

export interface ClimateCardConfig {
  title?: string;
  climate_entity?: string;
  temp_entity?: string;
  humidity_entity?: string;
  hours_to_show?: number;
  modes?: string[];
  mode_icons?: Record<string, string>;
  show?: {
    graph?: boolean;
    humidity?: boolean;
    controls?: boolean;
  };
  hold_action?: TapAction;
  styles?: Record<string, string>;
}

// ── Card ─────────────────────────────────────────────────────────────────────

export class SwClimateCard extends LitElement {
  @state() private _history: HistoryPoint[] | null = null;
  @state() private _targetTemp: number | null = null;

  private _hass?: HomeAssistant;
  private _config?: ClimateCardConfig;
  private _fetchPending = false;
  private _trackedKey: string | null = null;
  private _fetchFailedAt = 0;
  private _appliedVars = new Set<string>();
  private _stepTimer?: number;
  private _holdTimer?: number;

  // ── HA card interface ───────────────────────────────────────────────────────

  set hass(hass: HomeAssistant) {
    const old = this._hass;
    this._hass = hass;

    this._maybeUpdateHistory(hass);

    let dirty = !old;
    if (!dirty && old) {
      for (const eid of this._trackedEntities()) {
        if (old.states[eid] !== hass.states[eid]) { dirty = true; break; }
      }
    }

    // Sync optimistic target temp back to entity once entity catches up
    if (this._targetTemp != null && this._config?.climate_entity) {
      const s = hass.states[this._config.climate_entity];
      const entityTemp = s?.attributes?.temperature as number | undefined;
      if (entityTemp != null && Math.abs(entityTemp - this._targetTemp) < 0.05) {
        this._targetTemp = null;
      }
    }

    if (dirty) this.requestUpdate();
  }

  get hass(): HomeAssistant { return this._hass!; }

  setConfig(config: ClimateCardConfig): void {
    if (!config) throw new Error('sw-climate-card: missing config');
    this._config = config;
    this._history = null;
    this._targetTemp = null;
    this._trackedKey = null;

    this._appliedVars.forEach(p => this.style.removeProperty(p));
    this._appliedVars.clear();
    for (const [k, v] of Object.entries(config.styles ?? {})) {
      const prop = k.startsWith('--') ? k : `--sw-climate-${k}`;
      this.style.setProperty(prop, String(v));
      this._appliedVars.add(prop);
    }

    if (this._hass) this._maybeUpdateHistory(this._hass);
    this.requestUpdate();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._stepTimer) { clearTimeout(this._stepTimer); this._stepTimer = undefined; }
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = undefined; }
  }

  getCardSize(): number { return 2; }

  static async getConfigElement() {
    return document.createElement('sw-climate-card-editor');
  }

  static getStubConfig(): ClimateCardConfig {
    return { hours_to_show: 24 };
  }

  // ── Entity helpers ───────────────────────────────────────────────────────────

  private _trackedEntities(): string[] {
    const cfg = this._config;
    if (!cfg) return [];
    const ids: string[] = [];
    if (cfg.temp_entity) ids.push(cfg.temp_entity);
    if (cfg.humidity_entity) ids.push(cfg.humidity_entity);
    if (cfg.climate_entity) ids.push(cfg.climate_entity);
    return ids;
  }

  private _climateState() {
    const id = this._config?.climate_entity;
    if (!id || !this._hass) return null;
    return this._hass.states[id] ?? null;
  }

  // ── History ─────────────────────────────────────────────────────────────────

  private _maybeUpdateHistory(hass: HomeAssistant): void {
    const cfg = this._config;
    const tempId = cfg?.temp_entity ?? cfg?.climate_entity ?? null;
    const useAttrTemp = !cfg?.temp_entity && !!cfg?.climate_entity;
    const hours = cfg?.hours_to_show ?? 24;
    const key = tempId ? `${tempId}${useAttrTemp ? ':a' : ''}:${hours}` : null;

    if (key !== this._trackedKey) {
      this._trackedKey = key;
      this._history = null;
      this._fetchFailedAt = 0;
    }
    if (!key || this._fetchPending) return;
    // Back off retries after a failure to avoid flooding during outages
    if (this._fetchFailedAt && Date.now() - this._fetchFailedAt < FETCH_RETRY_BACKOFF_MS) return;

    const cached = useAttrTemp
      ? getCachedHistoryAttrTemp(tempId!, hours)
      : getCachedHistory(tempId!, hours);
    if (cached) { if (!this._history) this._history = cached; return; }

    const fetcher = useAttrTemp ? fetchHistoryAttrTemp : fetchHistory;
    this._fetchPending = true;
    fetcher(hass, tempId!, hours).then(data => {
      this._fetchPending = false;
      if (data == null) {
        this._fetchFailedAt = Date.now();
      } else {
        this._fetchFailedAt = 0;
        this._history = data;
      }
    });
  }

  // ── Display value resolution ─────────────────────────────────────────────────

  private _currentTemp(): string | null {
    const cfg = this._config;
    if (!cfg || !this._hass) return null;

    if (cfg.temp_entity) {
      const s = this._hass.states[cfg.temp_entity];
      if (!s) return null;
      const num = parseFloat(s.state);
      return isNaN(num) ? null : num.toFixed(1) + '°C';
    }

    if (cfg.climate_entity) {
      const s = this._hass.states[cfg.climate_entity];
      if (!s) return null;
      const val = s.attributes.current_temperature as number | undefined;
      if (val == null) return null;
      return parseFloat(String(val)).toFixed(1) + '°C';
    }

    return null;
  }

  private _currentHumidity(): string | null {
    const cfg = this._config;
    if (!cfg || !this._hass) return null;
    const show = cfg.show ?? {};
    if (show.humidity === false) return null;

    if (cfg.humidity_entity) {
      const s = this._hass.states[cfg.humidity_entity];
      if (!s) return null;
      const num = parseFloat(s.state);
      return isNaN(num) ? null : Math.round(num) + '%';
    }

    if (cfg.climate_entity) {
      const s = this._hass.states[cfg.climate_entity];
      if (!s) return null;
      const val = s.attributes.current_humidity as number | undefined;
      if (val == null) return null;
      return Math.round(val) + '%';
    }

    return null;
  }

  private _targetTempDisplay(): string {
    if (this._targetTemp != null) return this._targetTemp.toFixed(1) + '°';
    const s = this._climateState();
    if (!s) return '–';
    const val = s.attributes.temperature as number | undefined;
    if (val == null) return '–';
    return parseFloat(String(val)).toFixed(1) + '°';
  }

  private _availableModes(): string[] {
    const s = this._climateState();
    if (!s) return [];
    const entityModes = (s.attributes.hvac_modes as string[] | undefined) ?? [];
    const filterModes = this._config?.modes;
    if (filterModes?.length) {
      return entityModes.filter(m => filterModes.includes(m));
    }
    return entityModes;
  }

  private _modeIcon(mode: string): string {
    return this._config?.mode_icons?.[mode] ?? MODE_ICONS[mode] ?? 'mdi:fan';
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  private _stepTemp(dir: number): void {
    const s = this._climateState();
    if (!s) return;
    const current = this._targetTemp ?? (s.attributes.temperature as number | undefined) ?? 20;
    const min = (s.attributes.min_temp as number | undefined) ?? 5;
    const max = (s.attributes.max_temp as number | undefined) ?? 35;
    const next = Math.max(min, Math.min(max, Math.round((current + dir * 0.5) * 2) / 2));
    this._targetTemp = next;

    if (this._stepTimer) clearTimeout(this._stepTimer);
    this._stepTimer = window.setTimeout(() => {
      this._targetTemp = null;
      this._stepTimer = undefined;
    }, TARGET_TEMP_RESET_MS);

    this._hass?.callService('climate', 'set_temperature', {
      entity_id: this._config!.climate_entity,
      temperature: next,
    });
  }

  private _setMode(mode: string): void {
    this._hass?.callService('climate', 'set_hvac_mode', {
      entity_id: this._config!.climate_entity,
      hvac_mode: mode,
    });
  }

  private _openMoreInfo(): void {
    const entityId = this._config?.climate_entity;
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent('hass-more-info', {
      detail: { entityId }, bubbles: true, composed: true,
    }));
  }

  private _fireAction(action: TapAction): void {
    switch (action.action) {
      case 'none': break;
      case 'more-info': {
        const entityId = action.entity ?? this._config?.climate_entity;
        if (entityId) this.dispatchEvent(new CustomEvent('hass-more-info', {
          detail: { entityId }, bubbles: true, composed: true,
        }));
        break;
      }
      case 'navigate':
        if (action.navigation_path) {
          window.history.pushState(null, '', action.navigation_path);
          this.dispatchEvent(new CustomEvent('location-changed', { bubbles: true, composed: true }));
        }
        break;
      case 'url':
        if (action.url_path) window.open(action.url_path, '_blank');
        break;
      case 'toggle':
        if (action.entity) this._hass?.callService('homeassistant', 'toggle', { entity_id: action.entity });
        break;
      case 'call-service': {
        const [domain, service] = (action.service ?? '').split('.');
        if (domain && service) this._hass?.callService(domain, service, action.service_data ?? {});
        break;
      }
    }
  }

  private _onPointerDown(e: PointerEvent): void {
    const action = this._config?.hold_action;
    if (!action || action.action === 'none') return;
    this._holdTimer = window.setTimeout(() => {
      this._holdTimer = undefined;
      this._fireAction(action);
    }, HOLD_DURATION_MS);
    // Capture so pointerup reliably fires on this element even if pointer moves
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  private _onPointerUp(e: PointerEvent): void {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      this._holdTimer = undefined;
    }
    const el = e.currentTarget as Element;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  render() {
    if (!this._config || !this._hass) return nothing;

    const cfg = this._config;
    const show = cfg.show ?? {};
    const climateState = this._climateState();
    const hasClimate = !!climateState;
    const showControls = hasClimate || show.controls === true;
    const showGraph = show.graph !== false;

    const temp = this._currentTemp();
    const humidity = this._currentHumidity();
    const currentMode = climateState?.state ?? null;
    const isOff = currentMode === 'off';
    const modes = this._availableModes();

    const graphSvg = showGraph
      ? buildGraph(this._history, cfg.hours_to_show ?? 24, {
          colorVar: '--sw-climate-color',
          widthVar: '--sw-climate-graph-width',
          fillOpacity: 0.12,
          gradientId: 'sw-climate-grad',
        })
      : '';

    const hasHold = !!cfg.hold_action && cfg.hold_action.action !== 'none';

    return html`
      <ha-card
        ?data-hold=${hasHold}
        @pointerdown=${this._onPointerDown}
        @pointerup=${this._onPointerUp}
        @pointercancel=${this._onPointerUp}
      >
        ${cfg.title ? html`<div class="title">${cfg.title}</div>` : nothing}
        <div class="body ${cfg.title ? 'body--with-title' : ''}">
          <div class="values">
            ${temp ? html`<span class="temp">${temp}</span>` : nothing}
            ${humidity ? html`<span class="humidity">${humidity}</span>` : nothing}
          </div>
          ${showControls ? html`
            <div class="controls ${!hasClimate ? 'controls--disabled' : ''}"
                 @pointerdown=${(e: Event) => e.stopPropagation()}>
              <div class="stepper">
                <button
                  class="step-btn"
                  @click=${() => this._stepTemp(-1)}
                  ?disabled=${isOff || !hasClimate}
                >
                  <ha-icon icon="mdi:chevron-left"></ha-icon>
                </button>
                <span
                  class="target-temp ${isOff ? 'target-temp--off' : ''}"
                  @click=${this._openMoreInfo}
                >${this._targetTempDisplay()}</span>
                <button
                  class="step-btn"
                  @click=${() => this._stepTemp(1)}
                  ?disabled=${isOff || !hasClimate}
                >
                  <ha-icon icon="mdi:chevron-right"></ha-icon>
                </button>
              </div>
              ${modes.length ? html`
                <div class="mode-pills">
                  ${modes.map(mode => html`
                    <button
                      class="mode-pill ${mode === currentMode ? 'mode-pill--active' : ''}"
                      @click=${() => this._setMode(mode)}
                      title=${mode}
                    >
                      <ha-icon icon=${this._modeIcon(mode)}></ha-icon>
                    </button>
                  `)}
                </div>
              ` : nothing}
            </div>
          ` : nothing}
        </div>
        ${graphSvg ? html`<div class="graph">${unsafeHTML(graphSvg)}</div>` : nothing}
      </ha-card>`;
  }

  // ── Styles ───────────────────────────────────────────────────────────────────

  static styles = css`
    :host {
      display: block;
      --sw-climate-color:           var(--primary-color);
      --sw-climate-active-text:     var(--text-primary-color, #fff);
      --sw-climate-text:            var(--primary-text-color);
      --sw-climate-text-secondary:  var(--secondary-text-color);
      --sw-climate-text-disabled:   var(--disabled-text-color);
      --sw-climate-border:          var(--divider-color);
      --sw-climate-font:            var(--primary-font-family, sans-serif);
      --sw-climate-height:          120px;
      --sw-climate-graph-height:    100%;
      --sw-climate-graph-width:     0px;
    }

    ha-card {
      position: relative;
      min-height: var(--sw-climate-height);
      overflow: hidden;
      padding: 0;
      font-family: var(--sw-climate-font);
    }

    ha-card[data-hold] { cursor: pointer; }

    .title {
      position: absolute;
      top: 8px;
      left: 16px;
      font-size: 9px;
      color: var(--sw-climate-text-disabled);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      z-index: 3;
      pointer-events: none;
    }

    .body {
      position: relative;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px;
      min-height: var(--sw-climate-height);
      box-sizing: border-box;
    }

    .body--with-title {
      padding-top: 28px;
    }

    .values {
      display: flex;
      align-items: baseline;
      gap: 10px;
    }

    .temp {
      font-size: 28px;
      font-weight: 300;
      color: var(--sw-climate-text);
      line-height: 1;
    }

    .humidity {
      font-size: 16px;
      font-weight: 300;
      color: var(--sw-climate-text-secondary);
      line-height: 1;
    }

    .controls {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }

    .controls--disabled {
      opacity: 0.4;
      pointer-events: none;
    }

    .stepper {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .step-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--sw-climate-text-secondary);
      padding: 2px;
      display: flex;
      align-items: center;
      --mdi-icon-size: 16px;
    }

    .step-btn:disabled {
      opacity: 0.3;
      cursor: default;
    }

    .target-temp {
      font-size: 16px;
      color: var(--sw-climate-text-secondary);
      cursor: pointer;
      min-width: 52px;
      text-align: center;
      user-select: none;
      transition: opacity 0.2s;
    }

    .target-temp--off {
      opacity: 0.35;
    }

    .mode-pills {
      display: flex;
      gap: 4px;
    }

    .mode-pill {
      background: none;
      border: 1px solid var(--sw-climate-border);
      border-radius: 4px;
      padding: 3px 5px;
      cursor: pointer;
      color: var(--sw-climate-text-disabled);
      display: flex;
      align-items: center;
      --mdi-icon-size: 14px;
      transition: background 0.2s, border-color 0.2s, color 0.2s;
    }

    .mode-pill--active {
      background: var(--sw-climate-color);
      border-color: var(--sw-climate-color);
      color: var(--sw-climate-active-text);
    }

    .graph {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: var(--sw-climate-graph-height);
      z-index: 1;
      overflow: hidden;
      pointer-events: none;
    }
  `;
}
