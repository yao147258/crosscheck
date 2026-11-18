export interface DiscoverySource {
  file: string;
  line: number;
  excerpt: string;
}

interface FactBase {
  plugin: string;
  source: DiscoverySource;
}

export type DiscoveryFact = FactBase & (
  | { kind: 'api'; method: string; path: string; summary: string; parameters: { name: string; in: string; required: boolean; type?: string }[]; servers: string[] }
  | { kind: 'project'; ecosystem: string; name: string }
  | { kind: 'command'; name: string; command: string }
  | { kind: 'port'; port: number; service?: string }
  | { kind: 'environment-variable'; name: string }
);

export interface DiscoveryDiagnostic {
  plugin: string;
  file?: string;
  message: string;
}

export interface DiscoveryResult {
  facts: DiscoveryFact[];
  diagnostics: DiscoveryDiagnostic[];
}

export interface ProjectReader {
  readText(file: string, signal?: AbortSignal): Promise<string | undefined>;
}

export interface ProjectEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  link?: boolean;
}

export interface ProjectLister extends ProjectReader {
  list(dir: string, signal?: AbortSignal, options?: { maxEntries?: number; onEntry?: () => void; onDiagnostic?: (message: string) => void }): Promise<ProjectEntry[]>;
}

export interface DiscoveryContext {
  files: ProjectReader;
  signal?: AbortSignal;
}

export interface DiscoveryPlugin {
  id: string;
  scan(ctx: DiscoveryContext): Promise<DiscoveryResult>;
}
