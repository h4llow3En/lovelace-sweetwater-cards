import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { state } from 'lit/decorators.js';
import type { HomeAssistant } from '../types/ha';

// ── Config types ──────────────────────────────────────────────────────────────

export interface ScheduleEntityConfig {
  entity: string;
  name?: string;
  icon?: string;
}

export interface ScheduleCardConfig {
  name?: string;
  // target entities: filters schedules + offers creation (string or object form)
  entities?: Array<string | ScheduleEntityConfig>;
  schedules?: string[];  // explicit switch.schedule_* entity ids
  tags?: string[];       // filter by scheduler tags
  discover?: boolean;    // show ALL schedules when no filter is set (default false)
  time_step?: number;    // editor stepper granularity in minutes (default 15)
  styles?: Record<string, string>;
}

// ── scheduler-component payload types ────────────────────────────────────────

interface WsAction {
  service?: string;
  action?: string;
  entity_id?: string;
  service_data?: Record<string, unknown>;
}

interface WsTimeslot {
  start: string;
  stop?: string | null;
  actions?: WsAction[];
  conditions?: unknown[];
  condition_type?: string;
  track_conditions?: boolean;
}

interface WsSchedule {
  schedule_id: string;
  weekdays: string[];
  timeslots: WsTimeslot[];
  repeat_type: string;
  name?: string | null;
  enabled?: boolean;
  start_date?: string | null;
  end_date?: string | null;
}

// ── View model ───────────────────────────────────────────────────────────────

interface SlotView {
  start: string;
  stop: string | null;
  action: WsAction | null;
}

interface ScheduleView {
  entityId: string;
  scheduleId: string;
  name: string;
  enabled: boolean;
  weekdays: string[];
  slots: SlotView[];
  targets: string[];
  nextTrigger: string | null;
  editable: boolean;
}

interface Segment { leftPct: number; widthPct: number; past: boolean }
interface Marker { leftPct: number; past: boolean }

interface EditorWindow { start: number; end: number } // minutes since midnight

