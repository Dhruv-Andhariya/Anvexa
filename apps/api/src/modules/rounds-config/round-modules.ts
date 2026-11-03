import { Injectable } from '@nestjs/common';
import type { RoundModule } from '@hireflow/contracts';

/**
 * Which round modules (GD, DSA, SQL, AI interview - see ROUND_MODULE_OF in contracts) are part of this server. A module
 * connects itself when it starts (onModuleInit). The round engine hands a student who passed a round to the next
 * round's module only when that module is connected; until then HR runs that round (the "next round is run by HR"
 * email), so a job can already use a round type whose module is not built yet.
 *
 * DSA is connected by the round engine itself (DSA_ROUNDS on): it invites to and grades DSA rounds like an online test.
 *
 * How a new module plugs in (SQL, AI interview):
 *   1. import RoundEngineModule; in onModuleInit: this.roundModules.connect('SQL')
 *   2. find who is waiting:  roundEngine.waitingForModule('SQL', { tenantId? })   (passed every earlier round)
 *   3. run the round on its own page, then record it:
 *        roundEngine.recordModuleResult(tenantId, 'SQL', { applicationId, roundId, marks, answers: [...], notes })
 *      The result and answers show on the HR Assessments page and the student moves on (next invite / email).
 */
@Injectable()
export class RoundModules {
  private readonly modules = new Set<RoundModule>();

  connect(module: RoundModule): void {
    this.modules.add(module);
  }

  isConnected(module: RoundModule): boolean {
    return this.modules.has(module);
  }

  connected(): ReadonlySet<RoundModule> {
    return this.modules;
  }
}
