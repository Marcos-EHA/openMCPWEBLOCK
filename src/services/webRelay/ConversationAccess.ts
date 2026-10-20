export interface ConversationOwner {
  instanceId: string
  operation: string
  startedAt: number
}

export class ConversationBusyError extends Error {
  readonly code = 'CONVERSATION_BUSY'
  constructor(readonly resource: string, readonly owner: ConversationOwner) {
    super(`La instancia ${owner.instanceId} está ocupada (${owner.operation}). Espera a que termine antes de enviar otra tarea.`)
    this.name = 'ConversationBusyError'
  }
}

/** Process-local exclusion. Does not retry requests or cancel browser-side work. */
export class ConversationAccess {
  private readonly owners = new Map<string, ConversationOwner>()

  getOwner(resource: string): ConversationOwner | undefined {
    const owner = this.owners.get(resource)
    return owner ? { ...owner } : undefined
  }

  async run<T>(
    resources: string[],
    owner: Omit<ConversationOwner, 'startedAt'>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(resources)]
    if (!keys.length || keys.some(key => !key.trim())) {
      throw new Error('Conversation access requires non-empty resource identities.')
    }
    for (const key of keys) {
      const existing = this.owners.get(key)
      if (existing) throw new ConversationBusyError(key, { ...existing })
    }
    const reservation = { ...owner, startedAt: Date.now() }
    // Reserve all resources synchronously before the operation can yield.
    for (const key of keys) this.owners.set(key, reservation)
    try {
      return await operation()
    } finally {
      for (const key of keys) {
        if (this.owners.get(key) === reservation) this.owners.delete(key)
      }
    }
  }
}

export function browserConversationResource(debugPort: number): string {
  if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
    throw new Error('A valid browser debug port is required for conversation access.')
  }
  // Master and Relay aliases sharing one browser must share the reservation.
  return `browser:127.0.0.1:${debugPort}`
}

export const conversationAccess = new ConversationAccess()
