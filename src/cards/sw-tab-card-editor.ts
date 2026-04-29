import { LitElement, html, css } from 'lit';
import { state } from 'lit/decorators.js';
import type { HomeAssistant } from '../types/ha';
import type { TabCardConfig } from './sw-tab-card';

export class SwTabCardEditor extends LitElement {
  @state() private _config?: TabCardConfig;
  @state() private _pickingCardFor: string | null = null;
  
  private _hass?: HomeAssistant;
  private _lovelace?: any;

  setConfig(config: TabCardConfig) {
    this._config = config;
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    this.requestUpdate();
  }

  set lovelace(lovelace: any) {
    this._lovelace = lovelace;
    this.requestUpdate();
  }

  private _schema = [
    { name: 'title', selector: { text: {} } },
    {
      name: 'title_align',
      selector: {
        select: {
          options: ['left', 'center', 'right'],
          mode: 'dropdown',
        },
      },
    },
    {
      name: 'tab_style',
      selector: {
        select: {
          options: ['pills', 'underline', 'dropdown'],
          mode: 'dropdown',
        },
      },
    },
    {
      name: 'tab_align',
      selector: {
        select: {
          options: ['left', 'center', 'right'],
          mode: 'dropdown',
        },
      },
    },
  ];

  private _computeLabel = (schema: any) => {
    switch (schema.name) {
      case 'title':
        return 'Title (optional)';
      case 'title_align':
        return 'Title Alignment';
      case 'tab_style':
        return 'Tab Style';
      case 'tab_align':
        return 'Tab Alignment';
      default:
        return schema.name;
    }
  };

  private _getTabSchema() {
    const cardKeys = Object.keys(this._config?.cards || {});
    return [
      { name: 'label', selector: { text: {} } },
      { name: 'icon', selector: { icon: {} } },
      { 
        name: 'cards', 
        selector: { 
          select: { 
            multiple: true,
            mode: 'dropdown',
            options: cardKeys.map(k => ({ value: k, label: k })) 
          } 
        } 
      }
    ];
  }

  private _computeTabLabel = (schema: any) => {
    switch (schema.name) {
      case 'label': return 'Tab Label';
      case 'icon': return 'Icon';
      case 'cards': return 'Cards to show';
      default: return schema.name;
    }
  };

  private _valueChanged(ev: CustomEvent) {
    const config = ev.detail.value;
    this._dispatchEvent(config);
  }

  private _dispatchEvent(config: TabCardConfig) {
    const event = new Event('config-changed', { bubbles: true, composed: true });
    (event as any).detail = { config };
    this.dispatchEvent(event);
  }

  // --- Cards Management ---

  private _startPickCard() {
    if (!this._config) return;
    const keys = Object.keys(this._config.cards || {});
    let i = 1;
    while (keys.includes(`card_${i}`)) { i++; }
    this._pickingCardFor = `card_${i}`;
  }

  private _cardPicked(ev: CustomEvent) {
    ev.stopPropagation(); // prevent Lovelace from intercepting
    if (!this._config || !this._pickingCardFor) return;
    const cards = { ...(this._config.cards || {}) };
    cards[this._pickingCardFor] = ev.detail.config;
    const config = { ...this._config, cards };
    this._pickingCardFor = null;
    this._dispatchEvent(config);
  }

  private _cardConfigChanged(ev: CustomEvent, key: string) {
    ev.stopPropagation(); // prevent Lovelace from intercepting
    if (!this._config) return;
    const cards = { ...(this._config.cards || {}) };
    cards[key] = ev.detail.config;
    const config = { ...this._config, cards };
    this._dispatchEvent(config);
  }

  private _renameCard(oldKey: string, newKey: string) {
    if (!this._config || oldKey === newKey || !newKey) return;
    const cards = { ...(this._config.cards || {}) };
    if (cards[newKey]) return; // Key already exists
    
    cards[newKey] = cards[oldKey];
    delete cards[oldKey];

    // Update tabs referencing this card
    const tabs = (this._config.tabs || []).map(tab => {
      if (!tab.cards) return tab;
      return {
        ...tab,
        cards: tab.cards.map(c => c === oldKey ? newKey : c)
      };
    });

    const config = { ...this._config, cards, tabs };
    this._dispatchEvent(config);
  }

  private _removeCard(key: string) {
    if (!this._config) return;
    const cards = { ...(this._config.cards || {}) };
    delete cards[key];
    
    // Update tabs to remove references
    const tabs = (this._config.tabs || []).map(tab => {
      if (!tab.cards) return tab;
      return {
        ...tab,
        cards: tab.cards.filter(c => c !== key)
      };
    });

    const config = { ...this._config, cards, tabs };
    this._dispatchEvent(config);
  }

  // --- Tabs Management ---

  private _tabValueChanged(ev: CustomEvent, index: number) {
    ev.stopPropagation();
    if (!this._config) return;
    const tabs = [...(this._config.tabs || [])];
    tabs[index] = ev.detail.value;
    const config = { ...this._config, tabs };
    this._dispatchEvent(config);
  }

