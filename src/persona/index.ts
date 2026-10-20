/** Called and persisted by Persona; a World never receives this memory port. */
import type { AssetInput, CreationOutcome, MediaReference } from '../contracts.ts';
import { VISUAL_REFERENCE_PROTOCOL } from '../contracts.ts';
export interface AppearanceEntry {
  schema: typeof VISUAL_REFERENCE_PROTOCOL; entityId: string; revision: string;
  label: string; aliases: string[]; references: MediaReference[]; source: string;
}
export interface AppearanceMemory {
  read(): AppearanceEntry[];
  write(entries: AppearanceEntry[]): void;
}
export class AppearanceLibrary {
  constructor(private readonly memory: AppearanceMemory) {}
  list(): AppearanceEntry[] { return structuredClone(this.memory.read()); }
  get(entityId: string): AppearanceEntry | null {
    const record = this.memory.read().find(r => r.entityId === entityId);
    return record ? structuredClone(record) : null;
  }
  /** Caller resolves identity. Similar names/images never auto-merge records. */
  set(entry: AppearanceEntry): void {
    if (entry.schema !== VISUAL_REFERENCE_PROTOCOL || !entry.entityId || !entry.revision || !entry.source
      || !Array.isArray(entry.references) || entry.references.length > 20
      || entry.references.some(r => r.role !== 'identity' || !r.handle.startsWith('mem:') || r.entityId !== entry.entityId || r.revision !== entry.revision))
      throw new Error('Appearance entry requires a stable identity, revision, provenance and explicit mem: identity references');
    this.memory.write([...this.memory.read().filter(r => r.entityId !== entry.entityId), structuredClone(entry)]);
  }
}
export const APPEARANCE_TOOL_DECL = {
  name: 'appearance_lookup', tags: ['read'] as const,
  description: 'Read Persona-owned appearance references by stable entity_id. list returns the identity index. read returns selected identity/reference revisions and mem: image handles. No inferred identity merge. This is a Persona tool, not a World memory backdoor.',
  parameters: { type: 'object', additionalProperties: false,
    properties: { action: { type: 'string', enum: ['list', 'read'] }, entity_id: { type: 'string' } }, required: ['action'] },
};
export function appearanceTool(library: AppearanceLibrary) {
  return { ...APPEARANCE_TOOL_DECL, tags: ['read'] as Array<'read'>,
    handler: async (args: Record<string, unknown>): Promise<CreationOutcome> => {
      if (args.action === 'list') return { text: JSON.stringify(library.list().map(({ entityId, label, revision }) => ({ entityId, label, revision }))) };
      const entry = library.get(String(args.entity_id));
      if (!entry) return { text: 'No confirmed appearance references for this identity', failed: true };
      const blobs: AssetInput[] = entry.references.map(ref => ({ handle: ref.handle,
        fallbackText: 'Identity ' + entry.entityId + ', revision ' + entry.revision + ', view ' + (ref.view ?? 'unspecified')
          + '; appearance only, not pose, background or current-world facts.' }));
      return { text: JSON.stringify(entry), blobs };
    } };
}
