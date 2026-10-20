export function shouldRoutePromptToSentinel({
  sentinelMode,
  isLeader,
  isSubmittingSlashCommand,
  input,
}: {
  sentinelMode: boolean
  isLeader: boolean
  isSubmittingSlashCommand: boolean
  input: string
}): boolean {
  return (
    sentinelMode &&
    isLeader &&
    !isSubmittingSlashCommand &&
    !input.trimStart().startsWith('/')
  )
}

export function shouldRoutePromptToWebAgent({
  webAgentMode,
  isLeader,
  isSubmittingSlashCommand,
  input,
}: {
  webAgentMode: boolean
  isLeader: boolean
  isSubmittingSlashCommand: boolean
  input: string
}): boolean {
  return (
    webAgentMode &&
    isLeader &&
    !isSubmittingSlashCommand &&
    input.trim().length > 0 &&
    !input.trimStart().startsWith('/')
  )
}
