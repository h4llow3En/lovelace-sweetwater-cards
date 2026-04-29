# 🛋️ Lovelace Sweetwater Cards

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg?style=for-the-badge)](https://github.com/hacs/integration)
[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=h4llow3En&repository=lovelace-sweetwater-cards&category=plugin)

An elegant Lovelace card bundle for Home Assistant.

---

## Installation

### HACS (recommended)

Add this repository as a custom repository in HACS (type: **Lovelace**), then install *Lovelace Sweetwater Cards*.

### Manual

1. Download `sweetwater-cards.js` from the [latest release](https://github.com/h4llow3En/lovelace-sweetwater-cards/releases/latest) and copy it to `config/www/`
2. Add the resource in `configuration.yaml`:

```yaml
lovelace:
  resources:
    - url: /local/sweetwater-cards.js
      type: module
```

---

## Cards Overview

The *Lovelace Sweetwater Cards* bundle currently includes the following cards:

- **SW Room Card** (`custom:sw-room-card`): An elegant, area-aware room overview card that auto-discovers entities (lights, window sensors, temperature) and renders a 24h temperature graph.
- **SW Tab Card** (`custom:sw-tab-card`): A clean, flexible container card to define reusable nested cards and switch between them seamlessly.
- **SW Climate Card** (`custom:sw-climate-card`): A compact horizontal card for rooms — shows current temperature, humidity and a 24h background wave graph. Optionally controls a climate thermostat (target temperature stepper + HVAC mode pills).

---

## 1. SW Room Card

An elegant, area-aware room overview card.

- Auto-discovers entities from a Home Assistant area (lights, window sensors, temperature)
- Derives floor label and icon from the area automatically
- Renders a 24 h temperature graph from history data
- Flexible `rows` system for status indicators — no hardcoded entity types
- Works with any HA theme; all colours are overridable per card

---

### Minimal config

<p align="center">
  <img src="docs/default-room.gif" alt="Room Card Demo" width="49%">
  <img src="docs/light-dark-room.gif" alt="Light & Dark Mode" width="49%">
</p>

```yaml
type: custom:sw-room-card
area: living_room
```

With only `area` set, the card auto-discovers the room name, floor, icon, and temperature sensor. If none are found, those sections are simply omitted.

---

### Full config reference

<p align="center">
  <img src="docs/full-config.png" alt="Room Card Full config" width="49%">
</p>

```yaml
type: custom:sw-room-card

# ── Identity ──────────────────────────────────────────────────
area: living_room          # HA area slug. Drives auto-discovery.
name: "Living Room"        # Override area name. Use 'none' to hide.
floor: "Ground Floor"      # Override floor label. Use 'none' to hide.
                           # Auto-derived from hass.floors if area is set.
icon: mdi:sofa             # Override area icon. Use 'none' to hide.
                           # Auto-derived from area.icon if area is set.
align: left                # Header alignment: 'left' (default), 'center', or 'right'.
                           # Aligns icon, name, and floor label.

# ── Temperature & graph ────────────────────────────────────────
temp_entity: sensor.living_room_temperature
                           # Entity to show as temperature and graph.
                           # Auto-discovered (first device_class: temperature
                           # in area, then first climate entity).
                           # Set to 'none' to disable both temp and graph.
humidity_entity: sensor.living_room_humidity
                           # Optional. Shows humidity smaller + right-aligned
                           # next to the temperature. Not shown by default.
                           # Set to 'none' to explicitly disable.
                           # Use show.humidity: true to auto-discover from area.
hours_to_show: 24          # How many hours of history the graph covers.
                           # Default: 24

# ── Visibility ─────────────────────────────────────────────────
show:
  icon: true               # Room icon
  name: true               # Room name
  floor: true              # Floor label
  temp: true               # Temperature value
  humidity: false          # Humidity value (default: false — opt in explicitly)
  graph: true              # History graph
  rows: true               # All status rows

# ── Action ─────────────────────────────────────────────────────
tap_action:
  action: more-info        # Default: opens more-info for the temp entity.
                           # Also supports: navigate, url, toggle,
                           # call-service, none.
  entity: sensor.xyz       # Override entity for more-info / toggle.
                           # Defaults to temp_entity.
  navigation_path: /lovelace/home   # For action: navigate
  url_path: https://...             # For action: url
  service: light.turn_on            # For action: call-service
  service_data: {}                  # For action: call-service

# ── Status rows ────────────────────────────────────────────────
rows:
  - type: lights           # See row types below
  - type: windows
  - type: custom
    label: Bike
    content: [...]

# ── Theming ────────────────────────────────────────────────────
styles:                    # Per-card CSS variable overrides. Short keys are
  color: "#c9a96e"         # expanded to --sw-room-card-<key> automatically.
  font: "'Cormorant Garamond', serif"
  height: "260px"
```

> **`show` vs `none`** — both work independently. `show.icon: false` and `icon: none` both hide the icon. Either is fine. Use whichever reads more clearly for your use case.

> **Humidity** is opt-in: it is hidden unless you set `humidity_entity` explicitly or add `show: { humidity: true }` (which enables auto-discovery from the area).

---

### Row types

#### `lights`

One dot per light entity. Dot is lit in the primary accent colour when the light is on.

```yaml
- type: lights
  label: "Light"           # Optional. Default: localised via hass.localize
                           # ('component.light.entity_component._.name'
                           #  → e.g. "Light" / "Licht")
  entities:                # Optional. Default: all lights in the area.
    - light.living_room_ceiling
    - light.floor_lamp
```

#### `windows`

One dot per binary sensor with `device_class: window`, `door`, or `garage_door`. Dot uses the secondary accent colour when open; square shape to distinguish from lights.

```yaml
- type: windows
  label: "Window"          # Optional. Default: localised via hass.localize
                           # ('component.binary_sensor.entity_component.window.name'
                           #  → e.g. "Window" / "Fenster")
  entities:                # Optional. Default: auto from area.
    - binary_sensor.window_east
    - binary_sensor.balcony_door
```

#### `custom`

Compose a row from any combination of entity values and dots. Replaces the need for dedicated `switch`, `sensor`, or `bike` row types.

```yaml
- type: custom
  label: "Label"
  show: true                                 # Set to false to hide this row. Default: true.
  content:
    - entity: some.entity_id
      display: dot                           # 'dot' (default) or 'value'
      # --- dot options ---
      color_on: "var(--sw-room-card-color)"     # Dot colour when state is 'on'
      color_off: "var(--sw-room-card-inactive)"
      shape: circle                          # 'circle' (default) or 'square'
      pulse: true                            # Animate opacity when on. Default: false.
      # --- value options ---
      unit: "%"                              # Unit override (default: entity unit_of_measurement)
      warn_above: 1000                       # Show value in warning colour above this threshold.
                                             # Default: none (no warning).
      color_warn: "var(--sw-room-card-warn)"    # Warning colour override
```

**Examples**

Bike charging status:
```yaml
- type: custom
  label: "Fahrrad"
  content:
    - entity: sensor.bike_battery_level
      display: value
    - entity: binary_sensor.bike_battery_charging
      display: dot
      color_on: "var(--sw-room-card-ok)"
      pulse: true           # Pulses while actively charging
```

CO₂ sensor with warning:
```yaml
- type: custom
  label: "CO₂"
  content:
    - entity: sensor.office_co2
      display: value
      warn_above: 1000
```

Occupancy & Motion:
```yaml
- type: custom
  label: "Presence"
  content:
    - entity: binary_sensor.living_room_occupancy
      display: dot
      color_on: "var(--sw-room-card-color)"
    - entity: binary_sensor.living_room_motion
      display: dot
      pulse: true
```

Climate & Appliances:
```yaml
- type: custom
  label: "Climate"
  content:
    - entity: sensor.living_room_humidity
      display: value
      warn_above: 60
    - entity: switch.dehumidifier
      display: dot
      color_on: "var(--sw-room-card-color-2)"
      pulse: true
```

---

### Theming

The card uses HA's standard CSS variables by default, so it works correctly with any theme without configuration.

All colours are exposed as `--sw-room-card-*` custom properties on `:host` for per-card overrides.

| Property | Default | Purpose |
|---|---|---|
| `--sw-room-card-color` | `--primary-color` | Accent — graph, active dots, icon |
| `--sw-room-card-color-2` | `--info-color` | Secondary accent — open window dots |
| `--sw-room-card-ok` | `--success-color` | Success / charged state |
| `--sw-room-card-warn` | `--warning-color` | Warning threshold values |
| `--sw-room-card-error` | `--error-color` | Error states |
| `--sw-room-card-text` | `--primary-text-color` | Name, temperature |
| `--sw-room-card-text-secondary` | `--secondary-text-color` | Value text in rows |
| `--sw-room-card-text-disabled` | `--disabled-text-color` | Floor label, row labels |
| `--sw-room-card-inactive` | `--divider-color` | Inactive / off dot colour |
| `--sw-room-card-font` | `--primary-font-family` | All text |
| `--sw-room-card-height` | `240px` | Card height |
| `--sw-room-card-graph-height` | `60px` | Height of the temperature graph |
| `--sw-room-card-graph-width` | `1px` | Stroke width of the graph line |

Override any of these per card using the built-in `styles` key:

```yaml
type: custom:sw-room-card
area: living_room
styles:
  color: "#c9a96e"
  font: "'Cormorant Garamond', serif"
  height: "260px"
```

Short keys (e.g. `color`) are automatically expanded to `--sw-room-card-color`. You can also pass the full property name:

```yaml
styles:
  --sw-room-card-color: "#c9a96e"
```
---

### Auto-discovery details

When `area` is set, the card reads from the HA entity and device registries at runtime.

| Field | Logic |
|---|---|
| `name` | `area.name` |
| `floor` | `hass.floors[area.floor_id].name` |
| `icon` | `area.icon` |
| `temp_entity` | First `sensor.*` with `device_class: temperature` in area → first `climate.*` → none |
| `rows: lights` entities | All `light.*` entities whose `area_id` matches (direct or via device) |
| `rows: windows` entities | All `binary_sensor.*` with `device_class` of `window`, `door`, or `garage_door` |

Any field can be overridden manually. Auto-discovery results in nothing being shown (not an error) when no matching entity is found.

---

### History cache

History data is fetched via the HA WebSocket API (`history/history_during_period`) and cached per entity+duration for **5 minutes**. The cache is shared across all instances of the card on the same page, so multiple cards using the same entity incur only one fetch.

---

## 2. SW Tab Card

A clean and flexible tab container card that lets you define reusable cards and switch between them without reloading state.

<p align="center">
  <img src="docs/tab-pills.gif" alt="Tab Card Demo" width="49%">
</p>

```yaml
type: custom:sw-tab-card
tabs:
  - label: "Overview"
    icon: mdi:home
    cards: ["living_room", "kitchen"]
  - label: "Climate"
    icon: mdi:thermometer
    cards: ["thermostat"]
cards:
  living_room:
    type: custom:sw-room-card
    area: living_room
  kitchen:
    type: custom:sw-room-card
    area: kitchen
  thermostat:
    type: thermostat
    entity: climate.living_room
```

### Options

| Key | Type | Description |
|---|---|---|
| `tabs` | list | List of tab definitions. See below. |
| `cards` | object | Key-value map of card definitions (reusable by name). |
| `title` | string | Optional title shown next to the tabs. |
| `title_align` | string | `left` (default), `center`, or `right`. Alignment of the title. |
| `tab_align` | string | `left` (default), `center`, or `right`. Alignment of the tabs. |
| `tab_style` | string | `pills` (default), `underline`, or `dropdown`. |
| `columns` | number / string | Number of fixed columns for cards, or `'auto'` (default). |
| `min_column_width` | number | Minimum card width for auto grid in pixels. Default `180`. |
| `styles` | object | Per-card CSS overrides (e.g., `accent`, `radius`, `font-size`, `title-size`). Expanded to `--sw-tab-<key>`. |

### Tab Definition (`tabs`)

| Key | Type | Description |
|---|---|---|
| `label` | string | Optional text shown on the tab. |
| `icon` | string | Optional MDI icon (e.g., `mdi:home`). |
| `cards` | list | List of card keys from `cards` object to render when active. |

### Theming (`styles`)

The `styles` key lets you easily override the internal CSS variables of the tab selector without using `card_mod`:

```yaml
type: custom:sw-tab-card
styles:
  accent: "#c9a96e"      # Active tab background/color
  radius: "12px"         # Border radius for pills
  font-size: "14px"      # Tab text size
tabs:
  # ...
```
Short keys are automatically expanded to `--sw-tab-<key>`.

### Examples

**Title and Dropdown Style**

<p align="center">
  <img src="docs/tab-dropdown.png" alt="Tab Card dropdown config" width="49%">
</p>

```yaml
type: custom:sw-tab-card
title: "Ground Floor"
title_align: left
tab_style: dropdown
tabs:
  - label: "Living Room"
    icon: mdi:sofa
    cards: ["living_room"]
  - label: "Kitchen"
    icon: mdi:fridge
    cards: ["kitchen"]
cards:
  # ... card definitions ...
```

**Underline Style (Centered)**

<p align="center">
  <img src="docs/tab-underline.png" alt="Tab Card underline centered config" width="49%">
</p>

```yaml
type: custom:sw-tab-card
tab_style: underline
tab_align: center
tabs:
  - label: "Status"
  - label: "Settings"
cards:
  # ... card definitions ...
```

---

## 3. SW Climate Card

A compact horizontal card designed for room popups. It shows the current temperature, humidity and an optional 24 h background wave graph. When a `climate_entity` is supplied, the right side renders a target-temperature stepper and HVAC mode pills. Rooms without a thermostat simply omit the controls — no extra configuration needed.

<p align="center">
  <img src="docs/climate-full.png" alt="Full Climate Card config" width="49%">
</p>

---

### Minimal config

**Sensor-only** (no thermostat — temperature + humidity + graph):

<p align="center">
  <img src="docs/climate-sensor-only.png" alt="Minimal Climate Card config" width="49%">
</p>

```yaml
type: custom:sw-climate-card
temp_entity: sensor.living_room_temperature
humidity_entity: sensor.living_room_humidity
```

**With thermostat** (adds stepper and mode pills on the right):

<p align="center">
  <img src="docs/climate-default.png" alt="Climate Card config" width="49%">
</p>

```yaml
type: custom:sw-climate-card
climate_entity: climate.living_room
temp_entity: sensor.living_room_temperature
humidity_entity: sensor.living_room_humidity
```

**Climate entity only** (no dedicated sensors — temperature, humidity and graph all derived from `climate_entity` attributes):

```yaml
type: custom:sw-climate-card
climate_entity: climate.living_room
```

---

### Full config reference

```yaml
type: custom:sw-climate-card

# ── Labels ────────────────────────────────────────────────────
title: "Living Room"       # Optional title shown top-left in uppercase.
                           # Intended for standalone use; omit inside a
                           # Bubble popup that already shows the room name.

# ── Entities ─────────────────────────────────────────────────
climate_entity: climate.living_room
                           # Optional. Required for thermostat controls
                           # (stepper + mode pills).
                           # Also used as fallback for temp / humidity
                           # values via current_temperature /
                           # current_humidity attributes.
temp_entity: sensor.living_room_temperature
                           # Optional. Shown as the main temperature value
                           # (left side). Also drives the history graph.
                           # Fallback: climate_entity.current_temperature.
humidity_entity: sensor.living_room_humidity
                           # Optional. Shown smaller next to the temperature.
                           # Fallback: climate_entity.current_humidity.
hours_to_show: 24          # Hours of history for the background graph.
                           # Default: 24.

# ── Mode filter ───────────────────────────────────────────────
modes: [off, heat, auto]   # Optional. Restrict mode pills to this subset
                           # of entity.hvac_modes. If omitted, all modes
                           # reported by the entity are shown.
mode_icons:                # Optional. Override the icon for any mode.
  heat: mdi:fire           # Defaults are listed in the Theming section.
  off: mdi:power
  auto: mdi:autorenew

# ── Visibility ────────────────────────────────────────────────
show:
  graph: true              # Background wave graph. Default: true.
  humidity: true           # Humidity value. Default: true.
  controls: false          # Force controls visible even when no
                           # climate_entity is configured (rendered
                           # greyed out). Default: false.

# ── Interactions ──────────────────────────────────────────────
hold_action:               # Action fired after holding the card for ~500 ms.
  action: none             # Default: none. Supported actions:
                           #   none | more-info | navigate | url |
                           #   toggle | call-service
  entity: climate.x        # Entity for more-info / toggle (defaults to
                           # climate_entity when not set)
  navigation_path: /lovelace/room
  url_path: https://...
  service: light.turn_on
  service_data: {}

# ── Theming ───────────────────────────────────────────────────
styles:                    # Per-card CSS variable overrides. Short keys
  color: "#c9a96e"         # expand to --sw-climate-<key> automatically.
  height: "140px"
```

---

### Data resolution

The card resolves display values in this order:

| Value | Source (in order) |
|---|---|
| Temperature display | `temp_entity.state` → `climate_entity.attributes.current_temperature` → hidden |
| Humidity display | `humidity_entity.state` → `climate_entity.attributes.current_humidity` → hidden |
| Target temperature | `climate_entity.attributes.temperature` |
| Current mode | `climate_entity.state` |
| History graph | `temp_entity` sensor history → `climate_entity.attributes.current_temperature` history (attribute-based fetch) → no graph |

---

### HeatControl (thermostat controls)

The right side of the card renders when a `climate_entity` is set (or `show.controls: true`).

#### Target temperature stepper

```
◀  21.5°  ▶
```

- Step: **0.5 °** per tap.
- Clamped to `min_temp` / `max_temp` from the entity attributes.
- Tap an arrow → calls `climate.set_temperature` and shows the new value immediately (optimistic update). The display returns to the entity value once HA confirms the change.
- Tap the temperature value itself → opens the `more-info` dialog for `climate_entity`.
- Stepper and temperature are dimmed when mode is `off`.

#### Mode pills

One compact icon button per available HVAC mode. The active mode is highlighted with the accent colour.

Default icons (all overridable via `mode_icons:`):

| Mode | Default icon |
|---|---|
| `off` | `mdi:power` |
| `heat` | `mdi:fire` |
| `cool` | `mdi:snowflake` |
| `auto` | `mdi:autorenew` |
| `heat_cool` | `mdi:autorenew` |
| `dry` | `mdi:water-percent` |
| `fan_only` | `mdi:fan` |

Tap a pill → calls `climate.set_hvac_mode`.

---

### Usage in a room popup

The intended placement is as the second card inside a Bubble Card popup, directly below the popup header:

```yaml
- type: vertical-stack
  cards:
    - <<: *popup_room
      name: Living Room
      icon: mdi:sofa
      hash: "#room-living_room"
    - type: custom:sw-climate-card
      climate_entity: climate.living_room
      temp_entity: sensor.living_room_temperature
      humidity_entity: sensor.living_room_humidity
    # … scene strip, sw-tab-card with lights/sensors, …
```

Rooms **without** a controllable thermostat (e.g. kitchen, basement) simply omit `climate_entity`:

```yaml
- type: custom:sw-climate-card
  temp_entity: sensor.kitchen_temperature
  humidity_entity: sensor.kitchen_humidity
```

No `show:` toggles needed — the controls section is automatically hidden.

---

### Theming

All colours are exposed as `--sw-climate-*` custom properties on `:host` for per-card overrides. HA theme variables are used as defaults, so no configuration is required with any standard theme.

| Property | Default | Purpose |
|---|---|---|
| `--sw-climate-color` | `--primary-color` | Accent — active mode pill background, graph fill |
| `--sw-climate-active-text` | `--text-primary-color` | Text/icon colour on the active mode pill (contrasts with `--sw-climate-color`) |
| `--sw-climate-text` | `--primary-text-color` | Main temperature value |
| `--sw-climate-text-secondary` | `--secondary-text-color` | Humidity, target temperature, stepper arrows |
| `--sw-climate-text-disabled` | `--disabled-text-color` | Inactive mode pills, title label |
| `--sw-climate-border` | `--divider-color` | Mode pill border |
| `--sw-climate-font` | `--primary-font-family` | All text |
| `--sw-climate-height` | `120px` | Card height |
| `--sw-climate-graph-height` | `100%` | Height of the background graph (fills the full card) |
| `--sw-climate-graph-width` | `0px` | Graph stroke width — `0px` means fill only, no line |

Override any of these per card using the `styles` key:

```yaml
type: custom:sw-climate-card
climate_entity: climate.living_room
styles:
  color: "#c9a96e"
  height: "140px"
  graph-width: "0.5px"   # thin stroke on top of the fill
```

Short keys (e.g. `color`) are automatically expanded to `--sw-climate-color`. Full property names are passed through as-is:

```yaml
styles:
  --sw-climate-color: "#c9a96e"
```
