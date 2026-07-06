/**
 * Scripted brain for server tests — unit tests NEVER spawn a real agent CLI.
 * Each `runTurn` invocation replays the next script; when the scripts run out
 * it yields a bare `done` so the supervisor loop terminates cleanly. Captures
 * every `BrainTurnInput` so tests can assert prompt fencing.
 */
import type { BrainAdapter, BrainEvent, BrainProbe, BrainTurnInput } from '@terminull/manage-agent';

export class FakeBrain implements BrainAdapter {
  readonly id = 'fake';
  readonly inputs: BrainTurnInput[] = [];
  private call = 0;

  constructor(private readonly scripts: BrainEvent[][]) {}

  probe(): Promise<BrainProbe> {
    return Promise.resolve({ availability: 'ok', version: 'fake-1' });
  }

  async *runTurn(input: BrainTurnInput): AsyncIterable<BrainEvent> {
    this.inputs.push(input);
    const script = this.scripts[this.call] ?? [{ kind: 'done', stopReason: 'end_turn' }];
    this.call += 1;
    for (const event of script) yield event;
  }
}
