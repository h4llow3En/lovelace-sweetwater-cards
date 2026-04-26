import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import type { HomeAssistant } from '../types/ha.js';

// ── Config types ──────────────────────────────────────────────────────────────

interface TabConfig {
  label?: string;
  icon?: string;
  cards: string[];
}
type TabStyle = 'pills' | 'underline' | 'dropdown';

export interface TabCardConfig {
  title?: string;
  title_align?: 'left' | 'right' | 'center';
  tab_align?: 'left' | 'center' | 'right';
  tabs: TabConfig[];
  cards: Record<string, unknown>;
  tab_style?: TabStyle;
  columns?: number | 'auto';
  min_column_width?: number;
  styles?: Record<string, string>;
}

type CardEl = Element & { hass?: HomeAssistant; setConfig(c: unknown): void };

// ── Card ─────────────────────────────────────────────────────────────────────

export class SwTabCard extends LitElement {
  @state() private _activeTab = 0;

  private _hass?: HomeAssistant;
  private _config?: TabCardConfig;
  private _cardEls = new Map<string, CardEl>();
  private _storageKey = '';
  private _appliedVars = new Set<string>();

  // ── HA card interface ───────────────────────────────────────────────────────

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    for (const el of this._cardEls.values()) {
      el.hass = hass;
    }
  }

  get hass(): HomeAssistant { return this._hass!; }

  setConfig(config: TabCardConfig): void {
    if (!config?.tabs?.length) throw new Error('sw-tab-card: at least one tab required');
    if (!config.cards || typeof config.cards !== 'object') {
      throw new Error('sw-tab-card: "cards" must be an object mapping names to card configs');
    }

    const prevKey = this._storageKey;
    this._config = config;
    this._storageKey = `sw-tab-card:${config.tabs.map((t, i) => t.label ?? t.icon ?? String(i)).join('|')}`;

    if (prevKey !== this._storageKey) this._cardEls.clear();

    // Apply --sw-tab-* CSS variable overrides
    this._appliedVars.forEach(p => this.style.removeProperty(p));
    this._appliedVars.clear();
    for (const [k, v] of Object.entries(config.styles ?? {})) {
      const prop = k.startsWith('--') ? k : `--sw-tab-${k}`;
      this.style.setProperty(prop, String(v));
      this._appliedVars.add(prop);
    }

    this._activeTab = this._restoreTab(config.tabs.length);
    this.requestUpdate();
  }

  getCardSize(): number { return 4; }

  // ── Tab state ────────────────────────────────────────────────────────────────

  private _restoreTab(tabCount: number): number {
    const saved = sessionStorage.getItem(this._storageKey);
    if (saved !== null) {
      const idx = parseInt(saved, 10);
      if (!isNaN(idx) && idx < tabCount) return idx;
    }
    return Math.min(this._activeTab, tabCount - 1);
  }

  private _switchTab(idx: number): void {
    this._activeTab = idx;
    sessionStorage.setItem(this._storageKey, String(idx));
  }

  // ── Card elements ─────────────────────────────────────────────────────────────
  // All elements are created once and kept alive.
  // Tab switches only toggle CSS visibility — no re-init, no state loss.

  private _getOrCreateCard(name: string): CardEl | null {
    if (this._cardEls.has(name)) return this._cardEls.get(name)!;

    const cardConfig = this._config?.cards[name];
    if (!cardConfig || typeof cardConfig !== 'object') return null;

    const cfg = cardConfig as Record<string, unknown>;
    const rawType = String(cfg.type ?? '');
    const tag = rawType.startsWith('custom:') ? rawType.slice(7) : rawType;
    if (!tag) return null;

    const el = document.createElement(tag) as unknown as CardEl;
    try {
      el.setConfig(cardConfig);
    } catch (err) {
      console.error(`sw-tab-card: failed to configure card "${name}"`, err);
      return null;
    }

    if (this._hass) el.hass = this._hass;
    this._cardEls.set(name, el);
    return el;
  }

  // ── Tab bar renderers ─────────────────────────────────────────────────────────

  private _dropdownLabel(tab: TabConfig, i: number): string {
    if (tab.label) return tab.label;
    if (tab.icon) {
      const name = tab.icon.includes(':') ? tab.icon.slice(tab.icon.indexOf(':') + 1) : tab.icon;
      return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    return String(i + 1);
  }

  private _barClass(...extra: string[]): string {
    const align = this._config!.title_align ?? 'left';
    return ['tab-bar', `tab-bar--${align}`, ...extra].filter(Boolean).join(' ');
  }

  private _tabsClass(style: string): string {
    const { tab_align, title_align = 'left' } = this._config!;
    // Explicit tab_align wins; otherwise mirror the title side for center layouts.
    const align = tab_align ?? (title_align === 'center' ? 'center' : 'left');
    return `tabs ${style} tabs--${align}`;
  }

  private _tabButton(tab: TabConfig, i: number) {
    const iconOnly = !tab.label;
    return html`
      <button
        role="tab"
        class="tab${i === this._activeTab ? ' active' : ''}${iconOnly ? ' icon-only' : ''}"
        aria-selected=${i === this._activeTab}
        aria-label=${tab.label ?? tab.icon ?? ''}
        @click=${() => this._switchTab(i)}
      >
        ${tab.icon ? html`<ha-icon icon=${tab.icon}></ha-icon>` : nothing}
        ${tab.label ? html`<span>${tab.label}</span>` : nothing}
      </button>`;
  }

  private _renderPills() {
    const { tabs, title } = this._config!;
    return html`
      <div class=${this._barClass()}>
        ${title ? html`<span class="tab-title">${title}</span>` : nothing}
        <div class=${this._tabsClass('pills')} role="tablist">
          ${tabs.map((tab, i) => this._tabButton(tab, i))}
        </div>
      </div>`;
  }

  private _renderUnderline() {
    const { tabs, title } = this._config!;
    return html`
      <div class=${this._barClass('tab-bar--underline')}>
        ${title ? html`<span class="tab-title">${title}</span>` : nothing}
        <div class=${this._tabsClass('underline')} role="tablist">
          ${tabs.map((tab, i) => this._tabButton(tab, i))}
        </div>
      </div>`;
  }

  private _renderDropdown() {
    const { tabs, title } = this._config!;
    return html`
      <div class=${this._barClass()}>
        ${title ? html`<span class="tab-title">${title}</span>` : nothing}
        <div class=${this._tabsClass('dropdown')}>
          <select
            aria-label="Tab selection"
            @change=${(e: Event) => this._switchTab(parseInt((e.target as HTMLSelectElement).value, 10))}
          >
            ${tabs.map((tab, i) => html`
              <option value=${i} ?selected=${i === this._activeTab}>
                ${this._dropdownLabel(tab, i)}
              </option>`)}
          </select>
        </div>
      </div>`;
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  render() {
    if (!this._config) return nothing;
    const { tabs, tab_style = 'pills', columns, min_column_width = 180 } = this._config;

    const activeCards = tabs[this._activeTab]?.cards ?? [];
    const activeSet = new Set(activeCards);

    // Stable slot order: first occurrence across all tabs determines DOM position.
    // Elements never move — only visibility and CSS order change per tab.
    const allNames = [...new Set(tabs.flatMap(t => t.cards))];

    const gridCols = typeof columns === 'number'
      ? `repeat(${columns}, 1fr)`
      : `repeat(auto-fill, minmax(${min_column_width}px, 1fr))`;

    const tabBar = tab_style === 'dropdown' ? this._renderDropdown()
      : tab_style === 'underline'           ? this._renderUnderline()
      :                                       this._renderPills();

    return html`
      ${tabBar}
      <div class="content" style="grid-template-columns:${gridCols}">
        ${allNames.map(name => {
          const el = this._getOrCreateCard(name);
          if (!el) return nothing;
          const order = activeCards.indexOf(name);
          const hidden = !activeSet.has(name);
          return html`
            <div class="slot" ?hidden=${hidden} style="order:${hidden ? 0 : order}">
              ${el}
            </div>`;
        })}
      </div>`;
  }

  // ── Styles ───────────────────────────────────────────────────────────────────

  static styles = css`
    :host {
      display: block;

      /* ── Overridable via styles: in config ─────────────────────────────── */
      --sw-tab-accent:         var(--primary-color);
      --sw-tab-accent-text:    var(--text-primary-color, #fff);
      --sw-tab-color:          var(--secondary-text-color);
      --sw-tab-border:         var(--divider-color, rgba(255,255,255,0.1));
      --sw-tab-font:           var(--primary-font-family, sans-serif);
      --sw-tab-font-size:      12px;
      --sw-tab-title-size:     13px;
      --sw-tab-letter-spacing: 0.04em;
      --sw-tab-gap:            6px;
      --sw-tab-padding:        5px 14px;
      --sw-tab-radius:         20px;
    }

    /* ── Tab bar row (title + tablist) ───────────────────────────────────── */

    .tab-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px 0;
    }

    /* right: mirror of left — tabs first visually, title last */
    .tab-bar--right {
      justify-content: flex-end;
    }
    .tab-bar--right .tab-title { order: 2; }
    .tab-bar--right .tabs      { order: 1; }

    /* center: title above tabs in a column */
    .tab-bar--center {
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }

    /* row layouts: tabs fill the remaining space so tab_align has room to work */
    .tab-bar--left .tabs,
    .tab-bar--right .tabs {
      flex: 1;
      min-width: 0;
    }

    /* tab_align — controls justification of pills/buttons within the tabs container */
    .tabs--left   { justify-content: flex-start; }
    .tabs--center { justify-content: center; }
    .tabs--right  { justify-content: flex-end; }

    .tab-title {
      font-family: var(--sw-tab-font);
      font-size: var(--sw-tab-title-size);
      color: var(--sw-tab-color);
      font-weight: 600;
      letter-spacing: var(--sw-tab-letter-spacing);
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* ── Shared tab list ─────────────────────────────────────────────────── */

    .tabs {
      display: flex;
      gap: var(--sw-tab-gap);
      overflow-x: auto;
      scrollbar-width: none;
    }
    .tabs::-webkit-scrollbar { display: none; }

    .tab {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: var(--sw-tab-padding);
      border: none;
      background: transparent;
      color: var(--sw-tab-color);
      font-size: var(--sw-tab-font-size);
      font-family: var(--sw-tab-font);
      letter-spacing: var(--sw-tab-letter-spacing);
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }

    .tab.icon-only {
      padding: 5px 8px;
    }

    .tab ha-icon {
      --mdi-icon-size: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      color: inherit;
    }

    /* ── Pills ────────────────────────────────────────────────────────────── */

    .pills .tab {
      border: 1px solid var(--sw-tab-border);
      border-radius: var(--sw-tab-radius);
    }

    .pills .tab.active {
      background: var(--sw-tab-accent);
      color: var(--sw-tab-accent-text);
      border-color: transparent;
    }

    /* ── Underline ────────────────────────────────────────────────────────── */

    .tab-bar--underline {
      padding: 12px 6px 0;
      border-bottom: 1px solid var(--sw-tab-border);
    }

    .underline {
      gap: 0;
    }

    .underline .tab {
      border-bottom: 2px solid transparent;
      border-radius: 0;
      padding: 8px 12px;
      margin-bottom: -1px;
    }

    .underline .tab.icon-only {
      padding: 8px;
    }

    .underline .tab.active {
      border-bottom-color: var(--sw-tab-accent);
      color: var(--sw-tab-accent);
    }

    /* ── Dropdown ─────────────────────────────────────────────────────────── */

    .dropdown select {
      width: 100%;
      padding: 6px 10px;
      border: 1px solid var(--sw-tab-border);
      border-radius: 8px;
      background: transparent;
      color: var(--sw-tab-color);
      font-size: var(--sw-tab-font-size);
      font-family: var(--sw-tab-font);
      cursor: pointer;
      appearance: auto;
    }

    /* ── Content grid ─────────────────────────────────────────────────────── */

    .content {
      display: grid;
      gap: 12px;
      padding: 12px 14px 14px;
    }

    .slot[hidden] { display: none !important; }
  `;
}
