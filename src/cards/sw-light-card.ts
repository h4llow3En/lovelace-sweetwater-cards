import { LitElement, html, css, svg, nothing, type TemplateResult } from 'lit';
import { state } from 'lit/decorators.js';
import type { HomeAssistant, EntityRegistryEntry } from '../types/ha';

// ── Config types ──────────────────────────────────────────────────────────────

export interface LightChipConfig {
  entity: string;
  name?: string;
  icon?: string;
}

export interface SceneConfig {
  entity: string;
  name?: string;
  icon?: string;
}

export interface LightCardConfig {
  name?: string;
  area?: string;
  entities?: Array<string | LightChipConfig>;
  main_entity?: string;
  scenes?: Array<string | SceneConfig>;
  transition?: number; // seconds for scene activation, default 1
  show_color_temp?: boolean;
  styles?: Record<string, string>;
}

type Channel = 'brightness' | 'color_temp';

interface OptimisticEntry {
  off?: boolean;
  pct?: number;
  kelvin?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const HOLD_DURATION_MS = 500;
const CHIP_MOVE_SLOP_PX = 8;
const SINGLE_EXIT_TIMEOUT_MS = 30_000;
const OPTIMISTIC_TIMEOUT_MS = 8_000;
const PCT_CONVERGENCE_TOLERANCE = 2;
const KELVIN_CONVERGENCE_TOLERANCE = 60;
const KELVIN_STEP = 50;
const CT_FALLBACK_RANGE: [number, number] = [2000, 6500];

// ── Dial geometry ────────────────────────────────────────────────────────────
// SVG angle convention: 0° = 3 o'clock, clockwise-positive (y axis points down).
// The arc sweeps 270° from bottom-left (135°) over the top to bottom-right
// (405°), leaving a 90° gap centered at the bottom for the mode button.

const DIAL_CENTER = 100;
const DIAL_RADIUS = 80;
const ARC_START_DEG = 135;
const ARC_SWEEP_DEG = 270;
const CHIP_RING_RADIUS = 13;
const CHIP_RING_CIRCUMFERENCE = 2 * Math.PI * CHIP_RING_RADIUS;

function arcPoint(deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [
    DIAL_CENTER + DIAL_RADIUS * Math.cos(rad),
    DIAL_CENTER + DIAL_RADIUS * Math.sin(rad),
  ];
}

function arcPath(fromDeg: number, toDeg: number): string {
  const [x1, y1] = arcPoint(fromDeg);
  const [x2, y2] = arcPoint(toDeg);
  const largeArc = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${DIAL_RADIUS} ${DIAL_RADIUS} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ── Card ─────────────────────────────────────────────────────────────────────

export class SwLightCard extends LitElement {
  // Preview value while dragging: percent (brightness) or Kelvin (color temp)
  @state() private _dragValue: number | null = null;
  // Single-light mode target; null = master mode
  @state() private _singleTarget: string | null = null;
  @state() private _channel: Channel = 'brightness';
  // Committed values waiting for the entities to catch up
  @state() private _optimistic: Record<string, OptimisticEntry> | null = null;

  private _hass?: HomeAssistant;
  private _config?: LightCardConfig;
  private _appliedVars = new Set<string>();
  private _chipConfigs: LightChipConfig[] = [];
  private _resolvedChips: LightChipConfig[] = [];
  private _sceneConfigs: SceneConfig[] = [];

  private _dragging = false;
  private _dragPointerId: number | null = null;
  private _dragSnapshot: Map<string, number> | null = null;
  private _dragStartMaster = 0;
  private _dragCtRange: [number, number] = CT_FALLBACK_RANGE;

  private _optimisticTimer?: number;
  private _singleExitTimer?: number;
  private _chipHoldTimer?: number;
  private _chipHoldFired = false;
  private _chipPointerEntity: string | null = null;
  private _chipStartX = 0;
  private _chipStartY = 0;

  // ── HA card interface ───────────────────────────────────────────────────────

  set hass(hass: HomeAssistant) {
    const old = this._hass;
    this._hass = hass;

    const needsDiscovery = !old
      || old.areas !== hass.areas
      || old.entities !== hass.entities
      || old.devices !== hass.devices;

    if (needsDiscovery) this._resolveChips();

    this._syncOptimistic(hass);

    let dirty = needsDiscovery || !old;
    if (!dirty && old) {
      for (const chip of this._resolvedChips) {
        if (old.states[chip.entity] !== hass.states[chip.entity]) { dirty = true; break; }
      }
    }
    if (dirty) this.requestUpdate();
  }

  get hass(): HomeAssistant { return this._hass!; }

  setConfig(config: LightCardConfig): void {
    if (!config) throw new Error('sw-light-card: missing config');
    this._config = config;
    this._chipConfigs = (config.entities ?? [])
      .map(e => (typeof e === 'string' ? { entity: e } : e))
      .filter(c => !!c?.entity && c.entity.startsWith('light.'));
    this._sceneConfigs = (config.scenes ?? [])
      .map(s => (typeof s === 'string' ? { entity: s } : s))
      .filter(s => !!s?.entity && s.entity.startsWith('scene.'));

    this._singleTarget = null;
    this._channel = 'brightness';
    this._dragValue = null;
    this._dragging = false;
    this._optimistic = null;

    this._appliedVars.forEach(p => this.style.removeProperty(p));
    this._appliedVars.clear();
    for (const [k, v] of Object.entries(config.styles ?? {})) {
      const prop = k.startsWith('--') ? k : `--sw-light-card-${k}`;
      this.style.setProperty(prop, String(v));
      this._appliedVars.add(prop);
    }

    if (this._hass) this._resolveChips();
    this.requestUpdate();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._clearTimer('_optimisticTimer');
    this._clearTimer('_singleExitTimer');
    this._clearTimer('_chipHoldTimer');
  }

  getCardSize(): number { return 4; }

  static async getConfigElement() {
    return document.createElement('sw-light-card-editor');
  }

  static getStubConfig(): LightCardConfig {
    return { area: '' };
  }

  private _clearTimer(key: '_optimisticTimer' | '_singleExitTimer' | '_chipHoldTimer'): void {
    const id = this[key];
    if (id != null) { clearTimeout(id); this[key] = undefined; }
  }

  // ── Discovery ───────────────────────────────────────────────────────────────

  private _resolveChips(): void {
    if (this._chipConfigs.length) { this._resolvedChips = this._chipConfigs; return; }

    const areaId = this._config?.area;
    if (!areaId || areaId === 'none' || !this._hass?.entities) {
      this._resolvedChips = [];
      return;
    }
    const devices = this._hass.devices ?? {};
    this._resolvedChips = Object.values(this._hass.entities)
      .filter((e: EntityRegistryEntry) =>
        e.area_id === areaId || (!e.area_id && e.device_id && devices[e.device_id]?.area_id === areaId),
      )
      .filter(e => e.entity_id.startsWith('light.'))
      .map(e => ({ entity: e.entity_id }));
  }

  private _mainEntity(): string | null {
    return this._config?.main_entity ?? this._resolvedChips[0]?.entity ?? null;
  }

  // ── Entity state helpers ─────────────────────────────────────────────────────
  // Rendering priority everywhere: drag preview ?? optimistic ?? entity state.

  private _stateOf(id: string) {
    return this._hass?.states[id] ?? null;
  }

  private _isAvailable(id: string): boolean {
    const s = this._stateOf(id);
    return !!s && s.state !== 'unavailable' && s.state !== 'unknown';
  }

  private _isOn(id: string): boolean {
    const opt = this._optimistic?.[id];
    if (opt) return !opt.off;
    return this._stateOf(id)?.state === 'on';
  }

  private _supportsBrightness(id: string): boolean {
    const modes = this._stateOf(id)?.attributes.supported_color_modes as string[] | undefined;
    if (!modes?.length) return true; // assume dimmable when capabilities are unknown
    return modes.some(m => m !== 'onoff');
  }

  private _supportsColorTemp(id: string): boolean {
    const modes = this._stateOf(id)?.attributes.supported_color_modes as string[] | undefined;
    return !!modes?.includes('color_temp');
  }

  private _effectivePct(id: string): number | null {
    const opt = this._optimistic?.[id];
    if (opt) {
      if (opt.off) return 0;
      if (opt.pct != null) return opt.pct;
    }
    const s = this._stateOf(id);
    if (!s || s.state === 'unavailable' || s.state === 'unknown') return null;
    if (s.state !== 'on') return 0;
    const brightness = s.attributes.brightness as number | undefined;
    if (brightness == null) return 100; // on, but reports no brightness (e.g. on/off-only)
    return clamp(Math.round((brightness / 255) * 100), 1, 100);
  }

  private _effectiveKelvin(id: string): number | null {
    const opt = this._optimistic?.[id];
    if (opt?.kelvin != null && !opt.off) return opt.kelvin;
    const kelvin = this._stateOf(id)?.attributes.color_temp_kelvin as number | undefined;
    return kelvin ?? null;
  }

  private _onLights(): string[] {
    return this._resolvedChips
      .map(c => c.entity)
      .filter(id => this._isAvailable(id) && this._isOn(id));
  }

  private _onDimmableLights(): string[] {
    return this._onLights().filter(id => this._supportsBrightness(id));
  }

  private _onCtLights(): string[] {
    return this._onLights().filter(id => this._supportsColorTemp(id));
  }

  private _masterPct(): number {
    const pcts = this._onDimmableLights()
      .map(id => this._effectivePct(id))
      .filter((p): p is number => p != null);
    return pcts.length ? Math.max(...pcts) : 0;
  }

  private _ctRange(targets: string[]): [number, number] {
    let min = -Infinity;
    let max = Infinity;
    for (const id of targets) {
      const attrs = this._stateOf(id)?.attributes;
      const mn = attrs?.min_color_temp_kelvin as number | undefined;
      const mx = attrs?.max_color_temp_kelvin as number | undefined;
      if (mn != null) min = Math.max(min, mn);
      if (mx != null) max = Math.min(max, mx);
    }
    if (!isFinite(min) || !isFinite(max) || min >= max) return CT_FALLBACK_RANGE;
    return [min, max];
  }

  private _ctTargets(): string[] {
    if (this._singleTarget) return this._supportsColorTemp(this._singleTarget) ? [this._singleTarget] : [];
    return this._onCtLights();
  }

  // ── Optimistic layer ─────────────────────────────────────────────────────────

  private _syncOptimistic(hass: HomeAssistant): void {
    if (!this._optimistic) return;
    let changed = false;
    const next: Record<string, OptimisticEntry> = {};

    for (const [id, entry] of Object.entries(this._optimistic)) {
      const s = hass.states[id];
      let converged = false;
      if (s) {
        if (entry.off) {
          converged = s.state === 'off';
        } else if (s.state === 'on') {
          converged = true;
          if (entry.pct != null) {
            const brightness = s.attributes.brightness as number | undefined;
            const pct = brightness == null ? null : Math.round((brightness / 255) * 100);
            converged = pct != null && Math.abs(pct - entry.pct) <= PCT_CONVERGENCE_TOLERANCE;
          }
          if (converged && entry.kelvin != null) {
            const kelvin = s.attributes.color_temp_kelvin as number | undefined;
            converged = kelvin != null && Math.abs(kelvin - entry.kelvin) <= KELVIN_CONVERGENCE_TOLERANCE;
          }
        }
      }
      if (converged) changed = true;
      else next[id] = entry;
    }

    if (!changed) return;
    this._optimistic = Object.keys(next).length ? next : null;
    if (!this._optimistic) this._clearTimer('_optimisticTimer');
  }

  private _pushOptimistic(entries: Record<string, OptimisticEntry>): void {
    this._optimistic = { ...(this._optimistic ?? {}), ...entries };
    this._clearTimer('_optimisticTimer');
    // Safety valve: never let a stale preview wedge the card (light groups
    // converge slowly, some lights never report the exact value back).
    this._optimisticTimer = window.setTimeout(() => {
      this._optimisticTimer = undefined;
      this._optimistic = null;
    }, OPTIMISTIC_TIMEOUT_MS);
  }

  // ── Single-light mode ────────────────────────────────────────────────────────

  private _enterSingle(id: string): void {
    this._singleTarget = id;
    if (this._channel === 'color_temp' && !this._supportsColorTemp(id)) {
      this._channel = 'brightness';
    }
    this._armSingleExitTimer();
  }

  private _exitSingle(): void {
    this._singleTarget = null;
    this._clearTimer('_singleExitTimer');
  }

  private _armSingleExitTimer(): void {
    this._clearTimer('_singleExitTimer');
    this._singleExitTimer = window.setTimeout(() => {
      this._singleExitTimer = undefined;
      this._singleTarget = null;
    }, SINGLE_EXIT_TIMEOUT_MS);
  }

  private _touchSingleExitTimer(): void {
    if (this._singleTarget) this._armSingleExitTimer();
  }

  // ── Dial interaction ─────────────────────────────────────────────────────────

  private _pointerToFraction(e: PointerEvent): number | null {
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    const rel = (angle - ARC_START_DEG + 360) % 360;
    if (rel <= ARC_SWEEP_DEG) return rel / ARC_SWEEP_DEG;
    // Pointer is in the bottom gap: snap to the nearest arc end
    return rel < ARC_SWEEP_DEG + (360 - ARC_SWEEP_DEG) / 2 ? 1 : 0;
  }

  private _fractionToValue(f: number): number {
    if (this._channel === 'brightness') return Math.round(f * 100);
    const [mn, mx] = this._dragCtRange;
    return clamp(Math.round((mn + f * (mx - mn)) / KELVIN_STEP) * KELVIN_STEP, mn, mx);
  }

  private _onDialPointerDown(e: PointerEvent): void {
    if (this._dragging) return;
    const f = this._pointerToFraction(e);
    if (f == null) return;
    e.stopPropagation(); // keep bubble-card popup gestures out of the drag
    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    this._dragging = true;
    this._dragPointerId = e.pointerId;
    this._touchSingleExitTimer();

    if (!this._singleTarget && this._channel === 'brightness') {

      const snapshot = new Map<string, number>();
      for (const id of this._onDimmableLights()) {
        const pct = this._effectivePct(id);
        if (pct != null && pct > 0) snapshot.set(id, pct);
      }
      this._dragSnapshot = snapshot;
      this._dragStartMaster = snapshot.size ? Math.max(...snapshot.values()) : 0;
    } else {
      this._dragSnapshot = null;
    }
    if (this._channel === 'color_temp') {
      const targets = this._ctTargets();
      this._dragCtRange = this._ctRange(targets.length ? targets : this._resolvedChips.map(c => c.entity));
    }

    this._dragValue = this._fractionToValue(f);
  }

  private _onDialPointerMove(e: PointerEvent): void {
    if (!this._dragging || e.pointerId !== this._dragPointerId) return;
    const f = this._pointerToFraction(e);
    if (f == null) return;
    const value = this._fractionToValue(f);
    if (value !== this._dragValue) this._dragValue = value;
  }

  private _onDialPointerUp(e: PointerEvent): void {
    if (!this._dragging || e.pointerId !== this._dragPointerId) return;
    this._releaseCapture(e);
    const value = this._dragValue;
    const snapshot = this._dragSnapshot;
    const startMaster = this._dragStartMaster;
    this._resetDrag();
    this._touchSingleExitTimer();
    if (value != null) this._commit(value, snapshot, startMaster);
  }

  private _onDialPointerCancel(e: PointerEvent): void {
    if (!this._dragging || e.pointerId !== this._dragPointerId) return;
    this._releaseCapture(e);
    // pointercancel usually means the OS/browser stole the gesture — discard.
    this._resetDrag();
  }

  private _releaseCapture(e: PointerEvent): void {
    const el = e.currentTarget as Element;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  private _resetDrag(): void {
    this._dragging = false;
    this._dragPointerId = null;
    this._dragSnapshot = null;
    this._dragValue = null;
  }

  // ── Commit (release-only: services fire here, never during the drag) ────────

  private _commit(value: number, snapshot: Map<string, number> | null, startMaster: number): void {
    const hass = this._hass;
    if (!hass) return;
    const optimistic: Record<string, OptimisticEntry> = {};
    const calls: Array<Record<string, unknown> & { __service: string }> = [];

    if (this._channel === 'color_temp') {
      for (const id of this._ctTargets()) {
        const [mn, mx] = this._ctRange([id]);
        const kelvin = clamp(value, mn, mx);
        calls.push({ __service: 'turn_on', entity_id: id, color_temp_kelvin: kelvin });
        optimistic[id] = { off: false, kelvin };
      }
    } else if (this._singleTarget) {
      const id = this._singleTarget;
      if (value <= 0) {
        calls.push({ __service: 'turn_off', entity_id: id });
        optimistic[id] = { off: true };
      } else {
        calls.push({ __service: 'turn_on', entity_id: id, brightness_pct: value });
        optimistic[id] = { off: false, pct: value };
      }
    } else if (value <= 0) {
      for (const id of this._onLights()) {
        calls.push({ __service: 'turn_off', entity_id: id });
        optimistic[id] = { off: true };
      }
    } else if (!snapshot?.size) {
      const main = this._mainEntity();
      if (main && this._isAvailable(main)) {
        calls.push({ __service: 'turn_on', entity_id: main, brightness_pct: value });
        optimistic[main] = { off: false, pct: value };
      }
    } else {
      for (const [id, snapPct] of snapshot) {
        const pct = clamp(Math.round((snapPct * value) / startMaster), 1, 100);
        calls.push({ __service: 'turn_on', entity_id: id, brightness_pct: pct });
        optimistic[id] = { off: false, pct };
      }
    }

    if (!calls.length) return;
    this._pushOptimistic(optimistic);
    for (const { __service, ...data } of calls) {
      hass.callService('light', __service, data);
    }
  }

  // ── Center + mode button + chips actions ─────────────────────────────────────

  private _onCenterTap(): void {
    if (this._singleTarget) {
      this._exitSingle();
      return;
    }
    const hass = this._hass;
    if (!hass) return;

    const on = this._onLights();
    if (on.length) {
      const optimistic: Record<string, OptimisticEntry> = {};
      for (const id of on) {
        hass.callService('light', 'turn_off', { entity_id: id });
        optimistic[id] = { off: true };
      }
      this._pushOptimistic(optimistic);
    } else {
      // All off → only the main light comes back, at its device-side last level
      const main = this._mainEntity();
      if (!main || !this._isAvailable(main)) return;
      hass.callService('light', 'turn_on', { entity_id: main });
      this._pushOptimistic({ [main]: { off: false } });
    }
  }

  private _showModeButton(): boolean {
    if (this._config?.show_color_temp === false) return false;
    if (this._singleTarget) return this._supportsColorTemp(this._singleTarget);
    return this._resolvedChips.some(c => this._supportsColorTemp(c.entity));
  }

  private _toggleChannel(): void {
    this._touchSingleExitTimer();
    this._channel = this._channel === 'brightness' ? 'color_temp' : 'brightness';
  }

  private _activateScene(entityId: string): void {
    this._touchSingleExitTimer();
    const data: Record<string, unknown> = { entity_id: entityId };
    const transition = this._config?.transition ?? 1;
    if (transition > 0) data.transition = transition;
    this._hass?.callService('scene', 'turn_on', data);
  }

  private _sceneName(scene: SceneConfig): string {
    return scene.name
      ?? (this._stateOf(scene.entity)?.attributes.friendly_name as string | undefined)
      ?? scene.entity.split('.')[1];
  }

  private _sceneIcon(scene: SceneConfig): string {
    return scene.icon
      ?? (this._stateOf(scene.entity)?.attributes.icon as string | undefined)
      ?? 'mdi:palette';
  }

  private _toggleLight(id: string): void {
    const hass = this._hass;
    if (!hass) return;
    this._touchSingleExitTimer();
    if (this._isOn(id)) {
      hass.callService('light', 'turn_off', { entity_id: id });
      this._pushOptimistic({ [id]: { off: true } });
    } else {
      // No brightness on purpose: the light restores its last level itself
      hass.callService('light', 'turn_on', { entity_id: id });
      this._pushOptimistic({ [id]: { off: false } });
    }
  }

  private _onChipPointerDown(e: PointerEvent, id: string): void {
    if (!this._isAvailable(id)) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    this._chipPointerEntity = id;
    this._chipHoldFired = false;
    this._chipStartX = e.clientX;
    this._chipStartY = e.clientY;
    this._clearTimer('_chipHoldTimer');
    this._chipHoldTimer = window.setTimeout(() => {
      this._chipHoldTimer = undefined;
      this._chipHoldFired = true;
      this._enterSingle(id);
    }, HOLD_DURATION_MS);
  }

  private _onChipPointerMove(e: PointerEvent): void {
    if (this._chipHoldTimer == null || this._chipPointerEntity == null) return;
    const moved = Math.hypot(e.clientX - this._chipStartX, e.clientY - this._chipStartY);
    if (moved > CHIP_MOVE_SLOP_PX) {
      // Finger is scrolling the popup, not pressing the chip: hand control back
      this._clearTimer('_chipHoldTimer');
      this._chipPointerEntity = null;
      this._releaseCapture(e);
    }
  }

  private _onChipPointerUp(e: PointerEvent, id: string): void {
    this._clearTimer('_chipHoldTimer');
    const fired = this._chipHoldFired;
    this._chipHoldFired = false;
    if (this._chipPointerEntity !== id) return;
    this._chipPointerEntity = null;
    this._releaseCapture(e);
    if (!fired) this._toggleLight(id);
  }

  private _onChipPointerCancel(e: PointerEvent): void {
    this._clearTimer('_chipHoldTimer');
    this._chipHoldFired = false;
    this._chipPointerEntity = null;
    this._releaseCapture(e);
  }

  // ── Display values ───────────────────────────────────────────────────────────

  private _chipDisplayPct(id: string): number {
    if (this._dragging && this._dragValue != null && this._channel === 'brightness') {
      if (this._singleTarget === id) return this._dragValue;
      if (!this._singleTarget) {
        if (this._dragSnapshot?.has(id)) {
          if (this._dragValue <= 0) return 0;
          return clamp(
            Math.round((this._dragSnapshot.get(id)! * this._dragValue) / this._dragStartMaster),
            1, 100,
          );
        }
        if (!this._dragSnapshot?.size && id === this._mainEntity()) return this._dragValue;
      }
    }
    return this._effectivePct(id) ?? 0;
  }

  private _dialDisplay(): { fraction: number; label: string } {
    if (this._channel === 'brightness') {
      const value = this._dragValue
        ?? (this._singleTarget ? (this._effectivePct(this._singleTarget) ?? 0) : this._masterPct());
      return { fraction: clamp(value, 0, 100) / 100, label: `${Math.round(value)} %` };
    }

    const targets = this._ctTargets();
    const [mn, mx] = this._dragging
      ? this._dragCtRange
      : this._ctRange(targets.length ? targets : this._resolvedChips.map(c => c.entity));

    let value = this._dragValue;
    if (value == null) {
      const kelvins = targets
        .map(id => this._effectiveKelvin(id))
        .filter((k): k is number => k != null);
      value = kelvins.length
        ? Math.round(kelvins.reduce((a, b) => a + b, 0) / kelvins.length)
        : null;
    }
    if (value == null) return { fraction: 0, label: '–' };
    return { fraction: clamp((value - mn) / (mx - mn), 0, 1), label: `${value} K` };
  }

  private _chipName(chip: LightChipConfig): string {
    return chip.name
      ?? (this._stateOf(chip.entity)?.attributes.friendly_name as string | undefined)
      ?? chip.entity.split('.')[1];
  }

  private _chipIcon(chip: LightChipConfig): string {
    return chip.icon
      ?? (this._stateOf(chip.entity)?.attributes.icon as string | undefined)
      ?? 'mdi:lightbulb';
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  // Safari fallback: touch-action:none should stop scrolling, but make sure
  // an active dial drag never pans the popup. Tracked per element so the
  // listener survives the dial appearing after an initial empty render.
  private _touchmoveEl?: Element;

  protected updated(): void {
    const dial = this.renderRoot.querySelector('.dial') ?? undefined;
    if (dial === this._touchmoveEl) return;
    this._touchmoveEl = dial;
    dial?.addEventListener(
      'touchmove',
      (e: Event) => { if (this._dragging) e.preventDefault(); },
      { passive: false },
    );
  }

  render() {
    if (!this._config || !this._hass) return nothing;

    if (!this._resolvedChips.length) {
      return html`<ha-card><div class="empty">No lights configured — set <code>area</code> or <code>entities</code>.</div></ha-card>`;
    }

    const { fraction, label } = this._dialDisplay();
    const isCt = this._channel === 'color_temp';
    const onCount = this._onLights().length;
    const single = this._singleTarget;
    const singleChip = single ? this._resolvedChips.find(c => c.entity === single) : undefined;

    const thumbAngle = ARC_START_DEG + ARC_SWEEP_DEG * fraction;
    const [thumbX, thumbY] = arcPoint(thumbAngle);

    return html`
      <ha-card>
        ${this._config.name ? html`<div class="title">${this._config.name}</div>` : nothing}
        <div class="dial-wrap">
          <div
            class="dial"
            @pointerdown=${this._onDialPointerDown}
            @pointermove=${this._onDialPointerMove}
            @pointerup=${this._onDialPointerUp}
            @pointercancel=${this._onDialPointerCancel}
          >
            <svg viewBox="0 0 200 200">
              <defs>
                <linearGradient id="sw-lc-ct-grad" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stop-color="var(--sw-light-card-ct-warm)"></stop>
                  <stop offset="100%" stop-color="var(--sw-light-card-ct-cold)"></stop>
                </linearGradient>
              </defs>
              <path
                class="track ${isCt ? 'track--ct' : ''}"
                d=${arcPath(ARC_START_DEG, ARC_START_DEG + ARC_SWEEP_DEG)}
              ></path>
              ${!isCt && fraction > 0 ? svg`
                <path class="fill" d=${arcPath(ARC_START_DEG, thumbAngle)}></path>
              ` : nothing}
              <circle class="thumb" cx=${thumbX.toFixed(2)} cy=${thumbY.toFixed(2)} r="7"></circle>
            </svg>
            <div
              class="center"
              @pointerdown=${(e: Event) => e.stopPropagation()}
              @click=${this._onCenterTap}
            >
              ${single ? html`
                <div class="center-sub center-sub--name">
                  <ha-icon icon="mdi:arrow-left"></ha-icon>
                  <span>${singleChip ? this._chipName(singleChip) : single}</span>
                </div>
                <div class="center-value">${label}</div>
              ` : html`
                <div class="center-value">${label}</div>
                <div class="center-sub ${onCount === 0 ? 'center-sub--off' : ''}">
                  <ha-icon icon="mdi:lightbulb-group${onCount === 0 ? '-off' : ''}"></ha-icon>
                  <span>${onCount}</span>
                </div>
              `}
            </div>
            ${this._showModeButton() ? html`
              <button
                class="mode-btn"
                title=${isCt ? 'Brightness' : 'Color temperature'}
                @pointerdown=${(e: Event) => e.stopPropagation()}
                @click=${this._toggleChannel}
              >
                <ha-icon icon=${isCt ? 'mdi:brightness-6' : 'mdi:thermometer'}></ha-icon>
              </button>
            ` : nothing}
          </div>
        </div>
        <div class="chips">
          ${this._resolvedChips.map(chip => this._renderChip(chip))}
        </div>
        ${this._sceneConfigs.length ? html`
          <div class="scenes">
            ${this._sceneConfigs.map(scene => html`
              <button class="scene-pill" @click=${() => this._activateScene(scene.entity)}>
                <ha-icon icon=${this._sceneIcon(scene)}></ha-icon>
                <span>${this._sceneName(scene)}</span>
              </button>`)}
          </div>
        ` : nothing}
      </ha-card>`;
  }

  private _renderChip(chip: LightChipConfig): TemplateResult {
    const id = chip.entity;
    const available = this._isAvailable(id);
    const on = available && this._isOn(id);
    const dimmable = this._supportsBrightness(id);
    const pct = on ? (dimmable ? this._chipDisplayPct(id) : 100) : 0;
    const dashOffset = CHIP_RING_CIRCUMFERENCE * (1 - clamp(pct, 0, 100) / 100);

    const classes = [
      'chip',
      on ? 'chip--on' : '',
      this._singleTarget === id ? 'chip--single' : '',
      !available ? 'chip--unavailable' : '',
    ].filter(Boolean).join(' ');

    return html`
      <button
        class=${classes}
        @pointerdown=${(e: PointerEvent) => this._onChipPointerDown(e, id)}
        @pointermove=${this._onChipPointerMove}
        @pointerup=${(e: PointerEvent) => this._onChipPointerUp(e, id)}
        @pointercancel=${this._onChipPointerCancel}
      >
        <span class="chip-ring">
          <svg viewBox="0 0 30 30">
            <circle class="ring-track" cx="15" cy="15" r=${CHIP_RING_RADIUS}></circle>
            ${on ? svg`
              <circle
                class="ring-fill"
                cx="15" cy="15" r=${CHIP_RING_RADIUS}
                stroke-dasharray=${CHIP_RING_CIRCUMFERENCE.toFixed(2)}
                stroke-dashoffset=${dashOffset.toFixed(2)}
              ></circle>
            ` : nothing}
          </svg>
          <ha-icon icon=${this._chipIcon(chip)}></ha-icon>
        </span>
        <span class="chip-name">${this._chipName(chip)}</span>
      </button>`;
  }

  // ── Styles ───────────────────────────────────────────────────────────────────

  static styles = css`
    :host {
      display: block;
      --sw-light-card-color:          var(--primary-color);
      --sw-light-card-track:          var(--divider-color);
      --sw-light-card-text:           var(--primary-text-color);
      --sw-light-card-text-secondary: var(--secondary-text-color);
      --sw-light-card-text-disabled:  var(--disabled-text-color);
      --sw-light-card-border:         var(--divider-color);
      --sw-light-card-chip-bg:        transparent;
      --sw-light-card-font:           var(--primary-font-family, sans-serif);
      --sw-light-card-dial-size:      180px;
      --sw-light-card-ct-warm:        #f5c07a;
      --sw-light-card-ct-cold:        #cfe2ff;
    }

    ha-card {
      position: relative;
      padding: 16px;
      font-family: var(--sw-light-card-font);
    }

    /* ha-icon is an inline custom element by default — Safari misaligns it */
    ha-icon {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .title {
      position: absolute;
      top: 8px;
      left: 16px;
      font-size: 9px;
      color: var(--sw-light-card-text-disabled);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      pointer-events: none;
    }

    .empty {
      padding: 16px;
      font-size: 12px;
      color: var(--sw-light-card-text-secondary);
    }

    .dial-wrap {
      display: flex;
      justify-content: center;
      padding: 4px 0 0;
    }

    .dial {
      position: relative;
      width: var(--sw-light-card-dial-size);
      height: var(--sw-light-card-dial-size);
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      cursor: pointer;
    }

    .dial svg {
      width: 100%;
      height: 100%;
      display: block;
    }

    .track {
      fill: none;
      stroke: var(--sw-light-card-track);
      stroke-width: 12;
      stroke-linecap: round;
    }

    .track--ct {
      stroke: url(#sw-lc-ct-grad);
    }

    .fill {
      fill: none;
      stroke: var(--sw-light-card-color);
      stroke-width: 12;
      stroke-linecap: round;
    }

    .thumb {
      fill: var(--sw-light-card-color);
      stroke: var(--card-background-color, #fff);
      stroke-width: 2;
    }

    .center {
      position: absolute;
      inset: 27%;
      border-radius: 50%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      cursor: pointer;
      text-align: center;
    }

    .center-value {
      font-size: 26px;
      font-weight: 300;
      line-height: 1;
      color: var(--sw-light-card-text);
    }

    .center-sub {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--sw-light-card-text-secondary);
      --mdc-icon-size: 14px;
      max-width: 100%;
    }

    .center-sub ha-icon {
      width: 14px;
      height: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .center-sub--off {
      color: var(--sw-light-card-text-disabled);
    }

    .center-sub--name span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .mode-btn {
      position: absolute;
      bottom: 2px;
      left: 50%;
      transform: translateX(-50%);
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 1px solid var(--sw-light-card-border);
      background: var(--sw-light-card-chip-bg);
      color: var(--sw-light-card-text-secondary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      --mdc-icon-size: 16px;
      transition: color 0.2s, border-color 0.2s;
    }

    .mode-btn:hover {
      color: var(--sw-light-card-text);
      border-color: var(--sw-light-card-text-secondary);
    }

    .scenes {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 6px;
      padding-top: 14px;
    }

    .scene-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border: 1px solid var(--sw-light-card-border);
      border-radius: 16px;
      background: var(--sw-light-card-chip-bg);
      color: var(--sw-light-card-text-secondary);
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      --mdc-icon-size: 14px;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      transition: color 0.2s, border-color 0.2s, background 0.2s;
    }

    .scene-pill ha-icon {
      width: 14px;
      height: 14px;
      color: var(--sw-light-card-color);
      flex-shrink: 0;
    }

    .scene-pill:active {
      border-color: var(--sw-light-card-color);
      color: var(--sw-light-card-text);
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px;
      padding-top: 12px;
    }

    .chip {
      background: none;
      border: none;
      padding: 4px;
      margin: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      border-radius: 10px;
      touch-action: pan-y;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      font-family: inherit;
      transition: background 0.2s;
    }

    .chip--single {
      background: var(--sw-light-card-chip-bg);
      box-shadow: 0 0 0 1px var(--sw-light-card-color);
    }

    .chip--unavailable {
      opacity: 0.35;
      pointer-events: none;
    }

    .chip-ring {
      position: relative;
      width: 34px;
      height: 34px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .chip-ring svg {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 30px;
      height: 30px;
      transform: rotate(-90deg);
    }

    .ring-track {
      fill: none;
      stroke: var(--sw-light-card-track);
      stroke-width: 2;
    }

    .ring-fill {
      fill: none;
      stroke: var(--sw-light-card-color);
      stroke-width: 2;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.2s;
    }

    .chip-ring ha-icon {
      /* Fixed integer geometry: 16px icon at offset (34-16)/2 = 9px.
         No percentages, no transforms, no flex — nothing left to misround. */
      --mdc-icon-size: 16px;
      position: absolute;
      top: 9px;
      left: 9px;
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--sw-light-card-text-disabled);
    }

    .chip--on .chip-ring ha-icon {
      color: var(--sw-light-card-color);
    }

    .chip-name {
      font-size: 10px;
      color: var(--sw-light-card-text-secondary);
      max-width: 64px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;
}
