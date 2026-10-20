/** A page load is never permission to replay calls. Eligibility belongs to a fresh submitted turn. */
export class FreshTurnPolicy {
  private generation = 0;
  private scope: string | null = null;
  private seen = new Map<string, number>();

  reset(): void {
    this.generation++;
    this.scope = null;
  }

  beginTurn(scope: string): number {
    this.generation++;
    this.scope = scope;
    return this.generation;
  }

  moveNewConversationScope(previous: string, next: string): boolean {
    if (this.scope !== previous) return false;
    this.scope = next;
    return true;
  }

  observe(key: string, scope: string, provenNewResponse: boolean): number | null {
    const previous = this.seen.get(key);
    if (this.scope !== scope || !provenNewResponse || (previous !== undefined && previous !== this.generation)) {
      if (previous === undefined) this.seen.set(key, -1);
      return null;
    }
    this.seen.set(key, this.generation);
    return this.generation;
  }

  permits(key: string, scope: string, generation: number): boolean {
    return this.scope === scope && this.generation === generation && this.seen.get(key) === generation;
  }
}
