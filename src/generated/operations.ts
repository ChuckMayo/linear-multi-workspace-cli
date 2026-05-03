/**
 * src/generated/operations.ts — Phase 3 PLAN 03-01 Task 1 stub.
 *
 * Phase 3 codegen pipeline output: composes typed documents emitted by
 * graphql-codegen (from `src/operations/_registry.graphql`) with Zod
 * variable schemas (from `src/operations/_registry.zod.ts`) into a single
 * lookup table the `raw` / `raw batch` / `graphql` runtimes share.
 *
 * Task 1 ships an empty registry so the operation-registry tests can resolve
 * the `OPERATION_REGISTRY` import (typecheck green); Task 2 replaces this
 * file with the populated registry (~501 entries).
 *
 * DO NOT HAND-EDIT past Task 2 — `codegen/build-operations.ts` regenerates
 * this file on every `npm run codegen`.
 */

import type { TypedDocumentNode } from '@graphql-typed-document-node/core'
import type { z } from 'zod'

export type OperationKind = 'query' | 'mutation'

export interface OperationEntry<TResult = unknown, TVars = unknown> {
  kind: OperationKind
  /** TypedDocumentNode emitted by `@graphql-codegen/client-preset`. */
  document: TypedDocumentNode<TResult, TVars>
  /** Pre-printed canonical GraphQL source string handed to `client.client.rawRequest`. */
  source: string
  /** Zod schema validating `--vars` JSON before SDK dispatch. */
  varsSchema: z.ZodType<TVars>
}

export const OPERATION_REGISTRY = {} as const satisfies Record<string, OperationEntry>

export type OperationName = keyof typeof OPERATION_REGISTRY