interface EditorState {
  mode: 'create' | 'edit';
  scheduleEntityId?: string;
  scheduleName?: string;
  targetEntity: string;
  windows: EditorWindow[];
  weekdays: Set<string>;
  repeatType: string;
  onServiceData?: Record<string, unknown>;
  actionKey: 'service' | 'action';
  busy: boolean;
  error?: string;
  confirmDelete?: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const HOLD_DURATION_MS = 500;
const MOVE_SLOP_PX = 8;
const EDIT_MODE_TIMEOUT_MS = 60_000;
const NOW_REFRESH_MS = 30_000;
const WINDOW_HALF_MS = 12 * 3600_000;
const WINDOW_MS = 2 * WINDOW_HALF_MS;
const DAY_MS = 86_400_000;
const DEFAULT_TIME_STEP = 15;
const DEFAULT_WINDOW: EditorWindow = { start: 6 * 60, end: 22 * 60 };

const DAY_TOKENS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEK_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WORKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKEND = ['sat', 'sun'];

// Short weekday labels in the browser locale (2024-01-01 is a Monday)
const WEEKDAY_LABELS: Record<string, string> = (() => {
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const labels: Record<string, string> = {};
  WEEK_ORDER.forEach((token, i) => {
    labels[token] = fmt.format(new Date(2024, 0, 1 + i)).replace('.', '');
  });
  return labels;
})();

const DOMAIN_ICONS: Record<string, string> = {
  light: 'mdi:lightbulb',
  switch: 'mdi:power-plug',
  climate: 'mdi:thermostat',
  fan: 'mdi:fan',
  cover: 'mdi:window-shutter',
};

// ── Pure helpers ─────────────────────────────────────────────────────────────

function pad2(n: number): string { return String(n).padStart(2, '0'); }

function minutesToTimeString(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}:00`;
}

function minutesLabel(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

function parseFixedTimeMinutes(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function weekdayActive(weekdays: string[], jsDay: number): boolean {
  if (!weekdays?.length || weekdays.includes('daily')) return true;
  if (weekdays.includes(DAY_TOKENS[jsDay])) return true;
  if (weekdays.includes('workday') && jsDay >= 1 && jsDay <= 5) return true;
  if (weekdays.includes('weekend') && (jsDay === 0 || jsDay === 6)) return true;
  return false;
}

function expandWeekdays(weekdays: string[]): Set<string> {
  const set = new Set<string>();
  if (!weekdays?.length || weekdays.includes('daily')) return new Set(WEEK_ORDER);
  for (const token of weekdays) {
    if (token === 'workday') WORKDAYS.forEach(d => set.add(d));
    else if (token === 'weekend') WEEKEND.forEach(d => set.add(d));
    else if (WEEK_ORDER.includes(token)) set.add(token);
  }
  return set.size ? set : new Set(WEEK_ORDER);
}

function compactWeekdays(set: Set<string>): string[] {
  if (set.size >= 7 || set.size === 0) return ['daily'];
  const isWorkdays = WORKDAYS.every(d => set.has(d));
  const isWeekend = WEEKEND.every(d => set.has(d));
  if (isWorkdays && !isWeekend && set.size === 5) return ['workday'];
  if (isWeekend && !isWorkdays && set.size === 2) return ['weekend'];
  return WEEK_ORDER.filter(d => set.has(d));
}

function actionService(action: WsAction | null | undefined): string {
  return action?.service ?? action?.action ?? '';
}

function isOnService(service: string): boolean { return service.endsWith('turn_on'); }
function isOffService(service: string): boolean { return service.endsWith('turn_off'); }

function makeAction(
  key: 'service' | 'action',
  service: string,
  entityId: string,
  serviceData?: Record<string, unknown>,
): WsAction {
  const action: WsAction = { entity_id: entityId };
  action[key] = service;
  if (serviceData && Object.keys(serviceData).length) action.service_data = serviceData;
  return action;
}

// ── Card ─────────────────────────────────────────────────────────────────────

export class SwScheduleCard extends LitElement {
  @state() private _editor: EditorState | null = null;
  // Long-press on the card toggles edit mode: only then are the add button,
  // ghost rows and the inline editor reachable.
  @state() private _editMode = false;

  private _hass?: HomeAssistant;
  private _config?: ScheduleCardConfig;
  private _appliedVars = new Set<string>();
  private _entityConfigs: ScheduleEntityConfig[] = [];
  private _candidates: string[] = [];
  private _nowTimer?: number;
  private _holdTimer?: number;
  private _holdFired = false;
  private _cardHoldTimer?: number;
  private _cardHoldFired = false;
  private _cardStartX = 0;
  private _cardStartY = 0;
  private _editModeTimer?: number;

  // ── HA card interface ───────────────────────────────────────────────────────

  set hass(hass: HomeAssistant) {
    const old = this._hass;
    this._hass = hass;

    const needsDiscovery = !old
      || old.areas !== hass.areas
      || old.entities !== hass.entities
      || old.devices !== hass.devices;

    if (needsDiscovery) this._discoverCandidates();

    let dirty = needsDiscovery || !old;
    if (!dirty && old) {
      for (const eid of this._trackedEntities()) {
        if (old.states[eid] !== hass.states[eid]) { dirty = true; break; }
      }
    }
    if (dirty) this.requestUpdate();
  }

  get hass(): HomeAssistant { return this._hass!; }

  setConfig(config: ScheduleCardConfig): void {
    if (!config) throw new Error('sw-schedule-card: missing config');
    this._config = config;
    this._entityConfigs = (config.entities ?? [])
      .map(e => (typeof e === 'string' ? { entity: e } : e))
      .filter(e => !!e?.entity);
    this._editor = null;

    this._appliedVars.forEach(p => this.style.removeProperty(p));
    this._appliedVars.clear();
    for (const [k, v] of Object.entries(config.styles ?? {})) {
      const prop = k.startsWith('--') ? k : `--sw-schedule-card-${k}`;
      this.style.setProperty(prop, String(v));
      this._appliedVars.add(prop);
    }

    if (this._hass) this._discoverCandidates();
    this.requestUpdate();
  }

  connectedCallback(): void {
    super.connectedCallback();
    // The timeline window is centered on "now" — keep it rolling.
    this._nowTimer = window.setInterval(() => this.requestUpdate(), NOW_REFRESH_MS);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._nowTimer != null) { clearInterval(this._nowTimer); this._nowTimer = undefined; }
    if (this._holdTimer != null) { clearTimeout(this._holdTimer); this._holdTimer = undefined; }
    if (this._cardHoldTimer != null) { clearTimeout(this._cardHoldTimer); this._cardHoldTimer = undefined; }
    if (this._editModeTimer != null) { clearTimeout(this._editModeTimer); this._editModeTimer = undefined; }
  }

  // ── Edit mode (long-press on the card) ──────────────────────────────────────
  // The override button and the inline editor stop pointerdown propagation, so
  // their own press/hold interactions never reach these handlers.

  private _onCardPointerDown(e: PointerEvent): void {
    this._cardHoldFired = false;
    this._cardStartX = e.clientX;
    this._cardStartY = e.clientY;
    if (this._cardHoldTimer != null) clearTimeout(this._cardHoldTimer);
    this._cardHoldTimer = window.setTimeout(() => {
      this._cardHoldTimer = undefined;
      this._cardHoldFired = true;
      this._toggleEditMode();
    }, HOLD_DURATION_MS);
  }

  private _onCardPointerMove(e: PointerEvent): void {
    if (this._cardHoldTimer == null) return;
    // Finger is scrolling the popup, not holding the card
    if (Math.hypot(e.clientX - this._cardStartX, e.clientY - this._cardStartY) > MOVE_SLOP_PX) {
      clearTimeout(this._cardHoldTimer);
      this._cardHoldTimer = undefined;
    }
  }

  private _onCardPointerUp(): void {
    if (this._cardHoldTimer != null) { clearTimeout(this._cardHoldTimer); this._cardHoldTimer = undefined; }
  }

  /** Swallows the click that follows a fired long-press. */
  private _consumeCardHold(): boolean {
    const fired = this._cardHoldFired;
    this._cardHoldFired = false;
    return fired;
  }

  private _toggleEditMode(): void {
    this._editMode = !this._editMode;
    if (!this._editMode) this._closeEditor();
    this._armEditModeTimer();
  }

  private _armEditModeTimer(): void {
    if (this._editModeTimer != null) { clearTimeout(this._editModeTimer); this._editModeTimer = undefined; }
    if (!this._editMode) return;
    this._editModeTimer = window.setTimeout(() => {
      this._editModeTimer = undefined;
      if (this._editor) { this._armEditModeTimer(); return; } // keep alive while editing
      this._editMode = false;
    }, EDIT_MODE_TIMEOUT_MS);
  }

  getCardSize(): number { return 3; }

  static async getConfigElement() {
    return document.createElement('sw-schedule-card-editor');
  }

  static getStubConfig(): ScheduleCardConfig {
    return { entities: [] };
  }

  // ── Discovery / filtering ───────────────────────────────────────────────────

  private _discoverCandidates(): void {
    const hass = this._hass;
    if (!hass?.entities) { this._candidates = []; return; }
    this._candidates = Object.keys(hass.entities).filter(id => id.startsWith('switch.schedule_'));
  }

  private _trackedEntities(): string[] {
    const ids = new Set<string>(this._candidates);
    for (const e of this._entityConfigs) ids.add(e.entity);
    for (const id of this._config?.schedules ?? []) ids.add(id);
    for (const view of this._schedules()) view.targets.forEach(t => ids.add(t));
    ids.add('sun.sun');
    return [...ids];
  }

  private _schedules(): ScheduleView[] {
    const hass = this._hass;
    const cfg = this._config;
    if (!hass || !cfg) return [];

    const explicit = cfg.schedules ?? [];
    const filterEntities = this._entityConfigs.map(e => e.entity);
    const filterTags = cfg.tags ?? [];
    const hasFilter = explicit.length > 0 || filterEntities.length > 0 || filterTags.length > 0;
    // Without any filter the card shows nothing — listing every schedule of
    // the installation is opt-in via `discover: true`.
    if (!hasFilter && cfg.discover !== true) return [];

    const ids = explicit.length ? explicit : this._candidates;
    const views: ScheduleView[] = [];

    for (const entityId of ids) {
      const s = hass.states[entityId];
      if (!s) continue;
      const attrs = s.attributes;
      const targets = (attrs.entities as string[] | undefined) ?? [];
      const tags = (attrs.tags as string[] | undefined) ?? [];

      if (!explicit.length && hasFilter) {
        const entityMatch = filterEntities.some(e => targets.includes(e));
        const tagMatch = filterTags.some(t => tags.includes(t));
        if (!entityMatch && !tagMatch) continue;
      }

      const timeslots = (attrs.timeslots as string[] | undefined) ?? [];
      const actions = (attrs.actions as WsAction[] | undefined) ?? [];
      const slots: SlotView[] = timeslots.map((ts, i) => {
        const parts = ts.split(' - ');
        return {
          start: parts[0]?.trim() ?? ts,
          stop: parts.length > 1 ? parts[1].trim() : null,
          action: actions[i] ?? null,
        };
      });

      const name = this._entityOverride(targets[0])?.name
        || (attrs.name as string | undefined)
        || this._friendlyName(targets[0])
        || (attrs.friendly_name as string | undefined)
        || entityId;

      views.push({
        entityId,
        scheduleId: entityId.replace(/^switch\.schedule_/, ''),
        name,
        enabled: s.state !== 'off',
        weekdays: (attrs.weekdays as string[] | undefined) ?? ['daily'],
        slots,
        targets,
        nextTrigger: (attrs.next_trigger as string | undefined) ?? null,
        editable: this._isEditable(slots, targets),
      });
    }
    return views;
  }

  /** Simple on/off scheme schedules with fixed times can use the inline editor.
   *  Note: the state-attribute actions carry NO entity_id (the component strips
   *  it) — the target comes from the schedule's `entities` attribute instead. */
  private _isEditable(slots: SlotView[], targets: string[]): boolean {
    if (!slots.length || targets.length !== 1) return false;
    let hasOn = false;
    for (const slot of slots) {
      if (slot.stop == null) return false; // single-point schedules: display only
      if (parseFixedTimeMinutes(slot.start) == null) return false; // sun-based
      if (parseFixedTimeMinutes(slot.stop) == null) return false;
      if (!slot.action) continue;
      const service = actionService(slot.action);
      if (!isOnService(service) && !isOffService(service)) return false;
      const entity = slot.action.entity_id;
      if (entity && entity !== targets[0]) return false;
      if (isOnService(service)) hasOn = true;
    }
    return hasOn;
  }

  private _friendlyName(entityId: string | undefined): string | undefined {
    if (!entityId) return undefined;
    return this._hass?.states[entityId]?.attributes.friendly_name as string | undefined;
  }

  private _entityOverride(entityId: string | undefined): ScheduleEntityConfig | undefined {
    if (!entityId) return undefined;
    return this._entityConfigs.find(e => e.entity === entityId);
  }

  private _entityName(entityId: string): string {
    return this._entityOverride(entityId)?.name
      ?? this._friendlyName(entityId)
      ?? entityId;
  }

  private _targetIcon(schedule: { targets: string[] }): string {
    const target = schedule.targets[0];
    if (!target) return 'mdi:calendar-clock';
    const override = this._entityOverride(target)?.icon;
    if (override) return override;
    const icon = this._hass?.states[target]?.attributes.icon as string | undefined;
    if (icon) return icon;
    return DOMAIN_ICONS[target.split('.')[0]] ?? 'mdi:power-plug';
  }

  /** Config entities that no resolved schedule controls yet → offer creation. */
  private _unscheduledEntities(views: ScheduleView[]): string[] {
    const covered = new Set(views.flatMap(v => v.targets));
    return this._entityConfigs.map(e => e.entity).filter(e => !covered.has(e));
  }

  // ── Time resolution ─────────────────────────────────────────────────────────

  /** Milliseconds since local midnight; resolves sunrise/sunset approximately. */
  private _resolveTimeMs(t: string): number | null {
    const fixed = parseFixedTimeMinutes(t);
    if (fixed != null) return fixed * 60_000;

    const sun = /^(sunrise|sunset)\s*([+-])\s*(\d{1,2}):(\d{2})/.exec(t.trim());
    if (!sun) return null;
    const sunState = this._hass?.states['sun.sun'];
    const iso = sun[1] === 'sunrise'
      ? sunState?.attributes.next_rising
      : sunState?.attributes.next_setting;
    if (typeof iso !== 'string') return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    let ms = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) * 1000;
    const offset = (Number(sun[3]) * 3600 + Number(sun[4]) * 60) * 1000;
    ms += sun[2] === '+' ? offset : -offset;
    return ((ms % DAY_MS) + DAY_MS) % DAY_MS;
  }

  // ── Timeline computation (window = now ± 12 h, now centered) ────────────────

  private _computeTimeline(schedule: ScheduleView): { segments: Segment[]; markers: Marker[] } {
    const now = Date.now();
    const winStart = now - WINDOW_HALF_MS;
    const segments: Segment[] = [];
    const markers: Marker[] = [];

    const base = new Date(now);
    base.setHours(0, 0, 0, 0);

    const pushSegment = (fromMs: number, toMs: number, past: boolean) => {
      const leftPct = ((fromMs - winStart) / WINDOW_MS) * 100;
      const widthPct = ((toMs - fromMs) / WINDOW_MS) * 100;
      if (widthPct <= 0) return;
      segments.push({ leftPct, widthPct, past });
    };

    for (let dayOffset = -1; dayOffset <= 1; dayOffset++) {
      const day = new Date(base);
      day.setDate(base.getDate() + dayOffset);
      const dayStart = day.getTime();
      if (!weekdayActive(schedule.weekdays, day.getDay())) continue;

      for (const slot of schedule.slots) {
        const startMs = this._resolveTimeMs(slot.start);
        if (startMs == null) continue;
        const absStart = dayStart + startMs;

        if (slot.stop == null) {
          // Single time point → marker
          const leftPct = ((absStart - winStart) / WINDOW_MS) * 100;
          if (leftPct >= 0 && leftPct <= 100) {
            markers.push({ leftPct, past: absStart < now });
          }
          continue;
        }

        if (!slot.action || !isOnService(actionService(slot.action))) continue;
        const stopMs = this._resolveTimeMs(slot.stop);
        if (stopMs == null) continue;
        let absStop = dayStart + stopMs;
        if (absStop <= absStart) absStop += DAY_MS;

        const from = Math.max(absStart, winStart);
        const to = Math.min(absStop, winStart + WINDOW_MS);
        if (to <= from) continue;
        if (from < now && to > now) {
          pushSegment(from, now, true);
          pushSegment(now, to, false);
        } else {
          pushSegment(from, to, from < now);
        }
      }
    }
    return { segments, markers };
  }

  // ── Override: tap = boost, hold = pause/resume ───────────────────────────────

  private _boost(schedule: ScheduleView): void {
    const hass = this._hass;
    if (!hass) return;
    for (const target of schedule.targets) {
      hass.callService('homeassistant', 'toggle', { entity_id: target });
    }
  }

  private _togglePause(schedule: ScheduleView): void {
    this._hass?.callService('switch', schedule.enabled ? 'turn_off' : 'turn_on', {
      entity_id: schedule.entityId,
    });
  }

  private _onOverridePointerDown(e: PointerEvent, schedule: ScheduleView): void {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    this._holdFired = false;
    if (this._holdTimer != null) clearTimeout(this._holdTimer);
    this._holdTimer = window.setTimeout(() => {
      this._holdTimer = undefined;
      this._holdFired = true;
      this._togglePause(schedule);
    }, HOLD_DURATION_MS);
  }

  private _onOverridePointerUp(e: PointerEvent, schedule: ScheduleView): void {
    if (this._holdTimer != null) { clearTimeout(this._holdTimer); this._holdTimer = undefined; }
    const el = e.currentTarget as Element;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const fired = this._holdFired;
    this._holdFired = false;
    if (e.type === 'pointercancel') return;
    if (!fired) this._boost(schedule);
  }

  private _anyTargetOn(schedule: ScheduleView): boolean {
    return schedule.targets.some(t => this._hass?.states[t]?.state === 'on');
  }

  private _openMoreInfo(entityId: string): void {
    this.dispatchEvent(new CustomEvent('hass-more-info', {
      detail: { entityId }, bubbles: true, composed: true,
    }));
  }

  // ── Inline editor ────────────────────────────────────────────────────────────

  private get _timeStep(): number {
    return this._config?.time_step ?? DEFAULT_TIME_STEP;
  }

  private async _openEditor(schedule: ScheduleView): Promise<void> {
    if (!schedule.editable) return;

    // Prefer the full item (exact stored shape incl. action key style); the
    // state attributes are the fallback if the websocket call fails.
    let slots: WsTimeslot[] | null = null;
    let repeatType = 'repeat';
    let name: string | undefined;
    try {
      const item = await this._hass!.callWS<WsSchedule>({
        type: 'scheduler/item',
        schedule_id: schedule.scheduleId,
      });
      if (item?.timeslots?.length) {
        slots = item.timeslots;
        repeatType = item.repeat_type || 'repeat';
        name = item.name ?? undefined;
      }
    } catch (err) {
      console.warn('sw-schedule-card: scheduler/item fetch failed, falling back to state attributes', err);
    }
    if (!slots) {
      slots = schedule.slots.map(s => ({
        start: s.start,
        stop: s.stop ?? undefined,
        actions: s.action ? [s.action] : [],
      }));
      const attrs = this._hass?.states[schedule.entityId]?.attributes;
      repeatType = (attrs?.repeat_type as string | undefined) ?? 'repeat';
      name = attrs?.name as string | undefined;
    }

    let actionKey: 'service' | 'action' = 'service';
    let targetEntity = schedule.targets[0] ?? '';
    let onServiceData: Record<string, unknown> | undefined;
    const windows: EditorWindow[] = [];

    for (const slot of slots) {
      const action = slot.actions?.[0];
      if (!action) continue;
      if (action.action && !action.service) actionKey = 'action';
      const service = actionService(action);
      if (!isOnService(service)) continue;
      const start = parseFixedTimeMinutes(slot.start);
      const end = slot.stop ? parseFixedTimeMinutes(slot.stop) : null;
      if (start == null || end == null) return; // shouldn't happen (editable check)
      windows.push({ start, end });
      if (action.entity_id) targetEntity = action.entity_id;
      if (action.service_data && Object.keys(action.service_data).length) {
        onServiceData = action.service_data;
      }
    }
    if (!windows.length || !targetEntity) {
      console.warn('sw-schedule-card: schedule has no editable on-windows', schedule.entityId);
      return;
    }
    windows.sort((a, b) => a.start - b.start);

    this._editor = {
      mode: 'edit',
      scheduleEntityId: schedule.entityId,
      scheduleName: name,
      targetEntity,
      windows,
      weekdays: expandWeekdays(schedule.weekdays),
      repeatType,
      onServiceData,
      actionKey,
      busy: false,
    };
    this._armEditModeTimer();
  }

  private _openCreateEditor(targetEntity: string): void {
    this._editor = {
      mode: 'create',
      targetEntity,
      scheduleName: this._entityName(targetEntity),
      windows: [{ ...DEFAULT_WINDOW }],
      weekdays: new Set(WEEK_ORDER),
      repeatType: 'repeat',
      actionKey: 'service',
      busy: false,
    };
    this._armEditModeTimer();
  }

  private _closeEditor(): void {
    this._editor = null;
  }

  private _patchEditor(patch: Partial<EditorState>): void {
    if (!this._editor) return;
    this._editor = { ...this._editor, ...patch, error: patch.error, confirmDelete: patch.confirmDelete };
    this._armEditModeTimer();
  }

  private _stepWindow(index: number, field: 'start' | 'end', dir: number): void {
    const editor = this._editor;
    if (!editor) return;
    const windows = editor.windows.map((w, i) =>
      i === index ? { ...w, [field]: ((w[field] + dir * this._timeStep) % 1440 + 1440) % 1440 } : w,
    );
    this._patchEditor({ windows });
  }

  private _addWindow(): void {
    const editor = this._editor;
    if (!editor) return;
    const last = editor.windows[editor.windows.length - 1];
    const start = ((last?.end ?? 0) + 120) % 1440;
    this._patchEditor({ windows: [...editor.windows, { start, end: (start + 120) % 1440 }] });
  }

  private _removeWindow(index: number): void {
    const editor = this._editor;
    if (!editor || editor.windows.length <= 1) return;
    this._patchEditor({ windows: editor.windows.filter((_, i) => i !== index) });
  }

  private _toggleWeekday(token: string): void {
    const editor = this._editor;
    if (!editor) return;
    const weekdays = new Set(editor.weekdays);
    if (weekdays.has(token)) weekdays.delete(token);
    else weekdays.add(token);
    if (!weekdays.size) return; // at least one day
    this._patchEditor({ weekdays });
  }

  private _validateWindows(windows: EditorWindow[]): string | null {
    for (const w of windows) {
      if (w.start === w.end) return 'invalid';
    }
    if (windows.length > 1) {
      const sorted = [...windows].sort((a, b) => a.start - b.start);
      for (let i = 0; i < sorted.length; i++) {
        const w = sorted[i];
        if (w.end <= w.start) return 'overlap'; // wrap only allowed for single window
        const next = sorted[(i + 1) % sorted.length];
        if (i < sorted.length - 1 && w.end > next.start) return 'overlap';
      }
    }
    return null;
  }

  private _buildTimeslots(editor: EditorState): WsTimeslot[] {
    const domain = editor.targetEntity.split('.')[0];
    const serviceDomain = ['light', 'switch', 'fan'].includes(domain) ? domain : 'homeassistant';
    const onAction = makeAction(editor.actionKey, `${serviceDomain}.turn_on`, editor.targetEntity, editor.onServiceData);
    const offAction = makeAction(editor.actionKey, `${serviceDomain}.turn_off`, editor.targetEntity);

    const windows = [...editor.windows].sort((a, b) => a.start - b.start);
    const slots: WsTimeslot[] = [];
    windows.forEach((w, i) => {
      slots.push({ start: minutesToTimeString(w.start), stop: minutesToTimeString(w.end), actions: [onAction] });
      const nextStart = windows[(i + 1) % windows.length].start;
      const gapStart = w.end;
      const gapEnd = nextStart;
      if (gapStart !== gapEnd) {
        slots.push({ start: minutesToTimeString(gapStart), stop: minutesToTimeString(gapEnd), actions: [offAction] });
      }
    });
    return slots;
  }

  private async _saveEditor(): Promise<void> {
    const editor = this._editor;
    const hass = this._hass;
    if (!editor || !hass || editor.busy) return;

    const invalid = this._validateWindows(editor.windows);
    if (invalid) {
      this._patchEditor({ error: invalid });
      return;
    }

    const data: Record<string, unknown> = {
      weekdays: compactWeekdays(editor.weekdays),
      timeslots: this._buildTimeslots(editor),
      repeat_type: editor.repeatType || 'repeat',
    };
    if (editor.scheduleName) data.name = editor.scheduleName;

    this._patchEditor({ busy: true });
    try {
      if (editor.mode === 'edit') {
        await hass.callService('scheduler', 'edit', { ...data, entity_id: editor.scheduleEntityId });
      } else {
        await hass.callService('scheduler', 'add', data);
      }
      this._editor = null;
    } catch (err) {
      console.warn('sw-schedule-card: save failed', err);
      this._patchEditor({ busy: false, error: String(err) });
    }
  }

  private async _deleteSchedule(): Promise<void> {
    const editor = this._editor;
    const hass = this._hass;
    if (!editor || !hass || editor.mode !== 'edit') return;
    if (!editor.confirmDelete) {
      this._patchEditor({ confirmDelete: true });
      return;
    }
    this._patchEditor({ busy: true });
    try {
      await hass.callService('scheduler', 'remove', { entity_id: editor.scheduleEntityId });
      this._editor = null;
    } catch (err) {
      this._patchEditor({ busy: false, error: String(err) });
    }
  }

  private _localize(key: string, fallback: string): string {
    try {
      return this._hass?.localize(key) || fallback;
    } catch {
      return fallback;
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  render() {
    if (!this._config || !this._hass) return nothing;

    const schedules = this._schedules();
    const unscheduled = this._unscheduledEntities(schedules);

    const configEntities = this._entityConfigs;
    const creating = this._editor?.mode === 'create';

    return html`
      <ha-card
        @pointerdown=${this._onCardPointerDown}
        @pointermove=${this._onCardPointerMove}
        @pointerup=${this._onCardPointerUp}
        @pointercancel=${this._onCardPointerUp}
        @click=${() => { this._cardHoldFired = false; }}
      >
        ${this._config.name ? html`<div class="title">${this._config.name}</div>` : nothing}
        <div class="rows ${this._config.name ? 'rows--with-title' : ''}">
          ${schedules.map(schedule => this._renderRow(schedule))}
          ${this._editMode ? unscheduled.map(entityId => this._renderGhostRow(entityId)) : nothing}
          ${!schedules.length && !(this._editMode && unscheduled.length) ? html`
            <div class="empty">
              ${configEntities.length || this._config.schedules?.length || this._config.tags?.length
                ? 'No schedules yet — hold the card to add one.'
                : html`No schedules — configure <code>entities</code>, <code>schedules</code> or
                  <code>tags</code>, or set <code>discover: true</code> to list everything.`}
            </div>
          ` : nothing}
          ${this._editMode && configEntities.length ? html`
            <button class="add-btn" @click=${() => this._onAddTap()}>
              <ha-icon icon="mdi:plus"></ha-icon>
            </button>
          ` : nothing}
          ${creating ? this._renderEditor() : nothing}
        </div>
      </ha-card>`;
  }

  private _onAddTap(): void {
    if (this._consumeCardHold()) return;
    this._armEditModeTimer();
    if (this._editor?.mode === 'create') { this._closeEditor(); return; }
    if (!this._entityConfigs.length) return;
    const uncovered = this._unscheduledEntities(this._schedules());
    this._openCreateEditor(uncovered[0] ?? this._entityConfigs[0].entity);
  }

  private _renderRow(schedule: ScheduleView): TemplateResult {
    const { segments, markers } = this._computeTimeline(schedule);
    const targetOn = this._anyTargetOn(schedule);
    const editing = this._editor?.mode === 'edit'
      && this._editor.scheduleEntityId === schedule.entityId;
    const nextTime = schedule.enabled && schedule.nextTrigger
      ? new Date(schedule.nextTrigger) : null;
    const nextLabel = nextTime && !isNaN(nextTime.getTime())
      ? `→ ${pad2(nextTime.getHours())}:${pad2(nextTime.getMinutes())}` : '';

    return html`
      <div class="row ${schedule.enabled ? '' : 'row--paused'}">
        <div
          class="row-main row-main--editable"
          @click=${() => {
            if (this._consumeCardHold()) return;
            if (editing) this._closeEditor();
            else if (this._editMode && schedule.editable) this._openEditor(schedule);
            else this._openMoreInfo(schedule.entityId);
          }}
        >
          <div class="row-head">
            <ha-icon class="row-icon" icon=${this._targetIcon(schedule)}></ha-icon>
            <span class="row-name">${schedule.name}</span>
            ${this._editMode && schedule.editable ? html`
              <ha-icon class="row-edit-icon" icon="mdi:pencil-outline"></ha-icon>` : nothing}
            ${schedule.enabled
              ? html`<span class="row-status">${nextLabel}</span>`
              : html`<ha-icon class="row-status-icon" icon="mdi:pause"></ha-icon>`}
          </div>
          ${this._renderTrack(segments, markers)}
        </div>
        <button
          class="override ${targetOn ? 'override--on' : ''}"
          title="Boost / hold: pause"
          @pointerdown=${(e: PointerEvent) => this._onOverridePointerDown(e, schedule)}
          @pointerup=${(e: PointerEvent) => this._onOverridePointerUp(e, schedule)}
          @pointercancel=${(e: PointerEvent) => this._onOverridePointerUp(e, schedule)}
          @click=${(e: Event) => e.stopPropagation()}
        >
          <ha-icon icon=${schedule.enabled ? 'mdi:power' : 'mdi:play'}></ha-icon>
        </button>
      </div>
      ${editing ? this._renderEditor() : nothing}`;
  }

  private _renderGhostRow(entityId: string): TemplateResult {
    const creating = this._editor?.mode === 'create' && this._editor.targetEntity === entityId;
    const name = this._entityName(entityId);
    const toggleCreate = () => {
      if (this._consumeCardHold()) return;
      if (creating) this._closeEditor();
      else this._openCreateEditor(entityId);
    };
    return html`
      <div class="row row--ghost">
        <div class="row-main row-main--editable" @click=${toggleCreate}>
          <div class="row-head">
            <ha-icon class="row-icon" icon=${this._targetIcon({ targets: [entityId] })}></ha-icon>
            <span class="row-name">${name}</span>
          </div>
          <div class="track track--ghost">
            <div class="now-marker"></div>
          </div>
        </div>
        <button class="override override--ghost" @click=${toggleCreate}>
          <ha-icon icon="mdi:plus"></ha-icon>
        </button>
      </div>`;
  }

  private _renderTrack(segments: Segment[], markers: Marker[]): TemplateResult {
    return html`
      <div class="track">
        ${segments.map(s => html`
          <div
            class="segment ${s.past ? 'segment--past' : ''}"
            style="left:${s.leftPct.toFixed(2)}%;width:${s.widthPct.toFixed(2)}%;"
          ></div>`)}
        ${markers.map(m => html`
          <div class="marker ${m.past ? 'segment--past' : ''}" style="left:${m.leftPct.toFixed(2)}%;"></div>`)}
        <div class="tick tick--quarter" style="left:25%;"></div>
        <div class="tick tick--quarter" style="left:75%;"></div>
        <div class="now-marker"></div>
      </div>`;
  }

  private _renderEditor(): TemplateResult {
    const editor = this._editor!;
    const save = this._localize('ui.common.save', 'Save');
    const cancel = this._localize('ui.common.cancel', 'Cancel');
    const del = this._localize('ui.common.delete', 'Delete');

    const targetChoices = editor.mode === 'create' ? this._entityConfigs.map(e => e.entity) : [];

    return html`
      <div class="editor" @pointerdown=${(e: Event) => e.stopPropagation()}>
        ${targetChoices.length > 1 ? html`
          <div class="target-pills">
            ${targetChoices.map(id => html`
              <button
                class="target-pill ${editor.targetEntity === id ? 'target-pill--active' : ''}"
                ?disabled=${editor.busy}
                @click=${() => this._patchEditor({ targetEntity: id, scheduleName: this._entityName(id) })}
              >${this._entityName(id)}</button>`)}
          </div>` : nothing}
        ${editor.windows.map((w, i) => html`
          <div class="window">
            <ha-icon icon="mdi:weather-sunny" class="window-icon"></ha-icon>
            ${this._renderTimeStepper(i, 'start', w.start)}
            <span class="window-sep">–</span>
            ${this._renderTimeStepper(i, 'end', w.end)}
            ${editor.windows.length > 1 ? html`
              <button class="icon-btn" @click=${() => this._removeWindow(i)}>
                <ha-icon icon="mdi:close"></ha-icon>
              </button>` : nothing}
          </div>`)}
        <button class="text-btn add-window" @click=${this._addWindow}>
          <ha-icon icon="mdi:plus"></ha-icon><span>Interval</span>
        </button>

