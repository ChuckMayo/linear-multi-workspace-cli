/**
 * @graphql-codegen/cli configuration.
 *
 * - schema: ./schema.graphql (vendored, deterministic — see codegen/fetch-schema.ts)
 * - preset: client (2026-recommended client-preset; emits TypedDocumentNode-aware types)
 * - output: ./src/generated/ (committed to git for offline-reproducible builds)
 *
 * Phase 0 has zero `.graphql` operation documents in `src/operations/`, so
 * `ignoreNoDocuments: true` is required — without it, codegen exits non-zero
 * the first time. Phase 2/3 will populate `src/operations/`.
 */

import type { CodegenConfig } from '@graphql-codegen/cli'

const config: CodegenConfig = {
  schema: './schema.graphql',
  documents: ['src/operations/**/*.graphql', 'src/operations/**/*.ts'],
  ignoreNoDocuments: true,
  generates: {
    './src/generated/': {
      preset: 'client',
      presetConfig: {
        gqlTagName: 'gql',
      },
      config: {
        useTypeImports: true,
        skipTypename: false,
        // ESM-strict: tsconfig uses moduleResolution=NodeNext, which requires
        // explicit `.js` extensions in relative imports. Disabling the legacy
        // CJS import behavior makes client-preset emit `./graphql.js` instead
        // of `./graphql`.
        emitLegacyCommonJSImports: false,
        // Linear scalar mappings — derived from `grep "^scalar " schema.graphql`.
        // Notification-type scalars are tag types in Linear's schema; treat as string for now.
        scalars: {
          DateTime: 'string',
          DateTimeOrDuration: 'string',
          Duration: 'string',
          JSON: 'unknown',
          JSONObject: 'Record<string, unknown>',
          TimelessDate: 'string',
          TimelessDateOrDuration: 'string',
          UUID: 'string',
          IssueAssignedToYouNotificationType: 'string',
          IssueCommentMentionNotificationType: 'string',
          IssueCommentReactionNotificationType: 'string',
          IssueEmojiReactionNotificationType: 'string',
          IssueMentionNotificationType: 'string',
          IssueNewCommentNotificationType: 'string',
          IssueStatusChangedNotificationType: 'string',
          IssueUnassignedFromYouNotificationType: 'string',
        },
      },
    },
  },
  hooks: {
    // Biome ignores src/generated, so no formatter hook is needed.
    afterAllFileWrite: [],
  },
}

export default config
