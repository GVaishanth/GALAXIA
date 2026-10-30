/**
 * Regenerates §2-§4 of docs/freeroam/ASTRONOMY_SOURCES.md from the catalogue
 * data (galaxy facts, verified objects, source register). The hand-written
 * header (everything before "## 2. Galaxies") is kept.
 *
 *   npm run catalogue:doc
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { SOURCES } from '../src/modes/freeroam/catalogue/data/sources.ts';

const docPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'freeroam', 'ASTRONOMY_SOURCES.md');
const c = getCatalogue();
const usedBy = new Map<string, string[]>();
const use = (ids: readonly string[], who: string) => { for (const id of ids) usedBy.set(id, [...new Set([...(usedBy.get(id) ?? []), who])]); };
for (const g of c.galaxies) { use(g.provenance.sourceIds, g.id); for (const f of g.facts) use(f.sourceIds, g.id); }
for (const s of c.systems) use(s.provenance.sourceIds, s.id);
const esc = (t: string) => t.replace(/\|/g, '\\|');
let out = '';
out += '## 2. Galaxies\n\n';
for (const g of c.galaxies) {
  const d = g.distanceLy ? (g.distanceLy.low === g.distanceLy.high ? `about ${g.distanceLy.low.toLocaleString('en-US')} ly` : `${g.distanceLy.low.toLocaleString('en-US')}–${g.distanceLy.high.toLocaleString('en-US')} ly`) : '— (we are inside it)';
  out += `### ${g.name} (\`${g.id}\`)\n\n`;
  out += `- **Designations:** ${g.designations.join(', ')}\n- **Class (gameplay enum):** \`${g.morphology.class}\`; **published type:** ${g.morphology.code ? '`' + g.morphology.code + '`' : 'none stored'}${g.morphology.note ? ` — ${g.morphology.note}` : ''}\n- **Relation:** ${g.relation}${g.relatedTo ? ` (of ${g.relatedTo})` : ''}\n- **Constellation:** ${g.constellation}\n- **Distance stored:** ${d}\n\n`;
  out += '| Fact used | Sources |\n|---|---|\n';
  for (const f of g.facts) out += `| ${esc(f.text)} | ${f.sourceIds.map((x) => '`' + x + '`').join(', ')} |\n`;
  out += '\n';
}
out += '## 3. Real objects used as systems\n\nOnly the **fact** column is astronomy. The playable sector at each of these locations is a GALAXIA simulation (see `CONTENT_PROVENANCE.md`).\n\n| System id | Name | Category | Fact used | Sources |\n|---|---|---|---|---|\n';
for (const s of c.systems.filter((x) => x.provenance.status === 'verified-object')) out += `| \`${s.id}\` | ${s.name} | ${s.category} | ${esc(s.fact!)} | ${s.provenance.sourceIds.map((x) => '`' + x + '`').join(', ')} |\n`;
out += '\n## 4. Source register\n\nAll pages retrieved **2026-10-19**. `primary` = space agency, observatory, laboratory or peer-reviewed journal; `secondary` = encyclopedia, used only for cross-checks and published morphology codes, and always labelled “(secondary reference)” where it is the only citation.\n\n| Id | Tier | Publisher | Title | URL | Cited by |\n|---|---|---|---|---|---|\n';
for (const s of SOURCES) out += `| \`${s.id}\` | ${s.tier} | ${esc(s.publisher)} | ${esc(s.title)} | <${s.url}> | ${(usedBy.get(s.id) ?? []).join(', ')} |\n`;
const doc = readFileSync(docPath, 'utf8');
const marker = doc.indexOf('## 2. Galaxies');
if (marker < 0) throw new Error('ASTRONOMY_SOURCES.md: "## 2. Galaxies" marker not found');
writeFileSync(docPath, doc.slice(0, marker) + out);
console.log(`ASTRONOMY_SOURCES.md: ${c.galaxies.length} galaxies, ${c.systems.filter((s) => s.provenance.status === 'verified-object').length} verified objects, ${SOURCES.length} sources`);
