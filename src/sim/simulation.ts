import { TableClient } from "../client/client.ts";
import { rng } from "../engine/cards.ts";
import { type Faults, NO_FAULTS } from "../engine/faults.ts";
import type { Action, TableConfig } from "../engine/types.ts";
import { viewOf } from "../engine/view.ts";
import { CorruptLogError, MemoryLog, replay, type ServiceOptions, TableService } from "../server/service.ts";
import { VirtualClock } from "./clock.ts";
import { ServerProcess, type WriteStage } from "./crash.ts";
import { type Chaos, ChaosLink } from "./network.ts";

export interface SimOptions {
  seed: number;
  players?: number;
  hands?: number;
  chaos: Chaos;
  faults?: Faults;
  storeLatencyMs?: number;
  actionTimeoutMs?: number;
}

export interface SimResult {
  violations: string[];
  handsPlayed: number;
  events: number;
  commands: number;
  rejected: number;
  timeouts: number;
  reconnects: number;
  crashes: number;
  crashesMidHand: number;
  // Crashes that landed with a write not on disk yet, and with a write on
  // disk whose events had not been published yet.
  crashesBeforeWrite: number;
  crashesBeforePublish: number;
  virtualMs: number;
}

// A random but legal-looking player: sits down, buys back in when busted,
// and usually answers quickly, sometimes too slowly and gets timed out.
function bot(client: TableClient, clock: VirtualClock, random: () => number, config: TableConfig, timeoutMs: number) {
  let decided = "";
  let stopped = false;
  const busy = () => [...client.pending.values()].some((c) => c.type !== "act");

  const decide = () => {
    if (stopped || busy()) return;
    const v = client.view;
    const seat = client.seat;
    if (seat < 0) {
      const free = v.seats.flatMap((s, i) => (s ? [] : [i]));
      if (free.length === 0) return;
      const buyIn = config.minBuyIn + Math.floor(random() * (config.maxBuyIn - config.minBuyIn + 1));
      client.send({ type: "sit", seat: free[Math.floor(random() * free.length)], playerId: client.playerId!, buyIn });
      return;
    }
    const inHand = v.hand?.players.some((p) => p.seat === seat);
    if (v.seats[seat]!.busted && !inHand) {
      client.send({ type: "leave", playerId: client.playerId! });
      return;
    }
    const t = client.turn;
    const h = v.hand;
    if (!h || !t || h.toAct !== seat || t.seat !== seat || t.turn !== h.turn || t.handId !== h.id) return;
    const key = `${h.id}:${h.turn}`;
    if (key === decided) return;
    decided = key;
    const think = random() < 0.9 ? 10 + random() * 300 : timeoutMs * (0.8 + random() * 0.4);
    const x = random();
    let action: Action;
    if (t.canRaise && x < 0.2) {
      const to = random() < 0.2 ? t.maxRaiseTo : t.minRaiseTo + Math.floor(random() * (t.maxRaiseTo - t.minRaiseTo + 1));
      action = random() < 0.1 ? { kind: "allin" } : { kind: "raise", to };
    } else if (t.toCall === 0) action = { kind: "check" };
    else action = x < 0.35 ? { kind: "fold" } : { kind: "call" };
    clock.after(think, () => client.send({ type: "act", playerId: client.playerId!, handId: t.handId, turn: t.turn, action }));
  };
  client.onChange = decide;
  return { stop: () => (stopped = true), decide };
}

