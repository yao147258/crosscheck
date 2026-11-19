export type ImpactCertainty = 'definite' | 'possible';
export type ImpactChangeKind = 'added' | 'modified' | 'deleted';

export interface ImpactNode {
  key: string;
  kind: 'document' | 'notes' | 'profile' | 'clause' | 'case' | 'config';
  file: string;
  id?: string;
  value: unknown;
}

export interface ImpactDiagnostic {
  code: string;
  side?: 'base' | 'current';
  file?: string;
  message: string;
}

export interface ImpactSnapshot {
  nodes: ImpactNode[];
  files: { file: string; state: 'present' | 'missing' | 'invalid' }[];
  diagnostics: ImpactDiagnostic[];
}

export interface ImpactChange {
  key: string;
  kind: ImpactChangeKind;
  fields: string[];
}

export interface ImpactReason {
  source: string;
  chain: string[];
  certainty: ImpactCertainty;
  side: 'base' | 'current';
  description?: string;
}

export interface ImpactReport {
  version: 1;
  baseline: string;
  complete: boolean;
  changes: ImpactChange[];
  impacts: { key: string; certainty: ImpactCertainty; reasons: ImpactReason[] }[];
  diagnostics: ImpactDiagnostic[];
  limitations: string[];
  advisories: string[];
}
