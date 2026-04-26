# SW Room Card

An elegant, area-aware room overview card for Home Assistant.

- Auto-discovers entities from a Home Assistant area (lights, window sensors, temperature)
- Derives floor label and icon from the area automatically
- Renders a 24 h temperature graph from history data
- Flexible `rows` system for status indicators — no hardcoded entity types
- Works with any HA theme; all colours are overridable per card

---

## Installation

### HACS (recommended)

Add this repository as a custom repository in HACS (type: **Lovelace**), then install *Lovelace Sweetwater Cards*.

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=h4llow3En&repository=lovelace-sweetwater-cards&category=plugin)


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

## Minimal config
![Minimal config](docs/minimal-config.png)

```yaml
type: custom:sw-room-card
area: living_room
```

With only `area` set, the card auto-discovers the room name, floor, icon, and temperature sensor. If none are found, those sections are simply omitted.

---

## Full config reference

![Full config](docs/full-config.png)

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

## Row types

### `lights`

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

### `windows`

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

### `custom`

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

## Theming

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

## Auto-discovery details

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

## History cache

History data is fetched via the HA WebSocket API (`history/history_during_period`) and cached per entity+duration for **5 minutes**. The cache is shared across all instances of the card on the same page, so multiple cards using the same entity incur only one fetch.
