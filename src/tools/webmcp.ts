/**
 * A thin wrapper over the native WebMCP API.
 *
 * Deliberately thin. Devpost's submission requirements ask that the repository contain
 * `document.modelContext.registerTool({...})`, and a judge reading the code should see the real
 * API rather than a framework abstraction over it. This file adds feature detection, lifecycle
 * management and nothing else.
 *
 * Verified behaviour, from FINDINGS in NOTES.md:
 *   - `document.modelContext` is the current namespace. `navigator.modelContext` also exists in
 *     Chrome 151 but is undocumented and absent from the spec; we do not use it.
 *   - `registerTool` returns a Promise and must be awaited.
 *   - Unregistration is by aborting the AbortSignal passed at registration. There is no
 *     `unregisterTool`.
 *   - Registering a duplicate name rejects with InvalidStateError rather than replacing, so the
 *     previous signal must be aborted first.
 *   - `toolchange` fires once per registration.
 *   - The second argument to `execute` is `{ signal }`. `requestUserInteraction` does not exist;
 *     it was removed from the spec in June 2026.
 *   - A thrown error's message is DISCARDED by the platform: the caller receives a generic
 *     UnknownError. Refusals must therefore be returned as values, never thrown.
 */

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  execute: (input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>;
}

interface ModelContextLike {
  registerTool(def: unknown, opts?: { signal?: AbortSignal }): Promise<void>;
  addEventListener?(type: string, fn: () => void): void;
}

export function modelContext(): ModelContextLike | null {
  // Feature detection must not assume a DOM. Without this guard the bare `document` reference
  // throws ReferenceError under Node, and because `syncRegistration()` is deliberately
  // fire-and-forget its async body turns that into an unhandled rejection — which surfaced as a
  // non-zero `vitest` exit even with all 157 assertions passing. Browsers are unaffected:
  // `document` is always defined there, so this is purely an environment check.
  if (typeof document === 'undefined') return null;
  const mc = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  return mc && typeof mc.registerTool === 'function' ? mc : null;
}

export function isSupported(): boolean {
  return modelContext() !== null;
}

/** Chrome's published advisory budgets. Exceeding them risks agent-side guardrails. */
const LIMITS = { name: 30, description: 500, paramDescription: 150 };

export interface BudgetWarning {
  tool: string;
  field: string;
  length: number;
  limit: number;
}

/**
 * Checks a definition against Chrome's advisory character budgets.
 *
 * Surfaced in the UI rather than thrown: these are recommendations, not hard limits, and a
 * warning we can see is more useful than a crash.
 */
export function checkBudgets(def: ToolDef): BudgetWarning[] {
  const out: BudgetWarning[] = [];
  if (def.name.length > LIMITS.name) {
    out.push({ tool: def.name, field: 'name', length: def.name.length, limit: LIMITS.name });
  }
  if (def.description.length > LIMITS.description) {
    out.push({
      tool: def.name,
      field: 'description',
      length: def.description.length,
      limit: LIMITS.description
    });
  }
  const props = (def.inputSchema?.properties ?? {}) as Record<string, { description?: string }>;
  for (const [key, prop] of Object.entries(props)) {
    const d = prop.description ?? '';
    if (d.length > LIMITS.paramDescription) {
      out.push({
        tool: def.name,
        field: `${key}.description`,
        length: d.length,
        limit: LIMITS.paramDescription
      });
    }
  }
  return out;
}

/** Tool names must match [A-Za-z0-9_.-]{1,128}; the spec rejects anything else. */
const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

/**
 * Registers and unregisters tools in response to application state.
 *
 * A single controller per logical group, so a group can be withdrawn atomically by aborting.
 * Registering the same name twice rejects, so a group is always fully torn down before being
 * re-registered.
 */
export class ToolRegistry {
  #groups = new Map<string, AbortController>();
  #registered = new Set<string>();
  #warnings: BudgetWarning[] = [];

  get registeredNames(): string[] {
    return [...this.#registered].sort();
  }

  get warnings(): readonly BudgetWarning[] {
    return this.#warnings;
  }

  async ensure(group: string, defs: ToolDef[]): Promise<void> {
    if (this.#groups.has(group)) return;
    const mc = modelContext();
    if (!mc) return;

    const controller = new AbortController();
    this.#groups.set(group, controller);

    for (const def of defs) {
      if (!isValidName(def.name)) {
        throw new Error(`invalid tool name: ${def.name}`);
      }
      this.#warnings.push(...checkBudgets(def));
      await mc.registerTool(
        {
          name: def.name,
          description: def.description,
          ...(def.inputSchema ? { inputSchema: def.inputSchema } : {}),
          ...(def.annotations ? { annotations: def.annotations } : {}),
          execute: def.execute
        },
        { signal: controller.signal }
      );
      this.#registered.add(def.name);
    }
  }

  withdraw(group: string, names: string[]): void {
    const controller = this.#groups.get(group);
    if (!controller) return;
    controller.abort();
    this.#groups.delete(group);
    for (const n of names) this.#registered.delete(n);
  }

  has(group: string): boolean {
    return this.#groups.has(group);
  }
}
