/**
 * Finale P1: the Admin panel's DIAGNOSTICS tab (internal reference: docs/development/ADMIN_ACCESS.md).
 * A lazy chunk, fetched only when an active Admin session opens the tab; never part of ordinary play.
 *
 * Read-outs come from the systems that own the state (the sector run, abilityStatus, stealthStatus,
 * heatView, chainViews, the crew view, the ledger, the save store) through the narrow DiagHost the
 * shell provides; nothing here keeps a copy of game state or computes a rule of its own.
 *
 * Actions go through the authoritative functions and are validated first (a refusal changes nothing):
 *  - critical mode   forceCritical on the current sector visit (Admin sandbox only; a new visit is AUTO)
 *  - test target     spawnAgent (lent by the shell): one hostile ship ahead of the pilot, under the normal agent cap
 *  - rule check      the critical policy's own functions on scratch tokens (boundary, duplicate spend,
 *                    capital protection, invalid mode); the run is not touched
 *  - reward guards   the real mission turn-in (refused in the sandbox) and the ledger's once-per-id check
 * Ship abilities, the test fleet and ship switching keep their existing entry points (the ability key
 * or button, the FLEET panel, the SHIPS tab), so nothing here bypasses them.
 *
 * Isolation: everything happens inside the Admin sandbox, whose single save gateway writes nothing; the
 * persistence block fingerprints the stored slot so the tester can see it does not change.
 */
import { CRIT_CHANCE, critShip, forceCritical, isCritical, useCritical, type CritMode } from '../combat/critical.ts';
import { heatView, type HeatBook } from '../combat/factionHeat.ts';
import { FAMILIES, type FamilyId } from '../combat/families.ts';
import { abilityStatus } from '../combat/shipAbilities.ts';
import type { Agent } from '../combat/state.ts';
import { stealthStatus } from '../combat/stealth.ts';
import type { ShipCrewView } from '../crew/view.ts';
import type { Vessels } from '../fleet/vessels.ts';
import type { LedgerResult } from '../progression/ledger.ts';
import type { ProgressionState } from '../progression/persistence.ts';
import { btn, el } from '../progression/ui/common.ts';
import type { ChainView } from '../progression/view.ts';
import type { SectorRun } from '../sector/run.ts';

/** What the shell lends the tab (getters onto its own state, and its existing actions). */
export interface DiagHost {
  /** The active Admin session object (identity only), or null when none is active. */
  readonly session: () => object | null;
  readonly run: () => SectorRun | null;
  readonly prog: () => ProgressionState;
  readonly vessels: () => Vessels;
  readonly crew: () => ShipCrewView;
  readonly heat: () => HeatBook | undefined;
  readonly chains: () => readonly ChainView[];
  /** The Admin test-fleet read-out lines (FleetAdmin.lines). */
  readonly fleetLines: () => readonly string[];
  /** The stored save slot as written (null = empty slot). */
  readonly slot: () => string | null;
  /** May the mode write the save now (mayPersist)? Always false while a session is active. */
  readonly persists: () => boolean;
  /** The shell's real mission turn-in. */
  readonly claim: (id: string) => { readonly ok: boolean; readonly text: string };
  /** spawnAgent on the current run (the shell lends it: the tab's chunk takes values only from the shared world chunk). */
  readonly spawn: (family: FamilyId, x: number, y: number, heading: number) => Agent | null;
  /** The ledger's award() for a repeat of claim `id` on the current ledger: a pure check, the result is never applied. */
  readonly rewardRepeat: (id: string) => LedgerResult;
}

export interface DiagSection {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
}

const MODE_TEXT: Readonly<Record<CritMode, string>> = { auto: 'AUTO · 10 % per firing event (seeded)', crit: 'FORCED CRITICAL · every eligible firing event', normal: 'FORCED ORDINARY · no critical hits' };
const VICTIM_TEXT = { hostile: 'destroyed', player: 'pilot ship lost (recall)', escort: 'escort disabled' } as const;
/** Ships the tab may place (one of each size class, and a capital to show its protection). */
export const DIAG_SPAWN: readonly FamilyId[] = ['raider', 'heavy', 'capital'];

