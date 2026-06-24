/**
 * Introspection registry — Phase 4 PLAN 04-01 spine.
 *
 * Exports:
 *   - `CURATED_REGISTRY` — hand-curated list of all 36 curated commands,
 *     sorted alphabetically by id. Snapshot-pinned in CI (INT-04).
 *   - `CuratedEntry`, `CommandExample`, `RawCommandEntry` — interfaces
 *   - `getRawRegistryView()` — flattened view over OPERATION_REGISTRY for raw introspection
 *
 * InputSchema stubs: all entries use `z.object({})` here. Phase 4 plan 04-03
 * (describe-runtime.ts) replaces stubs with per-command `*InputSchema` exports.
 * The stubs are acceptable because:
 *   1. list-tools only uses `flags[]` names, not the schema object
 *   2. introspection-registry.test.ts verifies structural integrity, not schema contents
 *   3. describe-runtime.ts (04-03) wires real schemas via per-command exports
 */
import { z } from 'zod'
import { OPERATION_REGISTRY } from '@/generated/operations.js'

export interface CommandExample {
  name: string
  args: string
  output: Record<string, unknown>
}

export interface CuratedEntry {
  id: string
  summary: string
  flags: string[]
  raw_equivalent?: string
  inputSchema: z.ZodTypeAny
  examples: CommandExample[]
}

export interface RawCommandEntry {
  name: string
  kind: 'query' | 'mutation'
}

