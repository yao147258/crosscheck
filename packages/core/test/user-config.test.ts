import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema, UserModelConfigSchema, contentHash, loadUserModelConfig, publicModelConfig, ProjectConfigSchema } from '../src/index';

const homes: string[] = [];
async function home() { const dir = await mkdtemp(path.join(os.tmpdir(), 'crosscheck-user-')); homes.push(dir); return dir; }
afterEach(async () => { await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const valid = `models:\n  extractor: custom:a\n  planner: custom:a\n  executor: custom:a\n  reviewer: custom:b\nproviders:\n  custom:\n    type: openai\n    baseURL: https://example.test/v1\n    apiKey: secret-value\n`;

describe('provider 配置约束', () => {
  const models = { extractor: 'p:a', planner: 'p:a', executor: 'p:a', reviewer: 'p:b' };
  for (const schema of [ConfigSchema, UserModelConfigSchema]) {
    it.each(['google', 'deepseek', 'ollama', 'openai-compatible'])('拒绝不支持的类型 %s', type => {
      expect(schema.safeParse({ models, providers: { p: { type, baseURL: 'https://example.test/v1' } } }).success).toBe(false);
    });
    it.each([undefined, 'ftp://example.test/v1', 'https://user:pass@example.test/v1', 'not-a-url'])('拒绝缺失或不安全的 baseURL：%s', baseURL => {
      expect(schema.safeParse({ models, providers: { p: { type: 'openai', baseURL } } }).success).toBe(false);
    });
    it.each(['openai', 'anthropic'])('接受支持的类型 %s 和安全地址', type => {
      expect(schema.safeParse({ models, providers: { p: { type, baseURL: 'http://localhost:11434/v1' } } }).success).toBe(true);
    });
  }
});

describe('全局模型配置', () => {
  it('从独立的用户目录读取模型配置，公开投影不包含密钥', async () => {
    const dir = await home(); await mkdir(path.join(dir, '.crosscheck')); await writeFile(path.join(dir, '.crosscheck', 'config.yaml'), valid);
    const config = await loadUserModelConfig(dir);
    expect(config.providers.custom?.apiKey).toBe('secret-value');
    expect(JSON.stringify(publicModelConfig(config))).not.toContain('secret-value');
    expect(publicModelConfig(config).providers.custom?.baseURL).toBe('https://example.test/v1');
  });
  it('轮换密钥不改变公开指纹，修改 endpoint 则改变指纹', async () => {
    const dir = await home(); await mkdir(path.join(dir, '.crosscheck')); const file = path.join(dir, '.crosscheck', 'config.yaml');
    await writeFile(file, valid); const first = publicModelConfig(await loadUserModelConfig(dir));
    await writeFile(file, valid.replace('secret-value', 'rotated-key')); const rotated = publicModelConfig(await loadUserModelConfig(dir));
    await writeFile(file, valid.replace('https://example.test/v1', 'https://other.test/v1')); const changed = publicModelConfig(await loadUserModelConfig(dir));
    expect(contentHash(rotated)).toBe(contentHash(first));
    expect(contentHash(changed)).not.toBe(contentHash(first));
  });
  it('文件不存在和损坏时提供不含配置内容的错误', async () => {
    const dir = await home();
    await expect(loadUserModelConfig(dir)).rejects.toThrow(/全局.*config.yaml/);
    await mkdir(path.join(dir, '.crosscheck')); await writeFile(path.join(dir, '.crosscheck', 'config.yaml'), 'apiKey: secret-value\nmodels: [');
    await expect(loadUserModelConfig(dir)).rejects.not.toThrow(/secret-value/);
  });
  it('短密钥不会因普通模型文本包含相同字符而被误拒', async () => {
    const dir = await home(); await mkdir(path.join(dir, '.crosscheck'));
    await writeFile(path.join(dir, '.crosscheck', 'config.yaml'), valid.replace('secret-value', 'a'));
    expect((await loadUserModelConfig(dir)).providers.custom?.apiKey).toBe('a');
  });
  it('拒绝秘密混入公开模型字段，避免秘密参与指纹', async () => {
    const dir = await home(); await mkdir(path.join(dir, '.crosscheck'));
    await writeFile(path.join(dir, '.crosscheck', 'config.yaml'), valid.replace('https://example.test/v1', 'https://example.test/secret-value'));
    await expect(loadUserModelConfig(dir)).rejects.toThrow(/不合法/);
  });
  it('拒绝空密钥以及带身份信息的 endpoint', async () => {
    const dir = await home(); await mkdir(path.join(dir, '.crosscheck'));
    const file = path.join(dir, '.crosscheck', 'config.yaml');
    await writeFile(file, valid.replace('secret-value', '   '));
    await expect(loadUserModelConfig(dir)).rejects.toThrow(/不合法/);
    await writeFile(file, valid.replace('https://example.test/v1', 'https://user:pass@example.test/v1'));
    await expect(loadUserModelConfig(dir)).rejects.toThrow(/不合法/);
  });
  it('项目配置不接受模型配置覆盖全局设置', () => {
    expect(ProjectConfigSchema.parse({ providers: { evil: { apiKey: 'secret-value' } }, models: {}, requirementsDocs: ['a.md'] })).toEqual({ budget: { perCase: { steps: 60, tokens: 400000, minutes: 10 } }, requirementsDocs: ['a.md'] });
  });
});
