import type { Command } from '../../commands.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'mode',
    description: 'Switch connection mode (Web/API/Local) and select AI platform',
    isEnabled: () => true,
    load: () => import('./mode.js'),
  }) satisfies Command