const flying = (r: SectorRun | null): r is SectorRun => !!r && !r.disposed && !r.docked && (r.phase === 'flight' || r.phase === 'paused');

/** The fingerprint of the stored slot (length and 32-bit FNV-1a): a quick "has anything been written" check. */
export function slotPrint(raw: string | null): string {
  if (raw === null) return 'empty slot';
  let x = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) x = Math.imul(x ^ raw.charCodeAt(i), 0x01000193);
  return `${raw.length} chars · ${(x >>> 0).toString(16).padStart(8, '0')}`;
}
const firstPrint = new WeakMap<object, string>();

/** Every read-out, from the owning systems. */
export function diagnosticsModel(h: DiagHost): DiagSection[] {
  const r = h.run();
  const p = h.prog();
  const s = h.session();
  const raw = slotPrint(h.slot());
  if (s && !firstPrint.has(s)) firstPrint.set(s, raw);
  const base = s ? firstPrint.get(s)! : raw;
  const m = p.missions;
  const recent = p.ledger.recent;
  const crew = h.crew();
  const out: DiagSection[] = [];
  if (r) {
    const c = r.crit;
    out.push({
      id: 'crit',
      title: 'CRITICAL HITS',
      lines: [
        `Mode: ${MODE_TEXT[c.mode]} · this sector visit only`,
        `This visit: ${c.rolls} firing events decided · ${c.rolled} critical · ${c.landed} confirmed on a ship`,
        ...(c.last.length ? c.last.map((e) => `Tick ${e.tick}: ${e.what === 'pilot' ? 'pilot' : e.what.toUpperCase()} · ${VICTIM_TEXT[e.victim]} · by the ${e.by === 'player' ? "pilot's side" : 'hostile side'}`) : ['No confirmed critical hit this visit.']),
        'Eligible: hostile ships only, once per firing event, through the ordinary damage path. Capital ships, wary ships, stations and the environment take ordinary hits.',
      ],
    });
    const a = abilityStatus(r);
    out.push({
      id: 'ship',
      title: 'SHIP AND ABILITY',
      lines: [
        `${r.craft.ship.toUpperCase()} · hull ${Math.ceil(r.hull)}/${r.craft.stats.hull} · shield ${Math.ceil(r.shield)}/${r.craft.stats.shield} · kills this visit ${r.kills}`,
        a.id ? `${a.name} [${a.tag}] · ${a.active ? 'ACTIVE' : a.available ? 'READY' : `not ready (${a.reason ?? 'cooling'})`}${a.cooldownTicks > 0 ? ` · cooldown ${Math.ceil(a.cooldownTicks / 60)} s` : ''}` : 'No ship ability on this ship.',
        'Use it from flight with the ability key or button (the ordinary request path). Switch ships on the SHIPS tab.',
      ],
    });
    const st = stealthStatus(r);
    out.push({
      id: 'stealth',
      title: 'FACTION HEAT AND STEALTH',
      lines: [
        heatView(h.heat()).map((v) => `${v.label} ${v.value} (${v.tierName})`).join(' · ') || 'No faction heat.',
        `Silent Running ${st.silent ? 'ON' : 'off'} · signature ${st.signature.toFixed(2)} · tracking ${st.tracking} · searching ${st.searching} · in Gravity Shadow ${st.shadowed}`,
      ],
    });
    out.push({
      id: 'flight',
      title: 'FLIGHT AND SIGNALS',
      lines: [
        `Flight mode ${r.flightMode.toUpperCase()} · ${r.docked ? `docked at ${r.docked}` : r.phase}`,
        `Signal bearings held ${r.signal.tracks.size} · ${r.signal.obs ? 'observing now' : 'not observing'} · Simple Signals ${r.signal.simple ? 'on' : 'off'} (source positions are never shown here)`,
      ],
    });
    out.push({
      id: 'recovery',
      title: 'RAID BOX AND TOW',
      lines: [r.salvage ? `Recovery hull here: ${r.salvage.toUpperCase()} · ${r.hulk ? (r.hulk.towed ? 'on the tether' : `resting${r.hulk.attach ? ` (tow refused: ${r.hulk.attach})` : ''}`) : 'Raid Box not opened yet'}` : 'No recovery hull in this sector.'],
    });
  } else out.push({ id: 'crit', title: 'CRITICAL HITS', lines: ['Fly in a sector to inspect combat, the ship ability, stealth, signals and the tow.'] });
  out.push({ id: 'fleet', title: 'FLEET', lines: [...h.fleetLines(), `${h.vessels().list.filter((v) => v.status === 'disabled').length} disabled (back in service at the next dock).`] });
  out.push({
    id: 'crew',
    title: 'CREW (ADVICE ONLY)',
    lines: [`${crew.members.length}/${crew.seats} seats aboard: ${crew.members.map((c) => `${c.name} (${c.role}, ${c.rank})`).join(', ') || 'flying solo'}`, 'Crew advise; they never fly, fire, target or command the fleet.'],
  });
  const chains = h.chains();
  out.push({
    id: 'missions',
    title: 'MISSIONS AND REWARDS',
    lines: [
      `Active ${m.active.length} · completed ${m.completed.length} · claimed ${m.claimed.length} · failed ${m.failed.length} · ready to turn in ${m.completed.filter((id) => !m.claimed.includes(id)).length}`,
      `Story chains: ${chains.map((c) => `${c.title} ${c.completed}/${c.stages.length}`).join(' · ') || 'none'}`,
      `Balance ${p.marks} marks · ${recent.length} claim ids remembered · ${recent.length - new Set(recent).size} duplicates`,
    ],
  });
  out.push({
    id: 'save',
    title: 'PERSISTENCE',
    lines: [
      `Save writes ${h.persists() ? 'ALLOWED' : 'refused for the whole Admin session (sandbox)'}`,
      `Stored slot ${raw} · ${raw === base ? 'unchanged since this session first checked it' : `CHANGED (was ${base})`}`,
      'EXIT ADMIN discards the sandbox and reloads that slot.',
    ],
  });
  return out;
}

