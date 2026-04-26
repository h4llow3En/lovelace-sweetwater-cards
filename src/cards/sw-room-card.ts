import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { HomeAssistant, EntityRegistryEntry, AreaRegistryEntry } from '../types/ha';
import { fetchHistory, getCachedHistory, type HistoryPoint } from '../utils/history';
import { buildGraph } from '../utils/graph';

// ── Config types ──────────────────────────────────────────────────────────────

interface CustomItem {
  entity: string;
  display?: 'dot' | 'value';
  unit?: string;
  shape?: 'square' | 'circle';
  pulse?: boolean;
  color_on?: string;
  color_off?: string;
  color_warn?: string;
  warn_above?: number;
}

interface RowConfig {
  type: 'lights' | 'windows' | 'custom';
  label?: string;
  show?: boolean;
  entities?: string[];
  content?: CustomItem[];
}

interface TapAction {
  action: 'none' | 'more-info' | 'navigate' | 'url' | 'toggle' | 'call-service';
  entity?: string;
  navigation_path?: string;
  url_path?: string;
  service?: string;
  service_data?: Record<string, unknown>;
}

export interface RoomCardConfig {
  area?: string;
  name?: string;
  floor?: string;
  icon?: string;
  align?: 'left' | 'center' | 'right';
  temp_entity?: string;
  humidity_entity?: string;
  hours_to_show?: number;
  rows?: RowConfig[];
  show?: Record<string, boolean>;
  styles?: Record<string, string>;
  tap_action?: TapAction;
}

// ── Card ─────────────────────────────────────────────────────────────────────

export class SwRoomCard extends LitElement {
  @state() private _history: HistoryPoint[] | null = null;

  private _hass?: HomeAssistant;
  private _config?: RoomCardConfig;
  private _activeEntities = new Set<string>();
  private _fetchPending = false;
  private _trackedKey: string | null = null;
  private _appliedVars = new Set<string>();

  // Resolved on discovery
  private _resolvedArea: AreaRegistryEntry | null = null;
  private _areaEntities: EntityRegistryEntry[] = [];
  private _resolvedTempId: string | null = null;
  private _resolvedHumidityId: string | null = null;

  // ── HA card interface ───────────────────────────────────────────────────────

  set hass(hass: HomeAssistant) {
    const old = this._hass;
    this._hass = hass;

    const needsDiscovery = !old
      || old.areas !== hass.areas
      || old.entities !== hass.entities
      || old.devices !== hass.devices;

    if (needsDiscovery) this._discoverEntities();

    this._maybeUpdateHistory(hass);

    // Only re-render if a tracked entity actually changed
    let dirty = needsDiscovery || !old;
    if (!dirty && old) {
      for (const eid of this._activeEntities) {
        if (old.states[eid] !== hass.states[eid]) { dirty = true; break; }
      }
    }
    if (dirty) this.requestUpdate();
  }

  get hass(): HomeAssistant { return this._hass!; }

  setConfig(config: RoomCardConfig): void {
    if (!config) throw new Error('sw-room-card: missing config');
    this._config = config;
    this._history = null;
    this._trackedKey = null;

    this._appliedVars.forEach(p => this.style.removeProperty(p));
    this._appliedVars.clear();
    for (const [k, v] of Object.entries(config.styles ?? {})) {
      const prop = k.startsWith('--') ? k : `--sw-room-card-${k}`;
      this.style.setProperty(prop, String(v));
      this._appliedVars.add(prop);
    }

    if (this._hass) this._discoverEntities();
    this.requestUpdate();
  }

  getCardSize(): number { return 3; }

  static getStubConfig(): RoomCardConfig {
    return { area: '', hours_to_show: 24, rows: [{ type: 'lights' }, { type: 'windows' }] };
  }

  // ── Discovery ───────────────────────────────────────────────────────────────

  private _discoverEntities(): void {
    const areaId = this._config?.area;
    this._resolvedArea = areaId && areaId !== 'none'
      ? (this._hass?.areas[areaId] ?? null)
      : null;

    this._areaEntities = this._getAreaEntities();
    this._resolvedTempId = this._resolveTempEntityId();
    this._resolvedHumidityId = this._resolveHumidityEntityId();
  }

