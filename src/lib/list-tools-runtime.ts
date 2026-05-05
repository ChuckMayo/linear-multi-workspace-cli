/**
 * list-tools runtime — Phase 4 PLAN 04-02, INT-01.
 *
 * Pure data assembly from CURATED_REGISTRY + OPERATION_REGISTRY. Zero network
 * calls, zero workspace resolution. All data originates from committed static
 * constants (threat T-04-02-S, T-04-02-T).
 *
 * Two-export pattern (S1): named `listToolsRuntime` export + default oclif class
 * lives in src/commands/list-tools.ts.
 */
import { CURATED_REGISTRY, getRawRegistryView } from '@/lib/introspection-registry.js'

export interface CuratedListEntry {
  id: string
  summary: string
  flags: string[]
  raw_equivalent?: string
}

export interface RawListEntry {
  name: string
  kind: 'query' | 'mutation'
}

export interface ListToolsData {
  curated: CuratedListEntry[]
  raw: RawListEntry[]
  counts: {
    curated: number
    raw: number
  }
}

export interface ListToolsArgs {
  flags: { pretty?: boolean }
}

export async function listToolsRuntime(_args: ListToolsArgs): Promise<{
  ok: true
  data: ListToolsData
  meta: { command: string }
}> {
  // Build curated list — preserve CURATED_REGISTRY alphabetical order
  const curated: CuratedListEntry[] = CURATED_REGISTRY.map((entry) => ({
    id: entry.id,
    summary: entry.summary,
    flags: entry.flags,
    ...(entry.raw_equivalent !== undefined ? { raw_equivalent: entry.raw_equivalent } : {}),
  }))

  // Build raw list — sort alphabetically by name
  const raw: RawListEntry[] = getRawRegistryView()
    .map((entry) => ({ name: entry.name, kind: entry.kind }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const data: ListToolsData = {
    curated,
    raw,
    counts: {
      curated: curated.length,
      raw: raw.length,
    },
  }

  return {
    ok: true,
    data,
    meta: { command: 'list-tools' },
  }
}
