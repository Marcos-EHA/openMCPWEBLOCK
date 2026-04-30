import { call, meta } from './consensus.js'

const consensus = {
  type: 'local-jsx',
  name: 'consensus',
  description: 'Run tasks on multiple web agents and generate consensus',
  immediate: true,
  argumentHint: '[run "task description" agent1,agent2,...] | help',
  load: () => import('./consensus.js'),
} satisfies import('../../commands.js').Command

export default consensus
