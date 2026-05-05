/**
 * Type declarations for `scripts/verify-pack.mjs`. The script is authored as
 * plain ESM (no TS compile step in `scripts/`), but `test/pack.test.ts`
 * imports the pure-logic helpers directly. NodeNext resolution picks up
 * this `.d.mts` sibling.
 */

export interface PackFile {
  path: string
  size?: number
  mode?: number
}

export interface PackInfo {
  unpackedSize?: number
  size?: number
  files?: PackFile[]
}

export interface PackagePackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export const REQUIRED_PREFIXES: readonly string[]
export const FORBIDDEN_PATTERNS: readonly RegExp[]
export const REQUIRED_RUNTIME_DEPS: readonly string[]
export const FORBIDDEN_RUNTIME_DEPS: readonly string[]
export const SIZE_BUDGET_BYTES: number

export function findViolations(input: {
  pkg: PackInfo
  packageJson: PackagePackageJson
}): string[]

export function topNLargest(files: PackFile[], n?: number): PackFile[]
