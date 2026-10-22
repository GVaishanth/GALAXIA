/**
 * Item icons (Free Roam Prompt 10): original 12×12 pixel art, pure data.
 * Each resource category has its own silhouette (plate, ingot, cell, shard,
 * chip, crystal, cube, vial, disc, ring, gear), so icons are told apart by
 * shape, not by colour alone; equipment modules have one icon per slot type.
 * Rarity is shown in text and by a frame (inventory/ui), never by colour only.
 *
 * Grid characters: '.' transparent, 'a' body, 'b' highlight, 'c' shadow,
 * 'd' accent. Rendered by inventory/ui/icons.ts (DOM) and sector/lootRender.ts
 * (canvas); tests/inventory.test.ts checks every grid.
 */
import type { ResourceId } from '../catalogue/types.ts';
import type { SlotType } from '../ships/types.ts';

export interface IconArt {
  readonly grid: readonly string[];
  readonly colors: Readonly<Record<'a' | 'b' | 'c' | 'd', string>>;
}

export const ICON_SIZE = 12;

const I = (grid: readonly string[], a: string, b: string, c: string, d: string): IconArt => Object.freeze({ grid: Object.freeze([...grid]), colors: Object.freeze({ a, b, c, d }) });

export const RESOURCE_ICONS: Readonly<Record<ResourceId, IconArt>> = Object.freeze({
  // torn hull plate
  scrap: I(['............', '..aaa.......', '.abbaa..a...', '.abaaaa.aa..', '.aaaacaaaaa.', '..aaccaabaa.', '.aaacaaabba.', '.aacaaaaaaa.', '..aaaacaa...', '...aaa.aa...', '.....a......', '............'], '#8a93a6', '#c9d1e0', '#4b5263', '#c9d1e0'),
  // stacked ingots
  alloy: I(['............', '............', '...bbbbbb...', '..baaaaaab..', '.baaaaaaaab.', '.cccccccccc.', '..bbbbbbbb..', '.baaaaaaaab.', 'baaaaaaaaaab', 'cccccccccccc', '............', '............'], '#9fb4c8', '#e1ecf5', '#55657a', '#e1ecf5'),
  // capped power cell
  fuel: I(['....dddd....', '....dddd....', '...bbbbbb...', '...baaaac...', '...baddac...', '...badaac...', '...baddac...', '...baadac...', '...baddac...', '...baaaac...', '...cccccc...', '............'], '#3f9d6b', '#8ff0b8', '#1f5a3c', '#ffe066'),
  // glowing core splinter
  'core-shard': I(['.....b......', '....bab.....', '....bab.....', '...badab....', '...baddac...', '..badddac...', '..baddac....', '...badac....', '...baac.....', '....bac.....', '....cc......', '............'], '#ff7a45', '#ffd0a8', '#8a3216', '#fff2a8'),
  // control chip with pins
  circuits: I(['............', '..d.d.d.d...', '.bbbbbbbbb..', 'dbaaaaaaacd.', '.baddddaac..', 'dbadbbdaacd.', '.badbbdaac..', 'dbaddddaacd.', '.baaaaaaac..', '.ccccccccc..', '..d.d.d.d...', '............'], '#2f7d4f', '#7fe3a3', '#174029', '#ffd34d'),
  // crystal cluster
  crystal: I(['............', '.....b......', '....bab..b..', '....bab.bab.', '.b..badbbab.', 'bab.badbaac.', 'bab.baddaac.', 'baabbadaac..', '.baabaaac...', '..cccaacc...', '...ccccc....', '............'], '#5cc8ff', '#d5f3ff', '#2a5f8a', '#ffffff'),
  // ice block
  ice: I(['............', '....bbbb....', '..bbbbbbbb..', '.bbbaaaabbb.', '.cbbbaabbbd.', '.ccbbbbbbdd.', '.cccbbbbddd.', '.ccccbbdddd.', '.cccccdddda.', '..cccccddd..', '....cccd....', '............'], '#ffffff', '#bfe9fb', '#4f8fb0', '#7cc4e4'),
  // sealed vial
  samples: I(['....cccc....', '....bbbb....', '.....ba.....', '.....ba.....', '....baac....', '...baaaac...', '..baddddac..', '..badddddc..', '..baddddac..', '..cbaaaacc..', '...cccccc...', '............'], '#cfd8e8', '#ffffff', '#5d6880', '#c47bff'),
  // chart disc
  'nav-data': I(['............', '....cccc....', '..ccbbbbcc..', '.cbbdaabbbc.', '.cbaadabbbc.', 'cbbaaadbbabc', 'cbbbbbadbbbc', '.cbbbaaadbc.', '.cbbbbbbbbc.', '..ccbbbbcc..', '....cccc....', '............'], '#6fe0ff', '#2a4f7a', '#183152', '#ffd34d'),
  // ring on a plinth
  relic: I(['............', '....dddd....', '...daaaad...', '..daabbaad..', '..dab..bad..', '..dab..bad..', '..daabbaad..', '...daaaad...', '....dccd....', '...dccccd...', '..dddddddd..', '............'], '#e8c15a', '#fff1b8', '#7a5a1c', '#b88a2e'),
  // gear
  components: I(['............', '.....aa.....', '..a.abba.a..', '..aabbbbaa..', '...abccba...', '.aabc..cbaa.', '.aabc..cbaa.', '...abccba...', '..aabbbbaa..', '..a.abba.a..', '.....aa.....', '............'], '#b7c0cc', '#e9eef5', '#5a6472', '#e9eef5'),
});

export const MODULE_ICONS: Readonly<Record<SlotType, IconArt>> = Object.freeze({
  // gun barrel on a mount
  weapon: I(['............', '............', '........dd..', '.aaaaaaaaab.', '.abbbbbbbbd.', '.accccccccc.', '.aab........', '.aab........', '..ab........', '..cc........', '............', '............'], '#ff8c5a', '#ffd2b8', '#8a3b22', '#fff07a'),
  // shield crest
  shield: I(['............', '..bbbbbbbb..', '.baaaaaaaab.', '.baaddaaaab.', '.badaaaaaac.', '.baaaaaaaac.', '..baaaaaac..', '..baaaaaac..', '...baaaac...', '....baac....', '.....cc.....', '............'], '#5cefff', '#d6fbff', '#1f6f80', '#ffffff'),
  // nozzle with exhaust
  engine: I(['............', '...bbbbbb...', '..baaaaaac..', '..baaaaaac..', '...baaaac...', '...cccccc...', '....dddd....', '...dbbbbd...', '....dbbd....', '.....dd.....', '............', '............'], '#9aa7ff', '#e0e4ff', '#3d4690', '#ffb347'),
  // sensor dish
  sensor: I(['............', '.........d..', '..bb....d...', '.baab..d....', '.baaabd.....', '..baaab.....', '...baaab....', '....baac....', '.....cc.....', '....cccc....', '...cccccc...', '............'], '#7dff8a', '#d8ffdc', '#2c7a35', '#ffffff'),
  // cargo crate
  cargo: I(['............', '............', '.bbbbbbbbbb.', '.baaaaaaaac.', '.bacaaaacac.', '.baacaacaac.', '.baaaccaaac.', '.baacaacaac.', '.bacaaaacac.', '.baaaaaaaac.', '.cccccccccc.', '............'], '#d9a55a', '#ffe0a8', '#7a5222', '#ffe0a8'),
});
