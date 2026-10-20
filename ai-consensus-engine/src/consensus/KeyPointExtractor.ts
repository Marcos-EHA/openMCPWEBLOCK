/**
 * KeyPointExtractor
 * Extracts key points and claims from agent responses
 */

import type { KeyPoint, AgentResponse } from '../types/index.js';
import { TextComparison } from '../utils/TextComparison.js';

export class KeyPointExtractor {
  /**
   * Extract individual candidate key points/sentences from response text
   */
  extractSentences(text: string): string[] {
    return text
      .split(/(?<=[.?!])\s+|\n+/)
      .map(s => s.trim())
      .filter(s => s.length > 15);
  }

  /**
   * Extract key points and calculate agreement across multiple responses
   */
  extractKeyPoints(responses: AgentResponse[]): KeyPoint[] {
    if (responses.length === 0) return [];

    const keyPoints: KeyPoint[] = [];
    const allCandidates: { text: string; agentId: string }[] = [];

    for (const res of responses) {
      const sentences = this.extractSentences(res.content);
      for (const s of sentences) {
        allCandidates.push({ text: s, agentId: res.agentId });
      }
    }

    // Cluster similar sentences
    const visited = new Set<number>();
    let idCounter = 1;

    for (let i = 0; i < allCandidates.length; i++) {
      if (visited.has(i)) continue;
      visited.add(i);

      const base = allCandidates[i];
      const supporters = new Set<string>([base.agentId]);

      for (let j = i + 1; j < allCandidates.length; j++) {
        if (visited.has(j)) continue;
        const candidate = allCandidates[j];
        if (candidate.agentId === base.agentId) continue;

        const similarity = TextComparison.jaccardSimilarity(base.text, candidate.text);
        if (similarity >= 0.4) {
          visited.add(j);
          supporters.add(candidate.agentId);
        }
      }

      keyPoints.push({
        id: `kp-${idCounter++}`,
        text: base.text,
        supportedBy: Array.from(supporters),
        agreementRatio: supporters.size / responses.length,
      });
    }

    // Sort by agreementRatio descending
    return keyPoints.sort((a, b) => b.agreementRatio - a.agreementRatio);
  }
}