// Total: 40 entries — update this comment when adding commands
export const CURATED_REGISTRY: CuratedEntry[] = [
  {
    id: 'comment create',
    summary: 'Create a new comment on a Linear issue.',
    flags: ['workspace', 'allow-active-workspace-write', 'fields', 'issue', 'body', 'parent'],
    raw_equivalent: 'CommentCreate',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'comment delete',
    summary: 'Delete a comment from a Linear issue.',
    flags: ['workspace', 'allow-active-workspace-write'],
    raw_equivalent: 'CommentDelete',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'comment list',
    summary: 'List comments on a Linear issue, with optional related-entity hydration.',
    flags: ['workspace', 'fields', 'issue', 'include'],
    raw_equivalent: 'Comments',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'comment update',
    summary: 'Update the body of an existing Linear comment.',
    flags: ['workspace', 'allow-active-workspace-write', 'fields', 'body'],
    raw_equivalent: 'CommentUpdate',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'cycle current',
    summary: 'Retrieve the currently active cycle for a team.',
    flags: ['workspace', 'fields', 'team'],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'cycle list',
    summary: 'List all cycles for a team, with optional issue hydration.',
    flags: ['workspace', 'fields', 'team', 'include'],
    raw_equivalent: 'Cycles',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'cycle move',
    summary: 'Move an issue into a specific cycle number for a team.',
    flags: ['workspace', 'allow-active-workspace-write', 'fields', 'to'],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'describe',
    summary: 'Return input/output JSON Schema and examples for a curated or raw command.',
    flags: ['pretty'],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'graphql',
    summary: 'Execute an arbitrary GraphQL query or mutation against Linear.',
    flags: ['workspace', 'allow-active-workspace-write', 'allow-mutations', 'query', 'vars'],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'install-skill',
    summary: 'Copy the bundled Claude Code skill to ~/.claude/skills/linmux/SKILL.md.',
    flags: ['pretty'],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'issue archive',
    summary: 'Archive a Linear issue (soft-delete; issue remains searchable).',
    flags: ['workspace', 'allow-active-workspace-write'],
    raw_equivalent: 'IssueArchive',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'issue create',
    summary:
      'Create a new Linear issue with optional title, description, assignee, team, and more.',
    flags: [
      'workspace',
      'allow-active-workspace-write',
      'fields',
      'title',
      'description',
      'team',
      'state',
      'assignee',
      'priority',
      'labels',
      'project',
      'cycle',
      'parent',
    ],
    raw_equivalent: 'IssueCreate',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'issue get',
    summary: 'Fetch a single Linear issue by identifier or UUID.',
    flags: ['workspace', 'fields', 'include'],
    raw_equivalent: 'Issue',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'issue list',
    summary: 'List Linear issues with --fields, --limit, --cursor, and Phase 1 filters.',
    flags: ['workspace', 'fields', 'limit', 'cursor', 'state', 'assignee', 'team', 'include'],
    raw_equivalent: 'Issues',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'issue purge',
    summary: 'Permanently delete a Linear issue (irreversible; requires --yes confirmation).',
    flags: ['workspace', 'allow-active-workspace-write', 'yes'],
    raw_equivalent: 'IssueDelete',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'issue search',
    summary:
      'Full-text search Linear issues with optional filters for state, team, assignee, label, project, and cycle.',
    flags: [
      'workspace',
      'fields',
      'state',
      'assignee',
      'team',
      'label',
      'project',
      'cycle',
      'no-snippet',
      'include-archived',
    ],
    raw_equivalent: 'IssueSearch',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'issue transition',
    summary: 'Transition a Linear issue to a new workflow state by name or ID.',
    flags: ['workspace', 'allow-active-workspace-write', 'fields'],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'issue trash',
    summary: 'Move a Linear issue to the trash (soft-delete; recoverable from UI).',
    flags: ['workspace', 'allow-active-workspace-write'],
    // No 1:1 raw equivalent — IssueArchive(trash: true) is the underlying call
    // but is not a standalone operation. raw_equivalent omitted per spec.
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'issue update',
    summary:
      'Update fields on an existing Linear issue (title, description, assignee, state, etc.).',
    flags: [
      'workspace',
      'allow-active-workspace-write',
      'fields',
      'title',
      'description',
      'state',
      'assignee',
      'priority',
      'labels',
      'project',
      'cycle',
    ],
    raw_equivalent: 'IssueUpdate',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'label create',
    summary: 'Create a new issue label in a Linear team.',
    flags: [
      'workspace',
      'allow-active-workspace-write',
      'fields',
      'name',
      'team',
      'color',
      'description',
    ],
    raw_equivalent: 'IssueLabelCreate',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'label list',
    summary: 'List issue labels for a Linear team or the entire workspace.',
    flags: ['workspace', 'fields', 'team'],
    raw_equivalent: 'IssueLabels',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'list-tools',
    summary: 'Enumerate every curated and raw command with curated→raw mappings.',
    flags: ['pretty'],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'me',
    summary: 'Return the authenticated user and organization details.',
    flags: ['workspace', 'fields'],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'project create',
    summary:
      'Create a new Linear project with optional name, description, teams, state, and dates.',
    flags: [
      'workspace',
      'allow-active-workspace-write',
      'fields',
      'name',
      'teams',
      'description',
      'state',
      'lead',
      'start-date',
      'target-date',
    ],
    raw_equivalent: 'ProjectCreate',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'project get',
    summary: 'Fetch a single Linear project by ID or name.',
    flags: ['workspace', 'fields', 'include'],
    raw_equivalent: 'Project',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'project list',
    summary: 'List all Linear projects in the workspace.',
    flags: ['workspace', 'fields'],
    raw_equivalent: 'Projects',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'project update',
    summary: 'Update fields on an existing Linear project (name, description, state).',
    flags: ['workspace', 'allow-active-workspace-write', 'fields', 'name', 'description', 'state'],
    raw_equivalent: 'ProjectUpdate',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'project update-status',
    summary: "Set a Linear project's current status (e.g. 'On Track' -> 'At Risk').",
    flags: ['workspace', 'allow-active-workspace-write', 'fields'],
    raw_equivalent: 'ProjectUpdate',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'raw',
    summary: 'Execute any operation from the full Linear GraphQL registry by PascalCase name.',
    flags: ['workspace', 'allow-active-workspace-write', 'allow-mutations', 'vars'],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'raw batch',
    summary: 'Execute a batch of raw Linear GraphQL operations from a plan file.',
    flags: [
      'workspace',
      'allow-active-workspace-write',
      'allow-mutations',
      'plan',
      'dry-run',
      'yes',
    ],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'schema',
    summary: 'Return the Linear GraphQL schema as compact SDL or introspection JSON.',
    flags: ['pretty', 'full', 'json'],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'state list',
    summary: 'List workflow states for a Linear team.',
    flags: ['workspace', 'fields', 'team'],
    raw_equivalent: 'WorkflowStates',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'team get',
    summary: 'Fetch details for a single Linear team by key, name, or ID.',
    flags: ['workspace', 'fields'],
    raw_equivalent: 'Team',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'team list',
    summary: 'List all Linear teams in the workspace.',
    flags: ['workspace', 'fields'],
    raw_equivalent: 'Teams',
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'whoami',
    summary: 'Alias for `me` — return the authenticated user and organization details.',
    flags: ['workspace', 'fields'],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'workspace add',
    summary: 'Add a new Linear workspace to the local config with a personal API token.',
    flags: ['token'],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'workspace list',
    summary: 'List all configured Linear workspaces in the local config.',
    flags: [],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'workspace remove',
    summary: 'Remove a Linear workspace from the local config.',
    flags: [],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'workspace replace-token',
    summary: 'Replace the API token for an existing workspace in the local config.',
    flags: ['token'],
    inputSchema: z.object({}),
    examples: [],
  },
  {
    id: 'workspace use',
    summary: 'Set the active default workspace used when no --workspace flag is provided.',
    flags: [],
    inputSchema: z.object({}),
    examples: [],
  },
]

/**
 * Convenience view over OPERATION_REGISTRY for introspection commands.
 * Returns all operations with their name and kind (query | mutation).
 */
export function getRawRegistryView(): RawCommandEntry[] {
  return Object.entries(OPERATION_REGISTRY).map(([name, entry]) => ({
    name,
    kind: entry.kind,
  }))
}