  private _getAreaEntities(): EntityRegistryEntry[] {
    const areaId = this._config?.area;
    if (!areaId || areaId === 'none' || !this._hass?.entities) return [];
    const devices = this._hass.devices ?? {};
    return Object.values(this._hass.entities).filter(e =>
      e.area_id === areaId || (!e.area_id && e.device_id && devices[e.device_id]?.area_id === areaId),
    );
  }

  private _resolveTempEntityId(): string | null {
    const cfg = this._config?.temp_entity;
    if (cfg === 'none') return null;
    const show = this._config?.show ?? {};
    if (show.temp === false || show.graph === false) return null;
    if (cfg) return cfg;

    const sensor = this._areaEntities.find(e =>
      e.entity_id.startsWith('sensor.')
      && this._hass?.states[e.entity_id]?.attributes?.device_class === 'temperature',
    );
    if (sensor) return sensor.entity_id;

    return this._areaEntities.find(e => e.entity_id.startsWith('climate.'))?.entity_id ?? null;
  }

  private _resolveHumidityEntityId(): string | null {
    const cfg = this._config?.humidity_entity;
    const show = this._config?.show ?? {};
    if (cfg === 'none' || show.humidity === false) return null;
    if (cfg) return cfg;
    if (show.humidity !== true) return null;

    return this._areaEntities.find(e =>
      e.entity_id.startsWith('sensor.')
      && this._hass?.states[e.entity_id]?.attributes?.device_class === 'humidity',
    )?.entity_id ?? null;
  }

  // ── History ─────────────────────────────────────────────────────────────────

  private _maybeUpdateHistory(hass: HomeAssistant): void {
    const tempId = this._resolvedTempId;
    const hours = this._config?.hours_to_show ?? 24;
    const key = tempId ? `${tempId}:${hours}` : null;

    if (key !== this._trackedKey) {
      this._trackedKey = key;
      this._history = null;
    }
    if (!key || this._fetchPending) return;

    const cached = getCachedHistory(tempId!, hours);
    if (cached) { if (!this._history) this._history = cached; return; }

    this._fetchPending = true;
    fetchHistory(hass, tempId!, hours).then(data => {
      this._history = data;
      this._fetchPending = false;
    });
  }

  // ── State helpers ────────────────────────────────────────────────────────────

  private _getState(entityId: string) {
    this._activeEntities.add(entityId);
    return this._hass?.states[entityId] ?? null;
  }

  private _floor(): string | null {
    const floorId = this._resolvedArea?.floor_id;
    return floorId ? (this._hass?.floors?.[floorId]?.name ?? null) : null;
  }

  private _tempDisplay(): string | null {
    const id = this._resolvedTempId;
    if (!id) return null;
    const s = this._getState(id);
    if (!s) return null;
    const raw = id.startsWith('climate.')
      ? (s.attributes.current_temperature as number | undefined)
      : s.state;
    const num = parseFloat(String(raw));
    return isNaN(num) ? null : num.toFixed(1) + '°C';
  }

