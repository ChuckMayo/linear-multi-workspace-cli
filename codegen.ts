/**
 * @graphql-codegen/cli configuration.
 *
 * - schema: ./schema.graphql (vendored, deterministic — see codegen/fetch-schema.ts)
 * - preset: client (2026-recommended client-preset; emits TypedDocumentNode-aware types)
 * - output: ./src/generated/ (committed to git for offline-reproducible builds)
 *
 * Phase 3 PLAN 03-01 Task 2 populates `src/operations/_registry.graphql`
 * via `npm run build-operations`, so `ignoreNoDocuments` is now `false` —
 * if the builder ever fails to emit documents, codegen exits non-zero and
 * CI catches the regression instead of silently producing an empty
 * `src/generated/gql.ts`.
 */

import type { CodegenConfig } from '@graphql-codegen/cli'

const config: CodegenConfig = {
  schema: './schema.graphql',
  documents: ['src/operations/**/*.graphql', 'src/operations/**/*.ts'],
  ignoreNoDocuments: false,
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
