/**
 * Adapter conformance runner — a machine check that an adapter's declarations
 * match its behaviour, so a lying capability is caught before it reaches the
 * UI. Used by tests now and by `terminull plugins validate` later.
 *
 * Checks:
 *  1. probe-consistency  — no capability declared positive that the probe
 *     positively reports as unavailable.
 *  2. collector-schema   — collector returns schema-valid DiscoveredSession[].
 *  3. parser-consistency — a parseable transcript format ('jsonl'/'sqlite')
 *     requires a parser.
 *  4. parser-roundtrip   — a declared parser reads a golden fixture into
 *     schema-valid ChatItems without throwing, honouring cursor monotonicity.
 *  5. keymap-i18n        — every keymap entry has non-empty en+ko labels.
 *  6. drivability        — a driver is present iff the capabilities imply one.
 */
import { z } from 'zod';
import type { ToolCapabilities } from './capabilities.js';
import {
  isDrivable,
  type CollectContext,
  type DiscoveredSession,
  type ProbeContext,
  type ToolAdapter,
  type TranscriptRef,
} from './adapter.js';

/** Inputs the runner needs to exercise an adapter. */
export interface ConformanceFixtures {
  probeContext: ProbeContext;
  collectContext: CollectContext;
  /** Golden transcript to round-trip the parser (required if a parser is declared). */
  transcript?: { ref: TranscriptRef; minItems?: number };
  /** Session handed to `driverFor` for the drivability check. */
  session?: DiscoveredSession;
}

/** One failed conformance check. */
export interface ConformanceFailure {
  check: string;
  message: string;
}

/** The runner's verdict. */
export interface ConformanceResult {
  pass: boolean;
  failures: ConformanceFailure[];
}

const TranscriptRefSchema = z.union([
  z.object({ kind: z.literal('file'), path: z.string() }).strict(),
  z.object({ kind: z.literal('sqlite'), path: z.string() }).strict(),
  z.object({ kind: z.literal('opaque'), handle: z.string() }).strict(),
]);

const DiscoveredSessionSchema = z
  .object({
    id: z.string().min(1),
    tool: z.string().min(1),
    cwd: z.string().optional(),
    live: z.boolean(),
    title: z.string().optional(),
    updatedAt: z.number().optional(),
    transcriptRef: TranscriptRefSchema.optional(),
  })
  .strict();

const ChatItemSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'agent', 'tool', 'system']),
    kind: z.enum(['message', 'tool_call', 'tool_result', 'event']),
    text: z.string().optional(),
    ts: z.number().optional(),
    raw: z.unknown().optional(),
  })
  .strict();

/** A capability value counts as "positive" when it offers a real feature. */
function capabilityPositive(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value !== 'none';
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.values(value).some(Boolean);
  return false;
}

/** Run every conformance check against `adapter`. */
export async function runAdapterConformance(
  adapter: ToolAdapter,
  fixtures: ConformanceFixtures,
): Promise<ConformanceResult> {
  const failures: ConformanceFailure[] = [];

  // 1. probe-consistency
  try {
    const probe = await adapter.probe(fixtures.probeContext);
    for (const key of Object.keys(adapter.capabilities) as (keyof ToolCapabilities)[]) {
      const declared = adapter.capabilities[key];
      if (!capabilityPositive(declared)) continue;
      if (!(key in probe.capabilities)) continue; // probe made no claim about it
      const observed = probe.capabilities[key];
      if (!capabilityPositive(observed)) {
        failures.push({
          check: 'probe-consistency',
          message: `capability '${key}' declared '${String(declared)}' but probe reports it unavailable ('${String(observed)}')`,
        });
      }
    }
  } catch (err) {
    failures.push({ check: 'probe-consistency', message: `probe threw: ${message(err)}` });
  }

  // 2. collector-schema
  try {
    const sessions = await Promise.resolve(adapter.collector.collect(fixtures.collectContext));
    const parsed = z.array(DiscoveredSessionSchema).safeParse(sessions);
    if (!parsed.success) {
      failures.push({
        check: 'collector-schema',
        message: `collector returned invalid sessions: ${parsed.error.issues[0]?.message ?? 'schema error'}`,
      });
    }
  } catch (err) {
    failures.push({ check: 'collector-schema', message: `collector threw: ${message(err)}` });
  }

  // 3. parser-consistency
  const needsParser =
    adapter.capabilities.transcript === 'jsonl' || adapter.capabilities.transcript === 'sqlite';
  if (needsParser && !adapter.parser) {
    failures.push({
      check: 'parser-consistency',
      message: `capability transcript='${adapter.capabilities.transcript}' declared but no parser provided`,
    });
  }

  // 4. parser-roundtrip
  if (adapter.parser && fixtures.transcript) {
    try {
      const first = await Promise.resolve(adapter.parser.readWindow(fixtures.transcript.ref));
      for (const item of first.items) {
        const ok = ChatItemSchema.safeParse(item);
        if (!ok.success) {
          failures.push({
            check: 'parser-roundtrip',
            message: `parser produced an invalid ChatItem: ${ok.error.issues[0]?.message ?? 'schema error'}`,
          });
          break;
        }
      }
      if (first.cursor.offset < 0) {
        failures.push({ check: 'parser-roundtrip', message: 'cursor offset is negative' });
      }
      const { minItems } = fixtures.transcript;
      if (minItems !== undefined && first.items.length < minItems) {
        failures.push({
          check: 'parser-roundtrip',
          message: `parser read ${first.items.length} items, expected at least ${minItems}`,
        });
      }
      const second = await Promise.resolve(
        adapter.parser.readWindow(fixtures.transcript.ref, first.cursor),
      );
      if (second.cursor.offset < first.cursor.offset) {
        failures.push({
          check: 'parser-roundtrip',
          message: `cursor moved backward (${first.cursor.offset} -> ${second.cursor.offset})`,
        });
      }
    } catch (err) {
      failures.push({ check: 'parser-roundtrip', message: `parser threw: ${message(err)}` });
    }
  }

  // 5. keymap-i18n
  for (const [key, binding] of Object.entries(adapter.keymap)) {
    if (!binding) continue;
    const label = binding.label;
    const hasEn = typeof label?.en === 'string' && label.en.length > 0;
    const hasKo = typeof label?.ko === 'string' && label.ko.length > 0;
    if (!hasEn || !hasKo) {
      failures.push({
        check: 'keymap-i18n',
        message: `keymap entry '${key}' is missing an en or ko label`,
      });
    }
  }

  // 6. drivability
  const session: DiscoveredSession = fixtures.session ?? {
    id: 'conformance',
    tool: adapter.id,
    live: false,
  };
  const driver = adapter.driverFor(session, { inject: () => {} });
  const drivable = isDrivable(adapter.capabilities, adapter.keymap);
  if (drivable && !driver) {
    failures.push({
      check: 'drivability',
      message: 'capabilities imply drivability but driverFor returned null',
    });
  } else if (!drivable && driver) {
    failures.push({
      check: 'drivability',
      message: 'capabilities imply no drivability but driverFor returned a driver',
    });
  }

  return { pass: failures.length === 0, failures };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