  private _humidityDisplay(): string | null {
    const id = this._resolvedHumidityId;
    if (!id) return null;
    const s = this._getState(id);
    if (!s) return null;
    const num = parseFloat(s.state);
    return isNaN(num) ? null : Math.round(num) + '%';
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  private _handleTap(): void {
    const action = this._config?.tap_action ?? { action: 'more-info' as const };
    switch (action.action) {
      case 'none': break;
      case 'more-info': {
        const entityId = action.entity ?? this._resolvedTempId;
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

  // ── Row rendering ────────────────────────────────────────────────────────────

  private _dot(color: string, shape?: 'square' | 'circle', pulse = false): TemplateResult {
    const radius = shape === 'square' ? '1.5px' : '50%';
    return html`<div class="dot" style="border-radius:${radius};background:${color};" data-pulse="${pulse}"></div>`;
  }

  private _row(label: string, items: TemplateResult[]): TemplateResult {
    return html`
      <div class="row">
        <span class="row-label">${label}</span>
        <div class="row-content">${items}</div>
      </div>`;
  }

  private _renderRow(cfg: RowConfig): TemplateResult | typeof nothing {
    if (cfg.show === false) return nothing;
    const DIM = 'var(--sw-room-card-inactive)';

    switch (cfg.type) {
      case 'lights': {
        const ids = cfg.entities
          ?? this._areaEntities.filter(e => e.entity_id.startsWith('light.')).map(e => e.entity_id);
        if (!ids.length) return nothing;
        const dots = ids.map(id => {
          const s = this._getState(id);
          return s ? this._dot(s.state === 'on' ? 'var(--sw-room-card-color)' : DIM) : nothing as unknown as TemplateResult;
        });
        const label = cfg.label ?? this._hass?.localize('component.light.entity_component._.name') ?? 'Lights';
        return this._row(label, dots);
      }

      case 'windows': {
        const WINDOW_CLASSES = ['window', 'door', 'garage_door'];
        const ids = cfg.entities ?? this._areaEntities.filter(e => {
          const dc = this._hass?.states[e.entity_id]?.attributes?.device_class as string | undefined;
          return e.entity_id.startsWith('binary_sensor.') && WINDOW_CLASSES.includes(dc ?? '');
        }).map(e => e.entity_id);
        if (!ids.length) return nothing;
        const dots = ids.map(id => {
          const s = this._getState(id);
          return s ? this._dot(s.state === 'on' ? 'var(--sw-room-card-color-2)' : DIM, 'square') : nothing as unknown as TemplateResult;
        });
        const label = cfg.label
          ?? this._hass?.localize('component.binary_sensor.entity_component.window.name')
          ?? 'Windows';
        return this._row(label, dots);
      }

      case 'custom': {
        if (!cfg.content?.length) return nothing;
        const parts: TemplateResult[] = cfg.content.map(item => {
          const s = this._getState(item.entity);
          if (!s) return nothing as unknown as TemplateResult;

          if (item.display === 'value') {
            const val = parseFloat(s.state);
            const unit = item.unit ?? (s.attributes.unit_of_measurement as string | undefined) ?? '';
            const raw = isNaN(val) ? s.state : Math.round(val) + (unit ? ' ' + unit : '');
            const warn = item.warn_above != null && val > item.warn_above;
            const col = warn ? (item.color_warn ?? 'var(--sw-room-card-warn)') : 'var(--sw-room-card-text-secondary)';
            return html`<span class="val" style="color:${col};">${raw}</span>`;
          }

          const active = s.state === 'on';
          return this._dot(
            active ? (item.color_on ?? 'var(--sw-room-card-color)') : (item.color_off ?? DIM),
            item.shape,
            active && !!item.pulse,
          );
        });
        return this._row(cfg.label ?? '', parts);
      }

      default: return nothing;
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  render() {
    if (!this._config || !this._hass) return nothing;
    this._activeEntities.clear();

    const cfg = this._config;
    const show = cfg.show ?? {};
    const area = this._resolvedArea;

    const iconCfg = cfg.icon ?? area?.icon ?? 'mdi:home';
    const nameCfg = cfg.name;
    const floorCfg = cfg.floor ?? this._floor();
    const align = cfg.align ?? 'left';

    const showIcon = show.icon !== false && iconCfg !== 'none';
    const showName = show.name !== false && nameCfg !== 'none';
    const showFloor = show.floor !== false && floorCfg != null && floorCfg !== 'none';
    const showTemp = show.temp !== false && cfg.temp_entity !== 'none';
    const showGraph = show.graph !== false && cfg.temp_entity !== 'none';

    const name = (nameCfg && nameCfg !== 'none') ? nameCfg : (area?.name ?? 'Raum');
    const floor = floorCfg ?? '';
    const icon = (iconCfg && iconCfg !== 'none') ? iconCfg : 'mdi:home';

    const tempValue = showTemp ? this._tempDisplay() : null;
    const humidValue = this._humidityDisplay();
    const graphSvg = showGraph && this._resolvedTempId
      ? buildGraph(this._history, cfg.hours_to_show ?? 24)
      : '';

    const rows = show.rows !== false
      ? (cfg.rows ?? []).map(r => this._renderRow(r))
      : [];
    const hasRows = rows.some(r => r !== nothing);
    const hasBottom = tempValue || humidValue;
    const actionable = (cfg.tap_action?.action ?? 'more-info') !== 'none';

    return html`
      <ha-card ?data-actionable=${actionable} @click=${this._handleTap}>
        <div class="header">
          <div class="identity identity--${align}">
            ${showIcon ? html`<ha-icon class="room-icon" icon=${icon}></ha-icon>` : nothing}
            ${showName ? html`<div class="name">${name}</div>` : nothing}
            ${showFloor && floor ? html`<div class="floor">${floor}</div>` : nothing}
          </div>
          ${hasRows ? html`<div class="status">${rows}</div>` : nothing}
        </div>
        ${hasBottom ? html`
          <div class="bottom-strip">
            <div class="temp">${tempValue ?? ''}</div>
            ${humidValue ? html`<div class="humidity">${humidValue}</div>` : nothing}
          </div>` : nothing}
        ${graphSvg ? html`<div class="graph">${unsafeHTML(graphSvg)}</div>` : nothing}
      </ha-card>`;
  }

  // ── Styles ───────────────────────────────────────────────────────────────────

  static styles = css`
    :host {
      display: block;
      --sw-room-card-color:          var(--primary-color);
      --sw-room-card-color-2:        var(--info-color, var(--accent-color, var(--primary-color)));
      --sw-room-card-ok:             var(--success-color,  #6dbf8a);
      --sw-room-card-warn:           var(--warning-color,  #e8a44a);
      --sw-room-card-error:          var(--error-color,    #e06b6b);
      --sw-room-card-text:           var(--primary-text-color);
      --sw-room-card-text-secondary: var(--secondary-text-color);
      --sw-room-card-text-disabled:  var(--disabled-text-color);
      --sw-room-card-inactive:       var(--divider-color);
      --sw-room-card-font:           var(--primary-font-family, sans-serif);
      --sw-room-card-height:         240px;
      --sw-room-card-graph-height:   60px;
      --sw-room-card-graph-width:    1px;
    }

    @keyframes sw-rc-pulse {
      0%, 100% { opacity: 0.15; }
      50%       { opacity: 1; }
    }

    ha-card {
      position: relative;
      height: var(--sw-room-card-height);
      overflow: hidden;
      padding: 0;
    }

    ha-card[data-actionable] { cursor: pointer; }

    .header {
      position: absolute;
      inset: 0 0 auto 0;
      padding: 18px 16px 0;
      box-sizing: border-box;
      z-index: 2;
    }

    .identity {
      display: flex;
      flex-direction: column;
    }

    .identity--center { align-items: center; text-align: center; }
    .identity--right  { align-items: flex-end; text-align: right; }

    ha-icon.room-icon {
      display: block;
      color: var(--sw-room-card-color);
      width: 20px;
      height: 20px;
      margin-bottom: 9px;
      --mdi-icon-size: 20px;
    }

    .name {
      font-family: var(--sw-room-card-font);
      font-size: 17px;
      font-weight: 400;
      color: var(--sw-room-card-text);
      letter-spacing: 0.02em;
      line-height: 1.2;
    }

    .floor {
      font-size: 9px;
      color: var(--sw-room-card-text-disabled);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-top: 3px;
    }

    .status {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 14px;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .row-label {
      font-size: 8px;
      color: var(--sw-room-card-text-disabled);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      white-space: nowrap;
      width: 48px;
      flex-shrink: 0;
    }

    .row-content {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
    }

    .dot {
      width: 7px;
      height: 7px;
      flex-shrink: 0;
      transition: background 0.3s;
    }

    .dot[data-pulse="true"] { animation: sw-rc-pulse 1.6s ease-in-out infinite; }

    .val {
      font-size: 9px;
      color: var(--sw-room-card-text-secondary);
      letter-spacing: 0.04em;
    }

    .bottom-strip {
      position: absolute;
      bottom: 26px;
      left: 16px;
      right: 16px;
      z-index: 3;
      pointer-events: none;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
    }

    .temp {
      font-family: var(--sw-room-card-font);
      font-size: 36px;
      font-weight: 300;
      color: var(--sw-room-card-text);
      line-height: 1;
      white-space: nowrap;
      opacity: 0.85;
    }

    .humidity {
      font-family: var(--sw-room-card-font);
      font-size: 16px;
      font-weight: 300;
      color: var(--sw-room-card-text);
      line-height: 1;
      white-space: nowrap;
      opacity: 0.55;
      text-align: right;
      padding-bottom: 4px;
    }

    .graph {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: var(--sw-room-card-graph-height);
      z-index: 1;
      overflow: hidden;
    }
  `;
}