        <div class="weekdays">
          ${WEEK_ORDER.map(token => html`
            <button
              class="day-chip ${editor.weekdays.has(token) ? 'day-chip--active' : ''}"
              @click=${() => this._toggleWeekday(token)}
            >${WEEKDAY_LABELS[token]}</button>`)}
        </div>

        ${editor.error ? html`<div class="error">
          ${editor.error === 'overlap' || editor.error === 'invalid'
            ? 'Invalid time windows (overlapping or empty).'
            : editor.error}
        </div>` : nothing}

        <div class="editor-actions">
          <button class="text-btn text-btn--primary" ?disabled=${editor.busy} @click=${this._saveEditor}>
            ${save}
          </button>
          <button class="text-btn" ?disabled=${editor.busy} @click=${this._closeEditor}>
            ${cancel}
          </button>
          <span class="spacer"></span>
          ${editor.mode === 'edit' ? html`
            <button class="text-btn text-btn--danger" ?disabled=${editor.busy} @click=${this._deleteSchedule}>
              ${editor.confirmDelete ? `${del}?` : del}
            </button>` : nothing}
        </div>
      </div>`;
  }

  private _renderTimeStepper(index: number, field: 'start' | 'end', minutes: number): TemplateResult {
    return html`
      <span class="stepper">
        <button class="icon-btn" @click=${() => this._stepWindow(index, field, -1)}>
          <ha-icon icon="mdi:chevron-left"></ha-icon>
        </button>
        <span class="stepper-value">${minutesLabel(minutes)}</span>
        <button class="icon-btn" @click=${() => this._stepWindow(index, field, 1)}>
          <ha-icon icon="mdi:chevron-right"></ha-icon>
        </button>
      </span>`;
  }

  // ── Styles ───────────────────────────────────────────────────────────────────

  static styles = css`
    :host {
      display: block;
      --sw-schedule-card-color:          var(--primary-color);
      --sw-schedule-card-fill:           var(--sw-schedule-card-color);
      --sw-schedule-card-track:          var(--divider-color);
      --sw-schedule-card-text:           var(--primary-text-color);
      --sw-schedule-card-text-secondary: var(--secondary-text-color);
      --sw-schedule-card-text-disabled:  var(--disabled-text-color);
      --sw-schedule-card-border:         var(--divider-color);
      --sw-schedule-card-chip-bg:        transparent;
      --sw-schedule-card-font:           var(--primary-font-family, sans-serif);
    }

