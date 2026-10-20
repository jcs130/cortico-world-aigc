/** Illustrative Bot/Persona composition, never imported by the AIGC World. */
import { AppearanceLibrary, appearanceTool } from '../src/persona/index.ts';
import type { AppearanceEntry } from '../src/persona/index.ts';
export function personaAppearanceTools(memory: {
  readFile(path: string): string;
  writeFile(path: string, text: string): unknown;
}) {
  const index = 'references/appearances/index.json';
  const library = new AppearanceLibrary({
    read: () => JSON.parse(memory.readFile(index)) as AppearanceEntry[],
    write: entries => { memory.writeFile(index, JSON.stringify(entries, null, 2)); },
  });
  return [appearanceTool(library)];
}
// Persona also declares appearance_lookup in ownToolNames() and BotDefinition.describe.tools.
// Persona.blobs remains the authoritative mem: backend. Select identity references explicitly.
