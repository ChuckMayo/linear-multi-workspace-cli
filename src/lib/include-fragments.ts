/**
 * `--include` fragment map for Phase 3 RAW-04.
 *
 * Maps each Tier-1 command name to a record of include-key → inline GraphQL
 * fragment text. The fragment text is inlined directly into the composed
 * query string inside the `nodes { ... }` selection set.
 *
 * Security: include keys are validated by exact-match lookup against this
 * map (T-03-04-INCLUDE-INJECTION). Unknown keys → INVALID_INCLUDE BEFORE
 * any string concat. Fragment text is hand-authored, NOT user-supplied.
 *
 * Single-round-trip guarantee (T-03-04-N-PLUS-1): agents requesting
 * `issue list --include comments` get one composed rawRequest call instead
 * of 1+N separate SDK calls.
 */
import { LinearAgentError } from '../core/errors/index.js'

export const INCLUDE_FRAGMENT_MAP = {
  'issue list': {
    comments: 'comments(first: 50) { nodes { id body createdAt user { id name } } }',
    labels: 'labels(first: 50) { nodes { id name color } }',
    attachments: 'attachments(first: 25) { nodes { id title url } }',
    subscribers: 'subscribers(first: 50) { nodes { id name } }',
    history: 'history(first: 50) { nodes { id createdAt actor { id name } } }',
  },
  'issue get': {
    comments: 'comments(first: 50) { nodes { id body createdAt user { id name } } }',
    labels: 'labels(first: 50) { nodes { id name color } }',
    attachments: 'attachments(first: 25) { nodes { id title url } }',
    subscribers: 'subscribers(first: 50) { nodes { id name } }',
    history: 'history(first: 50) { nodes { id createdAt actor { id name } } }',
  },
  'comment list': {
    reactions: 'reactions { id emoji }',
    parent: 'parent { id body }',
  },
  'project get': {
    members: 'members(first: 50) { nodes { id name email } }',
    teams: 'teams(first: 25) { nodes { id key name } }',
    projectMilestones: 'projectMilestones(first: 50) { nodes { id name targetDate } }',
    documents: 'documents(first: 25) { nodes { id title } }',
  },
  'cycle list': {
    issues: 'issues(first: 50) { nodes { id identifier title } }',
  },
} as const

export type CommandName = keyof typeof INCLUDE_FRAGMENT_MAP

/**
 * Validates every requested include key against the command's allowed map.
 * Returns concatenated fragment text (each fragment joined with newline +
 * 6-space indent to fit inside the typical `nodes { ... }` indentation).
 *
 * Returns '' when requested is empty (runtimes branch on empty BEFORE calling).
 *
 * Throws LinearAgentError with code 'INVALID_INCLUDE' (exit 2) and
 * details.allowed (sorted alphabetically) + details.unknown on any miss.
 * The error is thrown BEFORE any string concat — unknown keys never reach
 * the composed query string (T-03-04-INCLUDE-INJECTION mitigation).
 */
export function validateAndMergeIncludes(commandName: CommandName, requested: string[]): string {
  if (requested.length === 0) return ''

  const allowed = INCLUDE_FRAGMENT_MAP[commandName]
  const allowedKeys = Object.keys(allowed).sort()
  const unknown = requested.filter((k) => !(k in allowed))

  if (unknown.length > 0) {
    throw new LinearAgentError({
      code: 'INVALID_INCLUDE',
      message: `unknown --include keys for ${commandName}: ${unknown.join(', ')}`,
      details: { unknown, allowed: allowedKeys },
    })
  }

  return requested.map((k) => allowed[k as keyof typeof allowed]).join('\n      ')
}
