/**
 * Lazy module-level cached Linear schema loader.
 *
 * Only the `graphql` command pays the ~50–150ms `buildSchema` cost. The `raw`
 * and `raw batch` commands never import this module, so the cold-start budget
 * for the dominant use case remains unaffected (Phase 5 DST-03).
 *
 * The path resolver works from BOTH:
 *   - `dist/lib/schema-loader.js` (built CLI) → ../../schema.graphql
 *   - `src/lib/schema-loader.ts` (vitest) → ../../schema.graphql
 *
 * Both sit two levels under the repo root, so the relative path `../../schema.graphql`
 * resolves correctly in both contexts.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema, type GraphQLSchema } from 'graphql'

let cachedSchema: GraphQLSchema | undefined

/**
 * Returns the Linear GraphQLSchema, building it lazily on first call
 * and returning the cached instance on subsequent calls.
 */
export function getLinearSchema(): GraphQLSchema {
  if (cachedSchema) return cachedSchema
  const sdl = readFileSync(resolveSchemaPath(), 'utf8')
  cachedSchema = buildSchema(sdl)
  return cachedSchema
}

function resolveSchemaPath(): string {
  // From dist/lib/schema-loader.js (built) → ../../schema.graphql
  // From src/lib/schema-loader.ts (vitest) → ../../schema.graphql
  // Both paths work because dist/ mirrors src/ structure.
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', 'schema.graphql')
}

/**
 * Reset the module-level schema cache. For test isolation only — do not use
 * in production code.
 */
export function _resetSchemaCacheForTesting(): void {
  cachedSchema = undefined
}
