/**
 * Application state.
 *
 * Holds the Kernel instance but never raw records: the rows live behind `Kernel.#rows`, a true
 * private field, and everything here works with already-disclosed aggregate cells.
 *
 * Both the WebMCP tool layer and the React UI read from this single store, which is what makes
 * the collaboration real rather than simulated. When the agent runs an analysis, the human's
 * charts update from the same result object the agent received.
 */

import { Kernel, type AggregateOk, type Disclosure, type LedgerEntry } from '../kernel/kernel.js';
import { N_NUMERIC_FLOOR } from '../kernel/policy.js';

export type Severity = 'info' | 'concern' | 'critical';

export interface Finding {
  id: string;
  title: string;
  detail: string;
  severity: Severity;
  at: string;
  /** The analysis this finding was drawn from, for provenance in the exported report. */
  basedOn: Record<string, unknown> | null;
}

export type OverrideStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface OverrideRequest {
  id: string;
  /** The exact analysis that would be re-run at a relaxed floor. */
  spec: { metric: string; stat: string; groupBy: string[] };
  /** Agent-authored. Shown to the human as a quotation, never as an instruction. */
  justification: string;
  status: OverrideStatus;
  at: string;
  resolvedAt?: string;
  result?: Disclosure;
}

/** The relaxed floor granted by a human override. Still well above the count floor. */
export const OVERRIDE_NUMERIC_FLOOR = 10;

/**
 * How long an override request stays open.
 *
 * A request that waits indefinitely becomes a trap: it sits on screen until someone approves it
 * out of habit, and it keeps `check_override_request` registered, which an agent can use as a
 * free polling channel. Expiry bounds both.
 */
export const OVERRIDE_TTL_MS = 120_000;

export interface AppState {
  loaded: boolean;
  rowCount: number;
  /** Most recent successful analysis. Drives the chart panel. */
  lastAggregate: AggregateOk | null;
  /** Verbatim last tool return, whatever it was. Drives the inspector panel. */
  lastToolReturn: { tool: string; input: unknown; output: unknown; at: string } | null;
  findings: Finding[];
  overrides: OverrideRequest[];
  ledger: readonly LedgerEntry[];
  budget: { charged: number; remaining: number };
  /** Count of individual records disclosed. Structurally always zero; displayed as proof. */
  /**
   * Individual records disclosed.
   *
   * Structurally zero rather than counted: no code path can place a record in a tool response or
   * in the DOM, so there is nothing to increment. Presented in the UI with that wording, because
   * a number that looks measured but is constant invites exactly the scepticism it should
   * disarm.
   */
  recordsDisclosed: 0;
  replaying: boolean;
  replayCaption: string | null;
  /** Total budget, read from the kernel so an extension cannot desynchronise the display. */
  budgetTotal: number;
}

type Listener = () => void;

export class Store {
  kernel = new Kernel();
  #listeners = new Set<Listener>();
  #seq = 0;

  findings: Finding[] = [];
  overrides: OverrideRequest[] = [];
  lastAggregate: AggregateOk | null = null;
  lastToolReturn: AppState['lastToolReturn'] = null;
  replaying = false;
  /** Narration for the replay step currently on screen. */
  replayCaption: string | null = null;