    ha-card {
      position: relative;
      padding: 16px;
      font-family: var(--sw-schedule-card-font);
      /* long-press toggles edit mode — suppress selection/callout artifacts */
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
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
      color: var(--sw-schedule-card-text-disabled);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      pointer-events: none;
    }

    .rows { display: flex; flex-direction: column; gap: 14px; }
    .rows--with-title { padding-top: 10px; }

    .empty {
      font-size: 12px;
      color: var(--sw-schedule-card-text-secondary);
    }

    .row {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .row--paused .row-main { opacity: 0.45; }

    .row-main { flex: 1; min-width: 0; }
    .row-main--editable { cursor: pointer; }

    .row-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 7px;
    }

    .row-icon {
      color: var(--sw-schedule-card-text-secondary);
      --mdc-icon-size: 15px;
      width: 15px;
      height: 15px;
      flex-shrink: 0;
    }

    .row-name {
      font-size: 13px;
      color: var(--sw-schedule-card-text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .row-status {
      font-size: 10.5px;
      color: var(--sw-schedule-card-text-secondary);
      flex-shrink: 0;
      margin-left: auto;
    }

    .row-status-icon {
      color: var(--sw-schedule-card-text-disabled);
      --mdc-icon-size: 14px;
      width: 14px;
      height: 14px;
      margin-left: auto;
      flex-shrink: 0;
    }

    .row-edit-icon {
      color: var(--sw-schedule-card-text-disabled);
      --mdc-icon-size: 12px;
      width: 12px;
      height: 12px;
      flex-shrink: 0;
      opacity: 0.8;
    }

    .add-btn {
      align-self: center;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      background: none;
      border: 1px dashed var(--sw-schedule-card-border);
      border-radius: 50%;
      padding: 0;
      color: var(--sw-schedule-card-text-secondary);
      cursor: pointer;
      --mdc-icon-size: 16px;
      transition: color 0.2s, border-color 0.2s;
    }

    .add-btn:hover {
      color: var(--sw-schedule-card-text);
      border-color: var(--sw-schedule-card-text-secondary);
    }

    .target-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }

    .target-pill {
      background: var(--sw-schedule-card-chip-bg);
      border: 1px solid var(--sw-schedule-card-border);
      border-radius: 8px;
      padding: 4px 10px;
      cursor: pointer;
      color: var(--sw-schedule-card-text-disabled);
      font-size: 11px;
      font-family: inherit;
      transition: color 0.2s, border-color 0.2s, background 0.2s;
    }

    .target-pill--active {
      color: var(--card-background-color, #fff);
      background: var(--sw-schedule-card-color);
      border-color: var(--sw-schedule-card-color);
    }

    .track {
      position: relative;
      height: 6px;
      border-radius: 3px;
      background: var(--sw-schedule-card-track);
      overflow: visible;
    }

    .track--ghost {
      background: transparent;
      border: 1px dashed var(--sw-schedule-card-track);
      height: 4px;
    }

    .segment {
      position: absolute;
      top: 0;
      height: 100%;
      border-radius: 3px;
      background: var(--sw-schedule-card-fill);
    }

    .segment--past { opacity: 0.35; }

    .marker {
      position: absolute;
      top: 50%;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--sw-schedule-card-fill);
      transform: translate(-50%, -50%);
    }

    .tick--quarter {
      position: absolute;
      top: -2px;
      bottom: -2px;
      width: 1px;
      background: var(--sw-schedule-card-border);
      opacity: 0.6;
    }

    .now-marker {
      position: absolute;
      left: 50%;
      top: -4px;
      bottom: -4px;
      width: 2px;
      border-radius: 1px;
      background: var(--sw-schedule-card-text);
      transform: translateX(-50%);
    }

    .override {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      border: 1px solid var(--sw-schedule-card-border);
      background: var(--sw-schedule-card-chip-bg);
      color: var(--sw-schedule-card-text-secondary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      --mdc-icon-size: 18px;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      transition: background 0.2s, color 0.2s, border-color 0.2s;
    }

    .override ha-icon {
      width: 18px;
      height: 18px;
    }

    .override--on {
      background: var(--sw-schedule-card-color);
      border-color: var(--sw-schedule-card-color);
      color: var(--card-background-color, #fff);
    }

    .override--ghost { border-style: dashed; }

    .editor {
      border: 1px solid var(--sw-schedule-card-border);
      border-radius: 10px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .window {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .window-icon {
      color: var(--sw-schedule-card-text-disabled);
      --mdc-icon-size: 14px;
      width: 14px;
      height: 14px;
    }

    .window-sep { color: var(--sw-schedule-card-text-disabled); }

    .stepper {
      display: inline-flex;
      align-items: center;
      gap: 2px;
    }

    .stepper-value {
      font-size: 13px;
      color: var(--sw-schedule-card-text);
      min-width: 42px;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }

    .icon-btn {
      background: none;
      border: none;
      padding: 2px;
      cursor: pointer;
      color: var(--sw-schedule-card-text-secondary);
      display: flex;
      align-items: center;
      --mdc-icon-size: 16px;
    }

    .text-btn {
      background: none;
      border: 1px solid var(--sw-schedule-card-border);
      border-radius: 8px;
      padding: 5px 12px;
      cursor: pointer;
      color: var(--sw-schedule-card-text-secondary);
      font-size: 12px;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      --mdc-icon-size: 14px;
      transition: color 0.2s, border-color 0.2s, background 0.2s;
    }

    .text-btn:disabled { opacity: 0.4; cursor: default; }

    .text-btn--primary {
      background: var(--sw-schedule-card-color);
      border-color: var(--sw-schedule-card-color);
      color: var(--card-background-color, #fff);
    }

    .text-btn--danger { color: var(--error-color, #e06b6b); border-color: currentColor; }

    .add-window { align-self: flex-start; border-style: dashed; }

    .weekdays {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }

    .day-chip {
      background: var(--sw-schedule-card-chip-bg);
      border: 1px solid var(--sw-schedule-card-border);
      border-radius: 8px;
      padding: 4px 0;
      width: 36px;
      cursor: pointer;
      color: var(--sw-schedule-card-text-disabled);
      font-size: 11px;
      font-family: inherit;
      text-align: center;
      transition: color 0.2s, border-color 0.2s, background 0.2s;
    }

    .day-chip--active {
      color: var(--card-background-color, #fff);
      background: var(--sw-schedule-card-color);
      border-color: var(--sw-schedule-card-color);
    }

    .editor-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .spacer { flex: 1; }

    .error {
      font-size: 11px;
      color: var(--error-color, #e06b6b);
    }
  `;
}