/** Force or release critical hits for this sector visit. Refused (no change) without an Admin session or flight. */
export function diagCritMode(h: DiagHost, mode: unknown): string {
  const r = h.run();
  if (!h.session()) return 'Refused: critical modes exist only in an Admin session.';
  if (!flying(r)) return 'Refused: fly in a sector first (the mode belongs to one sector visit).';
  if (!forceCritical(r, mode)) return 'Refused: unknown critical mode.';
  return `Critical mode: ${MODE_TEXT[r.crit.mode]}. It returns to AUTO on the next sector visit.`;
}

/** Place one hostile test ship 260 units ahead of the pilot (normal agent cap and solids apply). */
export function diagSpawn(h: DiagHost, family: unknown): string {
  const r = h.run();
  if (!h.session()) return 'Refused: test targets exist only in an Admin session.';
  if (!DIAG_SPAWN.includes(family as FamilyId)) return 'Refused: unknown test target.';
  if (!flying(r)) return 'Refused: fly in a sector first (not docked).';
  const f = family as FamilyId;
  const n = { x: Math.sin(r.ship.heading), y: -Math.cos(r.ship.heading) };
  const x = Math.min(r.layout.width - 40, Math.max(40, r.ship.x + n.x * 260));
  const y = Math.min(r.layout.height - 40, Math.max(40, r.ship.y + n.y * 260));
  const a = h.spawn(f, x, y, r.ship.heading + Math.PI);
  if (!a) return 'Refused: the sector is at its ship limit.';
  return `${FAMILIES[f].label} #${a.id} placed ahead (Red Tally, hostile${critShip(a) ? '' : ', capital: protected from critical hits'}). Close the panel and fire.`;
}

