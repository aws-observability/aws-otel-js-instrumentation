// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { InstrumentationConfiguration, computeRegistryKey } from '../model/instrumentation-configuration';
import { InstrumentationState } from '../model/instrumentation-state';

interface RegistryEntry {
  config: InstrumentationConfiguration;
  state: InstrumentationState;
}

/**
 * Registry for PROBE and BREAKPOINT instrumentation configurations.
 *
 * Keyed by internal registry key (resolvedFilePath:methodName:lineNumber).
 * Last writer wins — if two configs target the same key, the later one overwrites.
 *
 * State (hit counts) is preserved for unchanged configs across polling cycles.
 */
export class InstrumentationRegistry {
  private readonly entries: Map<string, RegistryEntry> = new Map();

  /**
   * Register a configuration. Preserves existing state if the config at this key
   * has the same locationHash and createdAt (i.e., the config hasn't been recreated).
   */
  register(config: InstrumentationConfiguration): void {
    const key = computeRegistryKey(config);
    const existing = this.entries.get(key);

    // Preserve state if both locationHash and createdAt match (config unchanged)
    if (
      existing &&
      existing.config.locationHash === config.locationHash &&
      existing.config.createdAt === config.createdAt
    ) {
      existing.config = config;
      return;
    }

    // New or changed config — create new state
    const state = new InstrumentationState(
      config.locationHash,
      config.maxHits,
      config.expiresAt,
      config.instrumentationType
    );

    this.entries.set(key, { config, state });
  }

  unregister(key: string): RegistryEntry | undefined {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return entry;
  }

  get(key: string): RegistryEntry | undefined {
    return this.entries.get(key);
  }

  getByLocationHash(locationHash: string): RegistryEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.config.locationHash === locationHash) return entry;
    }
    return undefined;
  }

  /**
   * Mark a config as installed (V8 breakpoint confirmed set).
   */
  markInstalled(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.state.installed = true;
    }
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  getAll(): RegistryEntry[] {
    return Array.from(this.entries.values());
  }

  getAllKeys(): Set<string> {
    return new Set(this.entries.keys());
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * Compute diff between current registry state and new configurations.
   * Returns keys to add, remove, and those that are unchanged.
   */
  computeDiff(newConfigs: InstrumentationConfiguration[]): {
    toAdd: InstrumentationConfiguration[];
    toRemove: string[];
    unchanged: string[];
  } {
    const newKeyMap = new Map<string, InstrumentationConfiguration>();
    for (const config of newConfigs) {
      const key = computeRegistryKey(config);
      newKeyMap.set(key, config);
    }

    const currentKeys = this.getAllKeys();
    const newKeys = new Set(newKeyMap.keys());

    const toRemove: string[] = [];
    const unchanged: string[] = [];
    const toAdd: InstrumentationConfiguration[] = [];

    // Find removed keys
    for (const key of currentKeys) {
      if (!newKeys.has(key)) {
        toRemove.push(key);
      }
    }

    // Find added and unchanged
    for (const [key, config] of newKeyMap) {
      const existing = this.entries.get(key);
      if (!existing) {
        toAdd.push(config);
      } else if (
        existing.config.locationHash === config.locationHash &&
        existing.config.createdAt === config.createdAt
      ) {
        unchanged.push(key);
      } else {
        // Same key, different locationHash or createdAt — config changed (delete + recreate)
        toRemove.push(key);
        toAdd.push(config);
      }
    }

    return { toAdd, toRemove, unchanged };
  }
}
