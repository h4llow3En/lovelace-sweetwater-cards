export interface HassEntityState {
  state: string;
  attributes: Record<string, unknown>;
}

export interface AreaRegistryEntry {
  area_id: string;
  name: string;
  icon?: string;
  floor_id?: string;
}

export interface FloorRegistryEntry {
  floor_id: string;
  name: string;
}

export interface EntityRegistryEntry {
  entity_id: string;
  device_id?: string | null;
  area_id?: string | null;
}

export interface DeviceRegistryEntry {
  id: string;
  area_id?: string | null;
}

export interface HomeAssistant {
  states: Record<string, HassEntityState>;
  areas: Record<string, AreaRegistryEntry>;
  floors?: Record<string, FloorRegistryEntry>;
  entities: Record<string, EntityRegistryEntry>;
  devices: Record<string, DeviceRegistryEntry>;
  localize(key: string): string;
  callService(domain: string, service: string, data?: Record<string, unknown>): Promise<void>;
  callWS<T>(msg: Record<string, unknown>): Promise<T>;
}
