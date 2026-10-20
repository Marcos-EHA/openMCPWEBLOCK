import type { UserPreferences } from '../../../types/stores';

export type InstructionPrompts = {
  original: string;
  jsonl: string;
  claude: string;
  custom: string;
  agentDynamic: string;
};

export type InstructionPromptSource = 'original' | 'jsonl' | 'claude' | 'custom' | 'agent-dynamic';

export const selectInstructionPrompt = (
  variant: UserPreferences['promptVariant'],
  prompts: InstructionPrompts,
  imageSourceVariant: InstructionPromptSource = 'original',
): string => {
  const selectedSource = variant === 'guest-image' ? imageSourceVariant : variant;
  return selectedSource === 'agent-dynamic' ? prompts.agentDynamic : prompts[selectedSource];
};

export const selectActiveInstructionPrompt = (
  variant: UserPreferences['promptVariant'],
  prompts: InstructionPrompts,
  imageSourceVariant: InstructionPromptSource = 'original',
  agentPromptEnabled = false,
): string => agentPromptEnabled
  ? prompts.agentDynamic
  : selectInstructionPrompt(variant, prompts, imageSourceVariant);
