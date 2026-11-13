import { ArtifactError } from './artifact-store';

export function evidencePath(prefix: string, id: string, mime: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) throw new ArtifactError('证据标识不适合作为文件名');
  const type = mime.split(';', 1)[0]?.trim().toLowerCase();
  const ext = type === 'image/png' ? 'png' : type === 'application/har+json' ? 'har' : type === 'application/json' ? 'json' : type?.startsWith('text/') && type.length > 5 ? 'txt' : undefined;
  if (!ext) throw new ArtifactError('不支持的证据媒体类型');
  return `${prefix}/evidence/files/${id}.${ext}`;
}