/** The critical policy's own functions on scratch values (the run is not touched). */
export function diagRuleCheck(): string {
  const probe = (family: FamilyId): Agent => ({ family, role: 'guard' }) as Agent;
  const t = { spent: false };
  const first = useCritical(t, probe('raider'));
  const again = useCritical(t, probe('raider'));
  const cap = useCritical({ spent: false }, probe('capital'));
  const bogus = forceCritical({ crit: { mode: 'auto' } } as never, 'always');
  const ok = isCritical(CRIT_CHANCE - 1e-9) && !isCritical(CRIT_CHANCE) && first && !again && !cap && !bogus;
  return `Rule check ${ok ? 'passed' : 'FAILED'}: just under 10 % is critical, 10 % is not · a token spends once (repeat ${again ? 'ACCEPTED' : 'refused'}) · capital ${cap ? 'NOT protected' : 'protected'} · invalid mode ${bogus ? 'ACCEPTED' : 'refused'}.`;
}

/** The real turn-in (refused in the sandbox) and the ledger's once-per-id rule (a pure check; nothing is applied). */
export function diagRewardGuard(h: DiagHost): string {
  const p = h.prog();
  const m = p.missions;
  const ready = m.completed.find((id) => !m.claimed.includes(id)) ?? m.active[0]?.id ?? 'none';
  const claim = h.claim(ready);
  const id = p.ledger.recent[p.ledger.recent.length - 1];
  const dup = id ? h.rewardRepeat(id) : null;
  const after = h.prog().marks;
  return `Turn-in ${claim.ok ? 'PAID (unexpected)' : `refused: ${claim.text}`} · ${dup ? `a repeat of claim id ${id}: ${dup.ok ? 'ACCEPTED' : `refused (${dup.reason})`}` : 'no claim id recorded yet'} · balance ${after === p.marks ? `unchanged at ${after}` : `CHANGED to ${after}`}.`;
}

/** Fill the tab. `say` shows a feedback line; `rerender` redraws the panel (and this tab). */
export function renderDiagnostics(h: DiagHost, host: HTMLElement, say: (text: string) => void, rerender: (focus?: string) => void): void {
  const act = (key: string, text: string, run: () => string): HTMLButtonElement =>
    btn('fr-admin-diag-act', text, key, () => {
      say(run());
      rerender(key);
    });
  for (const s of diagnosticsModel(h)) {
    const box = el('section', 'fr-admin-diag');
    box.dataset['diag'] = s.id;
    box.append(el('h3', 'fr-admin-det-title', s.title), ...s.lines.map((l) => el('p', 'fr-text fr-text-dim', l)));
    if (s.id === 'crit' && h.run()) {
      const row = el('div', 'fr-admin-det-actions');
      row.append(
        act('crit-auto', 'AUTO', () => diagCritMode(h, 'auto')),
        act('crit-force', 'FORCE CRITICAL', () => diagCritMode(h, 'crit')),
        act('crit-normal', 'FORCE ORDINARY', () => diagCritMode(h, 'normal')),
        act('crit-check', 'RULE CHECK', diagRuleCheck),
        ...DIAG_SPAWN.map((f) => act(`spawn-${f}`, `SPAWN ${FAMILIES[f].label.toUpperCase()}`, () => diagSpawn(h, f))),
      );
      box.append(row);
    }
    if (s.id === 'missions') {
      const row = el('div', 'fr-admin-det-actions');
      row.append(act('reward-guard', 'TEST REWARD GUARDS', () => diagRewardGuard(h)));
      box.append(row);
    }
    host.append(box);
  }
}