  /**
   * Cached immutable snapshot.
   *
   * `useSyncExternalStore` compares snapshots by reference and re-renders whenever the reference
   * changes. Returning a freshly built object on every call would loop forever. The cache is
   * invalidated only in `notify()`, which is the single place state changes are announced.
   */
  #snapshot: AppState | null = null;
  #rowCount = 0;

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  notify(): void {
    this.#snapshot = null;
    for (const fn of this.#listeners) fn();
  }

  snapshot(): AppState {
    if (this.#snapshot) return this.#snapshot;
    this.#snapshot = {
      loaded: this.kernel.loaded,
      // Cached at load time. Calling kernel.profile() here would append a ledger entry on
      // every render, which would both spam the audit trail and defeat the cache.
      rowCount: this.#rowCount,
      lastAggregate: this.lastAggregate,
      lastToolReturn: this.lastToolReturn,
      findings: [...this.findings],
      overrides: [...this.overrides],
      ledger: this.kernel.getLedger(),
      budget: { charged: 0, remaining: this.kernel.remaining },
      budgetTotal: this.kernel.budgetTotal,
      recordsDisclosed: 0,
      replaying: this.replaying,
      replayCaption: this.replayCaption
    };
    return this.#snapshot;
  }

  /**
   * The single path for loading a dataset.
   *
   * Exists so that caching `rowCount` cannot be forgotten: the tool handler, the Load button and
   * replay mode all come through here.
   */
  loadDataset(opts: { seed?: number; count?: number } = {}): ReturnType<Kernel['loadSample']> {
    const result = this.kernel.loadSample(opts);
    this.#rowCount = result.status === 'ok' ? result.rowCount : 0;
    this.notify();
    return result;
  }

  /** Records what a tool returned, for the inspector panel. */
  recordToolReturn(tool: string, input: unknown, output: unknown): void {
    this.lastToolReturn = { tool, input, output, at: new Date().toISOString() };
    if ((output as { status?: string } | null)?.status === 'ok' && 'cells' in (output as object)) {
      this.lastAggregate = output as AggregateOk;
    }
    this.notify();
  }

  addFinding(f: Omit<Finding, 'id' | 'at'>): Finding {
    const finding: Finding = { ...f, id: `f${++this.#seq}`, at: new Date().toISOString() };
    this.findings.push(finding);
    this.notify();
    return finding;
  }

  openOverride(
    spec: OverrideRequest['spec'],
    justification: string
  ): OverrideRequest {
    const req: OverrideRequest = {
      id: `ovr${++this.#seq}`,
      spec,
      justification,
      status: 'pending',
      at: new Date().toISOString()
    };
    this.overrides.push(req);
    this.notify();
    return req;
  }

  /**
   * Human decision on an override.
   *
   * Approval re-runs the exact requested analysis at OVERRIDE_NUMERIC_FLOOR instead of
   * N_NUMERIC_FLOOR. It is not a blanket policy change: one analysis, once, recorded in the
   * ledger alongside the justification the agent gave.
   */
  /**
   * Expires any request that has been open longer than OVERRIDE_TTL_MS.
   *
   * Called from both the read and write paths so expiry cannot be dodged by simply not polling.
   */
  expireStaleOverrides(now = Date.now()): void {
    let changed = false;
    for (const o of this.overrides) {
      if (o.status !== 'pending') continue;
      if (now - Date.parse(o.at) >= OVERRIDE_TTL_MS) {
        o.status = 'expired';
        o.resolvedAt = new Date(now).toISOString();
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  resolveOverride(id: string, decision: 'approved' | 'denied'): OverrideRequest | null {
    this.expireStaleOverrides();
    const req = this.overrides.find((o) => o.id === id);
    // Also rejects a second decision on an already-resolved request, so a human decision cannot
    // be replayed.
    if (!req || req.status !== 'pending') return null;

    req.status = decision;
    req.resolvedAt = new Date().toISOString();

    if (decision === 'approved') {
      req.result = this.kernel.aggregate({
        stat: req.spec.stat,
        metric: req.spec.metric,
        groupBy: req.spec.groupBy,
        numericFloorOverride: OVERRIDE_NUMERIC_FLOOR,
        overrideId: req.id
      });
      if (req.result.status === 'ok') this.lastAggregate = req.result;
    }

    this.notify();
    return req;
  }

  findOverride(id: string): OverrideRequest | undefined {
    this.expireStaleOverrides();
    return this.overrides.find((o) => o.id === id);
  }

  reset(): void {
    this.kernel = new Kernel();
    this.findings = [];
    this.overrides = [];
    this.lastAggregate = null;
    this.lastToolReturn = null;
    this.#rowCount = 0;
    this.notify();
  }

  /** For display: the floor currently in force for ordinary analysis. */
  get numericFloor(): number {
    return N_NUMERIC_FLOOR;
  }
}

export const store = new Store();
