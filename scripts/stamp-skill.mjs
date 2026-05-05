#!/usr/bin/env node
/**
 * stamp-skill.mjs — Pack-time stamper for the Claude Code skill bundle.
 *
 * Reads the checked-in template `skills/linear-agent/SKILL.md.tmpl`, replaces
 * every `{{VERSION}}` literal with `package.json#version`, and writes the
 * result to `skills/linear-agent/SKILL.md`. The stamped output is gitignored
 * and only ever exists during `npm pack` (between `prepack` and `postpack`).
 *
 * Why a stamp instead of a hardcoded version: hardcoding would force a commit
 * on every `npm version` bump, churning the repo. Stamping keeps the .tmpl as
 * the single source of truth and the stamped output as a build artifact.
 *
 * Invariants (DST-05):
 *   - Output uses the EXACT version from package.json — never `@latest`.
 *   - The script accepts no flags, accepts no env vars, accepts no user input;
 *     output path is hardcoded under cwd to prevent path-traversal.
 *   - Script reads files only; never spawns subprocesses (no exec/execSync).
 *
 * Failure modes (all exit 1 with a stderr message):
 *   - Template missing at expected path
 *   - package.json missing or unparseable
 *   - package.json has no `version` field
 *   - Template lacks any `{{VERSION}}` placeholder (sanity guard against an
 *     accidental edit that drops the token)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const TEMPLATE_REL = 'skills/linear-agent/SKILL.md.tmpl'
const OUTPUT_REL = 'skills/linear-agent/SKILL.md'
const PACKAGE_JSON_REL = 'package.json'
const PLACEHOLDER = '{{VERSION}}'

function fail(message) {
  process.stderr.write(`stamp-skill: ${message}\n`)
  process.exit(1)
}

function readPackageVersion(cwd) {
  const path = resolve(cwd, PACKAGE_JSON_REL)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    fail(`could not read package.json at ${path}: ${err.message ?? err}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    fail(`package.json at ${path} is not valid JSON: ${err.message ?? err}`)
  }
  const version = parsed?.version
  if (typeof version !== 'string' || version.length === 0) {
    fail(`package.json at ${path} has no string "version" field`)
  }
  return version
}

function readTemplate(cwd) {
  const path = resolve(cwd, TEMPLATE_REL)
  try {
    return { path, body: readFileSync(path, 'utf8') }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      fail(`template missing at ${path}`)
    }
    fail(`could not read template at ${path}: ${err.message ?? err}`)
  }
}

function main() {
  const cwd = process.cwd()
  const version = readPackageVersion(cwd)
  const { path: templatePath, body: template } = readTemplate(cwd)

  if (!template.includes(PLACEHOLDER)) {
    fail(
      `template at ${templatePath} contains no ${PLACEHOLDER} placeholder; refusing to stamp`,
    )
  }

  const stamped = template.replaceAll(PLACEHOLDER, version)
  const outputPath = resolve(cwd, OUTPUT_REL)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, stamped, 'utf8')

  const bytes = Buffer.byteLength(stamped, 'utf8')
  process.stdout.write(
    `✓ stamped ${OUTPUT_REL} (version ${version}, ${bytes} bytes)\n`,
  )
  process.exit(0)
}

main()