  private _addTab() {
    if (!this._config) return;
    const tabs = [...(this._config.tabs || []), { label: 'New Tab', cards: [] }];
    const config = { ...this._config, tabs };
    this._dispatchEvent(config);
  }

  private _removeTab(index: number) {
    if (!this._config) return;
    const tabs = [...(this._config.tabs || [])];
    tabs.splice(index, 1);
    const config = { ...this._config, tabs };
    this._dispatchEvent(config);
  }

  private _moveTab(index: number, dir: number) {
    if (!this._config) return;
    const tabs = [...(this._config.tabs || [])];
    if (index + dir < 0 || index + dir >= tabs.length) return;
    const temp = tabs[index];
    tabs[index] = tabs[index + dir];
    tabs[index + dir] = temp;
    const config = { ...this._config, tabs };
    this._dispatchEvent(config);
  }

  static styles = css`
    .section {
      margin-top: 24px;
    }
    .section h3 {
      margin-bottom: 8px;
    }
    .card-editor, .tab-editor {
      border: 1px solid var(--divider-color);
      border-radius: 4px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .card-header, .tab-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .card-header ha-textfield {
      flex: 1;
      margin-right: 8px;
    }
    .tab-header {
      font-weight: bold;
    }
    .tab-actions, .card-actions {
      display: flex;
      gap: 4px;
    }
    .icon-btn, .tab-actions button {
      color: var(--secondary-text-color);
      cursor: pointer;
      background: none;
      border: none;
      padding: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .icon-btn:hover, .tab-actions button:hover {
      color: var(--primary-color);
    }
    .add-btn {
      margin-top: 8px;
      color: var(--primary-color);
      cursor: pointer;
      background: none;
      border: none;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0;
    }
    .picker-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    hui-card-picker {
      display: block;
      margin-top: 12px;
    }
  `;

  render() {
    if (!this._hass || !this._config) return html``;

    const lovelace = this._lovelace || {
      config: { type: "lovelace", views: [] },
      editMode: true,
      mode: "generated",
      locale: (this._hass as any).locale || { language: "en" },
    };

    if (this._pickingCardFor !== null) {
      return html`
        <div class="picker-header">
          <h3>Pick Card for "${this._pickingCardFor}"</h3>
          <button class="icon-btn" @click=${() => this._pickingCardFor = null}>
            <ha-icon icon="mdi:close"></ha-icon>
          </button>
        </div>
        <hui-card-picker
          .hass=${this._hass}
          .lovelace=${lovelace}
          @config-changed=${this._cardPicked}
        ></hui-card-picker>
      `;
    }

    return html`
      <ha-form
        .hass=${this._hass}
        .data=${this._config}
        .schema=${this._schema}
        .computeLabel=${this._computeLabel}
        @value-changed=${this._valueChanged}
      ></ha-form>

      <div class="section">
        <h3>Cards Definition</h3>
        ${Object.entries(this._config.cards || {}).map(([key, cardConf]) => html`
          <div class="card-editor">
            <div class="card-header">
              <ha-textfield
                label="Card ID"
                .value=${key}
                @change=${(e: Event) => this._renameCard(key, (e.target as HTMLInputElement).value)}
              ></ha-textfield>
              <button class="icon-btn" title="Delete" @click=${() => this._removeCard(key)}>
                <ha-icon icon="mdi:delete"></ha-icon>
              </button>
            </div>
            <hui-card-element-editor
              .hass=${this._hass}
              .lovelace=${lovelace}
              .value=${cardConf}
              @config-changed=${(ev: CustomEvent) => this._cardConfigChanged(ev, key)}
            ></hui-card-element-editor>
          </div>
        `)}
        <button class="add-btn" @click=${this._startPickCard}>
          <ha-icon icon="mdi:plus"></ha-icon> Add Card
        </button>
      </div>

      <div class="section">
        <h3>Tabs</h3>
        ${(this._config.tabs || []).map((tab, index) => html`
          <div class="tab-editor">
            <div class="tab-header">
              <span>Tab ${index + 1}</span>
              <div class="tab-actions">
                <button title="Move Up" @click=${() => this._moveTab(index, -1)} ?disabled=${index === 0}>
                  <ha-icon icon="mdi:arrow-up"></ha-icon>
                </button>
                <button title="Move Down" @click=${() => this._moveTab(index, 1)} ?disabled=${index === (this._config?.tabs?.length || 0) - 1}>
                  <ha-icon icon="mdi:arrow-down"></ha-icon>
                </button>
                <button title="Delete" @click=${() => this._removeTab(index)}>
                  <ha-icon icon="mdi:delete"></ha-icon>
                </button>
              </div>
            </div>
            <ha-form
              .hass=${this._hass}
              .data=${tab}
              .schema=${this._getTabSchema()}
              .computeLabel=${this._computeTabLabel}
              @value-changed=${(ev: CustomEvent) => this._tabValueChanged(ev, index)}
            ></ha-form>
          </div>
        `)}
        <button class="add-btn" @click=${this._addTab}>
          <ha-icon icon="mdi:plus"></ha-icon> Add Tab
        </button>
      </div>
    `;
  }
}
