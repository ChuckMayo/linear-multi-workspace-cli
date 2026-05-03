/**
 * codegen/build-operations.ts — Phase 3 PLAN 03-01 Task 1 stub.
 *
 * Walks the vendored Linear schema (`schema.graphql`) and emits three
 * deterministic artifacts:
 *   1. `src/operations/_registry.graphql` — one default GraphQL operation per
 *      Query/Mutation root field (subscriptions excluded).
 *   2. `src/operations/_registry.zod.ts` — one Zod var-schema per operation
 *      keyed by PascalCase operation name.
 *   3. `src/generated/operations.ts` — the OPERATION_REGISTRY composition
 *      module that imports the typed documents (emitted by graphql-codegen
 *      from artifact #1) and the Zod schemas (artifact #2) and exports the
 *      `Record<string, OperationEntry>` consumers depend on.
 *
 * Wave 0 (this stub): the `buildRegistry` export exists with the documented
 * signature so the determinism test (`test/codegen/build-operations.test.ts`)
 * typechecks green. Calling `buildRegistry()` throws — Task 2 replaces this
 * file with the real walker.
 */

export interface BuildRegistryOptions {
  /** Absolute path to the vendored `schema.graphql`. */
  schemaPath: string
  /** Absolute path to the directory that receives `_registry.graphql` + `_registry.zod.ts`. */
  outDir: string
  /** Absolute path to the directory that receives `operations.ts`. Defaults to `<outDir>/../generated`. */
  generatedDir?: string
}

/** Idempotent. Writes _registry.graphql + _registry.zod.ts + operations.ts. */
export function buildRegistry(_opts: BuildRegistryOptions): void {
  throw new Error(
    'codegen/build-operations.ts: buildRegistry() is not implemented yet. ' +
      'This stub lands in Phase 3 PLAN 03-01 Task 1; Task 2 emits the real walker.',
  )
}

/**
 * Convenience entrypoint used by `npm run build-operations`. Task 1 ships
 * this as a no-op so the chained `npm run codegen` script keeps working
 * during the brief window before Task 2 ships the real walker. Task 2
 * replaces this with the real implementation that writes the three artifacts.
 */
export function main(): void {
  // Intentionally empty — Task 2 implementation arrives in the next commit.
}

// Allow direct invocation via `tsx codegen/build-operations.ts`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
