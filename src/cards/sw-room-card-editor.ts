import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import type { HomeAssistant } from '../types/ha';
import type { RoomCardConfig } from './sw-room-card';

export class SwRoomCardEditor extends LitElement {
  @state() private _config?: RoomCardConfig;
  private _hass?: HomeAssistant;

  setConfig(config: RoomCardConfig) {
    this._config = config;
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    this.requestUpdate();
  }

  private _schema = [
    { name: 'area', selector: { area: {} } },
    { name: 'name', selector: { text: {} } },
    { name: 'floor', selector: { text: {} } },
    { name: 'icon', selector: { icon: {} } },
    {
      name: 'align',
      selector: {
        select: {
          options: ['left', 'center', 'right'],
          mode: 'dropdown',
        },
      },
    },
    { name: 'temp_entity', selector: { entity: { domain: ['sensor', 'climate'] } } },
    { name: 'humidity_entity', selector: { entity: { domain: ['sensor', 'climate'] } } },
    { name: 'hours_to_show', default: 24, selector: { number: { min: 1, max: 168, mode: 'box' } } },
  ];

  private _valueChanged(ev: CustomEvent) {
    const config = ev.detail.value;
    const event = new Event('config-changed', { bubbles: true, composed: true });
    (event as any).detail = { config };
    this.dispatchEvent(event);
  }

  private _computeLabel = (schema: any) => {
    switch (schema.name) {
      case 'area':
        return 'Area';
      case 'name':
        return 'Name Override (optional)';
      case 'floor':
        return 'Floor Override (optional)';
      case 'icon':
        return 'Icon Override (optional)';
      case 'align':
        return 'Header Alignment';
      case 'temp_entity':
        return 'Temperature Entity (optional)';
      case 'humidity_entity':
        return 'Humidity Entity (optional)';
      case 'hours_to_show':
        return 'Graph Hours to Show';
      default:
        return schema.name;
    }
  };

  // --- Rows Editor ---

  private _getRowSchema(row: any) {
    const base: any[] = [
      {
        name: 'type',
        selector: {
          select: {
            options: [
              { value: 'lights', label: 'Lights' },
              { value: 'windows', label: 'Windows' },
              { value: 'custom', label: 'Custom' },
            ],
            mode: 'dropdown',
          },
        },
      },
      { name: 'label', selector: { text: {} } },
      { name: 'show', default: true, selector: { boolean: {} } },
    ];

    if (row.type === 'lights') {
      base.push({
        name: 'entities',
        selector: { entity: { domain: 'light', multiple: true } },
      });
    } else if (row.type === 'windows') {
      base.push({
        name: 'entities',
        selector: { entity: { domain: 'binary_sensor', multiple: true } },
      });
    } else if (row.type === 'custom') {
      base.push({
        name: 'content',
        selector: { object: {} },
      });
    }
    return base;
  }

  private _computeRowLabel = (schema: any) => {
    switch (schema.name) {
      case 'type':
        return 'Row Type';
      case 'label':
        return 'Label Override (optional)';
      case 'show':
        return 'Visible';
      case 'entities':
        return 'Entities Override (optional)';
      case 'content':
        return 'Custom Content (YAML)';
      default:
        return schema.name;
    }
  };

  private _rowValueChanged(ev: CustomEvent, index: number) {
    ev.stopPropagation(); // prevent main form from catching it
    if (!this._config) return;
    const rows = [...(this._config.rows || [])];
    rows[index] = ev.detail.value;
    const config = { ...this._config, rows };
    this._dispatchEvent(config);
  }

  private _addRow() {
    if (!this._config) return;
    const rows = [...(this._config.rows || []), { type: 'lights' as const }];
    const config = { ...this._config, rows };
    this._dispatchEvent(config);
  }

  private _removeRow(index: number) {
    if (!this._config) return;
    const rows = [...(this._config.rows || [])];
    rows.splice(index, 1);
    const config = { ...this._config, rows };
    this._dispatchEvent(config);
  }

  private _moveRow(index: number, dir: number) {
    if (!this._config) return;
    const rows = [...(this._config.rows || [])];
    if (index + dir < 0 || index + dir >= rows.length) return;
    const temp = rows[index];
    rows[index] = rows[index + dir];
    rows[index + dir] = temp;
    const config = { ...this._config, rows };
    this._dispatchEvent(config);
  }

  private _dispatchEvent(config: RoomCardConfig) {
    const event = new Event('config-changed', { bubbles: true, composed: true });
    (event as any).detail = { config };
    this.dispatchEvent(event);
  }

  static styles = css`
    .rows-section {
      margin-top: 24px;
    }
    .rows-section h3 {
      margin-bottom: 8px;
    }
    .row-editor {
      border: 1px solid var(--divider-color);
      border-radius: 4px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .row-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      font-weight: bold;
    }
    .row-actions {
      display: flex;
      gap: 4px;
    }
    .row-actions ha-icon-button,
    .row-actions button {
      color: var(--secondary-text-color);
      cursor: pointer;
      background: none;
      border: none;
    }
    .row-actions button:hover {
      color: var(--primary-color);
    }
    .add-row {
      margin-top: 8px;
    }
  `;

  render() {
    if (!this._hass || !this._config) return html``;
    return html`
      <ha-form
        .hass=${this._hass}
        .data=${this._config}
        .schema=${this._schema}
        .computeLabel=${this._computeLabel}
        @value-changed=${this._valueChanged}
      ></ha-form>

      <div class="rows-section">
        <h3>Rows</h3>
        ${(this._config.rows || []).map(
          (row, index) => html`
            <div class="row-editor">
              <div class="row-header">
                <span>Row ${index + 1} (${row.type})</span>
                <div class="row-actions">
                  <button
                    title="Move Up"
                    @click=${() => this._moveRow(index, -1)}
                    ?disabled=${index === 0}
                  >
                    <ha-icon icon="mdi:arrow-up"></ha-icon>
                  </button>
                  <button
                    title="Move Down"
                    @click=${() => this._moveRow(index, 1)}
                    ?disabled=${index === (this._config?.rows?.length || 0) - 1}
                  >
                    <ha-icon icon="mdi:arrow-down"></ha-icon>
                  </button>
                  <button title="Delete" @click=${() => this._removeRow(index)}>
                    <ha-icon icon="mdi:delete"></ha-icon>
                  </button>
                </div>
              </div>
              <ha-form
                .hass=${this._hass}
                .data=${row}
                .schema=${this._getRowSchema(row)}
                .computeLabel=${this._computeRowLabel}
                @value-changed=${(ev: CustomEvent) => this._rowValueChanged(ev, index)}
              ></ha-form>
            </div>
          `
        )}
        <button class="add-row" @click=${this._addRow}>
          <ha-icon icon="mdi:plus"></ha-icon> Add Row
        </button>
      </div>
    `;
  }
}
