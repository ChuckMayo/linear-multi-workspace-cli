import { Command } from '@oclif/core'

export default class Hello extends Command {
  static description = 'Placeholder command — proves oclif wiring. Removed in Phase 1.'
  static enableJsonFlag = true

  async run() {
    const result = { ok: true, scaffold: 'phase-0' }
    this.log(JSON.stringify(result))
    return result
  }
}