export async function simulate(opts: SimOptions): Promise<SimResult> {
  const { seed, players = 4, hands = 12, chaos, faults = NO_FAULTS, storeLatencyMs = 20, actionTimeoutMs = 1000 } = opts;
  const clock = new VirtualClock();
  const random = rng(seed);
  const config: TableConfig = { seats: 6, smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 200, seed };
  const options = (proc: ServerProcess): ServiceOptions => ({
    config,
    faults,
    scheduler: proc.scheduler,
    store: proc.store,
    actionTimeoutMs,
    nextHandDelayMs: 100,
    maxHands: hands,
    audit: true,
  });

  // The disk outlives the server. Each life of the server is a process on
  // top of it; a crash throws the process away with everything in memory:
  // the table, the queue, commands waiting to be persisted, the timers.
  const disk = new MemoryLog();
  const violations: string[] = [];
  const stats = { crashes: 0, crashesMidHand: 0, crashesBeforeWrite: 0, crashesBeforePublish: 0 };
  // Half the crashes strike at a random moment. The other half wait for the
  // next write and strike at one of its stages: the instant before it reaches
  // the disk, on disk but not yet published, or published but not delivered.
  const crashRandom = rng(seed * 15485863 + 1);
  const stages: WriteStage[] = ["reaching-disk", "on-disk", "acknowledged"];
  let aimed: WriteStage | null = null;
  let calm = false;
  let up = true;
  let broken = false;
  // One write in ten is slow, as when a flush queues behind other I/O.
  const writeTime = () => random() * storeLatencyMs * (random() < 0.1 ? 10 : 1);
  const boot = () => {
    const p = new ServerProcess(clock, disk, writeTime);
    p.onWrite = (stage) => {
      if (stage !== aimed || p !== proc) return;
      aimed = null;
      if (stage === "acknowledged") clock.after(0, crash);
      else crash();
    };
    return p;
  };
  let proc = boot();
  let service = new TableService(options(proc));

  const clients = Array.from({ length: players }, (_, i) => new TableClient(`p${i + 1}`, config.seats, faults));
  clients.push(new TableClient(null, config.seats, faults)); // a spectator
  const links = clients.map((c, i) => new ChaosLink(clock, rng(seed * 7919 + i), () => (up ? service : null), c, chaos));
  const bots = clients.map((c, i) => (c.playerId ? bot(c, clock, rng(seed * 104729 + i), config, actionTimeoutMs) : null));
  links.forEach((link, i) => clock.after(i * 7, () => link.connect()));

  function crash() {
    if (calm || !up) return;
    stats.crashes++;
    if (service.state.hand) stats.crashesMidHand++;
    if (proc.writing) stats.crashesBeforeWrite++;
    if (proc.unacknowledged) stats.crashesBeforePublish++;
    proc.kill();
    violations.push(...service.violations);
    up = false;
    for (const l of links) l.drop();
    clock.after(chaos.restartAfterMs ?? 500, restart);
  }
  function armCrash() {
    if (!chaos.crashEveryMs) return;
    clock.after(-Math.log(1 - crashRandom()) * chaos.crashEveryMs, () => {
      if (crashRandom() < 0.5) crash();
      else aimed = stages[Math.floor(crashRandom() * stages.length)];
    });
  }
  function restart() {
    proc = boot();
    try {
      service = TableService.restore(options(proc), disk.records);
    } catch (e) {
      if (!(e instanceof CorruptLogError)) throw e;
      violations.push(`the restarted server refused its log: ${e.message}`);
      broken = true;
      return;
    }
    up = true;
    armCrash();
  }
  armCrash();

  const limit = 30 * 60_000;
  await clock.run({ until: () => broken || (up && service.state.handsPlayed >= hands && !service.state.hand), limit });
  // Let the network calm down and every message in flight land.
  for (const b of bots) b?.stop();
  for (const l of links) l.calm = true;
  calm = true;
  await clock.run({ until: () => broken, limit: clock.now() + 10 * 60_000 });
  const result = (): SimResult => {
    const all = clients.flatMap((c) => [...c.results.values()]);
    return {
      violations,
      handsPlayed: service.state.handsPlayed,
      events: service.head,
      commands: service.commits.length,
      rejected: all.filter((x) => !x.ok).length,
      timeouts: service.log.filter((e) => e.event.type === "ActionTaken" && e.event.timeout).length,
      reconnects: links.reduce((n, l) => n + l.connections - 1, 0),
      ...stats,
      virtualMs: clock.now(),
    };
  };
  if (broken) return result();

  if (service.state.handsPlayed < hands) violations.push(`stalled: ${service.state.handsPlayed} of ${hands} hands in ${limit / 60_000} virtual minutes`);
  violations.push(...service.violations);

  // The command log alone must rebuild the same events and the same table.
  const r = replay(config, service.commits, faults);
  violations.push(...r.errors);
  if (JSON.stringify(r.events) !== JSON.stringify(service.log.map((e) => e.event))) violations.push("replaying the commands produced different events");
  if (JSON.stringify(r.state) !== JSON.stringify(service.state)) violations.push("replaying the commands produced a different table");
  // And what the server published is exactly what is on disk.
  if (JSON.stringify(disk.records.flatMap((x) => x.events)) !== JSON.stringify(service.log.map((e) => e.event)))
    violations.push("the events on disk differ from the events the server published");

  const committed = new Set<string>();
  for (const c of service.commits) {
    const key = `${c.from}/${c.commandId}`;
    if (committed.has(key)) violations.push(`command ${key} was applied twice`);
    committed.add(key);
  }

  for (const c of clients) {
    const who = c.playerId ?? "spectator";
    violations.push(...c.anomalies.map((a) => `${who}: ${a}`));
    if (c.lastSeq !== service.head) violations.push(`${who} is at event ${c.lastSeq} of ${service.head}`);
    if (JSON.stringify(c.view) !== JSON.stringify(viewOf(service.state, c.playerId))) violations.push(`${who} sees a different table than the server`);
    if (c.pending.size) violations.push(`${who} has ${c.pending.size} commands with no result`);
    for (const [id, res] of c.results) {
      if (res.ok !== committed.has(`${c.playerId}/${id}`))
        violations.push(`${who}: command ${id} was told ${res.ok ? "ok" : res.code} but ${committed.has(`${c.playerId}/${id}`) ? "was" : "was not"} applied`);
    }
  }
  return result();
}
