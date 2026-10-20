/**
 * ConsensusEngine
 * Central evaluator that compares responses, extracts key points, calculates confidence,
 * identifies divergences, and generates the final consensus result.
 */

import { SimilarityAnalyzer } from './SimilarityAnalyzer.js';
import { KeyPointExtractor } from './KeyPointExtractor.js';
import { ConfidenceCalculator } from './ConfidenceCalculator.js';
import type {
  AgentResponse,
  ConsensusResult,
  Divergence,
  KeyPoint,
  SimilarityScore,
} from '../types/index.js';

export class ConsensusEngine {
  private similarityAnalyzer = new SimilarityAnalyzer();
  private keyPointExtractor = new KeyPointExtractor();
  private confidenceCalculator = new ConfidenceCalculator();

  /**
   * Compare two responses
   */
  compareResponses(r1: string, r2: string): SimilarityScore {
    return this.similarityAnalyzer.compareResponses(r1, r2);
  }

  /**
   * Extract key points from responses
   */
  extractKeyPoints(responses: AgentResponse[]): KeyPoint[] {
    return this.keyPointExtractor.extractKeyPoints(responses);
  }

  /**
   * Calculate confidence across key points and agent count
   */
  calculateConfidence(keyPoints: KeyPoint[], agentCount: number): number {
    return this.confidenceCalculator.calculateConfidence(keyPoints, agentCount);
  }

  /**
   * Identify divergences where agents disagree or provide unique unconfirmed claims
   */
  identifyDivergences(keyPoints: KeyPoint[], responses: AgentResponse[]): Divergence[] {
    const divergences: Divergence[] = [];

    // Points with agreement ratio < 0.6 are marked as divergences
    for (const kp of keyPoints) {
      if (kp.agreementRatio < 0.6) {
        const opinions: Record<string, string> = {};
        for (const res of responses) {
          if (kp.supportedBy.includes(res.agentId)) {
            opinions[res.agentId] = `Mencionó o apoyó: "${kp.text.slice(0, 100)}..."`;
          } else {
            opinions[res.agentId] = 'No mencionó o no coincidió';
          }
        }

        divergences.push({
          topic: kp.text.slice(0, 80),
          opinions,
          significance: kp.agreementRatio <= 0.34 ? 'high' : 'medium',
        });
      }
    }

    return divergences;
  }

  /**
   * Merge responses into a synthesized consensus narrative
   */
  mergeResponses(responses: AgentResponse[], keyPoints: KeyPoint[]): string {
    const topPoints = keyPoints.filter(kp => kp.agreementRatio >= 0.5);
    if (topPoints.length === 0) {
      return responses.map(r => r.content).join('\n---\n');
    }

    const bulletList = topPoints.map(kp => `- ${kp.text} (${Math.round(kp.agreementRatio * 100)}% acuerdo)`).join('\n');
    return `Puntos consensuados principales:\n${bulletList}`;
  }

  /**
   * Generate full ConsensusResult from multiple agent responses
   */
  generateConsensus(responses: AgentResponse[]): ConsensusResult {
    if (responses.length === 0) {
      return {
        consensus: 'No responses received.',
        confidence: 0,
        keyPoints: [],
        agreement: {},
        divergences: [],
        responses: [],
        traceability: {},
        timestamp: Date.now(),
      };
    }

    const keyPoints = this.extractKeyPoints(responses);
    const confidence = this.calculateConfidence(keyPoints, responses.length);
    const divergences = this.identifyDivergences(keyPoints, responses);
    const consensusText = this.mergeResponses(responses, keyPoints);

    const agreement: Record<string, string> = {};
    for (const kp of keyPoints) {
      agreement[kp.id] = `${kp.supportedBy.length}/${responses.length} de acuerdo`;
    }

    const traceability: Record<string, string> = {};
    for (const r of responses) {
      traceability[r.agentId] = `[${r.platform}] ${r.content.slice(0, 120)}...`;
    }

    return {
      consensus: consensusText,
      confidence,
      keyPoints,
      agreement,
      divergences,
      responses,
      traceability,
      timestamp: Date.now(),
    };
  }
}
