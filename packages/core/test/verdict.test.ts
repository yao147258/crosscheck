import { describe, expect, it } from 'vitest';
import {
  checkJudgement,
  decide,
  exitCodeFor,
  worstStatus,
  type EvidenceRecord,
  type Expectation,
  type Judgement,
} from '../src/index';

const exp: Expectation = { id: 'E1', text: '列出身份', evidence: ['screenshot', 'dom'] };
const index = new Map<string, EvidenceRecord>([
  ['ev-1', { id: 'ev-1', type: 'screenshot' }],
  ['ev-2', { id: 'ev-2', type: 'dom' }],
  ['ev-3', { id: 'ev-3', type: 'network' }],
]);
const j = (over: Partial<Judgement> = {}): Judgement => ({
  expectationId: 'E1',
  verdict: 'pass',
  evidenceIds: ['ev-1', 'ev-2'],
  reasoning: '截图中可见',
  ...over,
});

describe('checkJudgement', () => {
  it('证据存在且类型齐全时有效', () => {
    expect(checkJudgement(j(), exp, index)).toEqual({ ok: true });
  });

  it('没有引用证据时作废', () => {
    const r = checkJudgement(j({ evidenceIds: [] }), exp, index);
    expect(r.ok).toBe(false);
  });

  it('引用不存在的证据时作废', () => {
    const r = checkJudgement(j({ evidenceIds: ['ev-1', 'ev-2', 'ev-9'] }), exp, index);
    expect(r).toEqual({ ok: false, reason: '引用了不存在的证据：ev-9' });
  });

  it('缺少要求的证据类型时作废', () => {
    const r = checkJudgement(j({ evidenceIds: ['ev-1', 'ev-3'] }), exp, index);
    expect(r).toEqual({ ok: false, reason: '缺少要求的证据类型：dom' });
  });

  it('预期 id 不匹配时作废', () => {
    expect(checkJudgement(j({ expectationId: 'E2' }), exp, index).ok).toBe(false);
  });

  it('推理为空时作废', () => {
    expect(checkJudgement(j({ reasoning: '  ' }), exp, index).ok).toBe(false);
  });

  it('unclear 判定可以不附证据，但必须说明理由', () => {
    expect(checkJudgement(j({ verdict: 'unclear', evidenceIds: [] }), exp, index)).toEqual({ ok: true });
  });
});

describe('decide', () => {
  const pass = j();
  const fail = j({ verdict: 'fail' });
  const unclear = j({ verdict: 'unclear' });

  it.each([
    [pass, pass, 'PASS'],
    [fail, fail, 'FAIL'],
    [pass, fail, 'DISPUTED'],
    [fail, pass, 'DISPUTED'],
    [unclear, pass, 'UNCLEAR'],
    [fail, unclear, 'UNCLEAR'],
    [null, pass, 'BLOCKED'],
    [pass, null, 'BLOCKED'],
  ] as const)('%#', (a, b, expected) => {
    expect(decide(a, b)).toBe(expected);
  });
});

describe('worstStatus / exitCodeFor', () => {
  it('取最严重的状态', () => {
    expect(worstStatus(['PASS', 'UNCLEAR', 'DISPUTED'])).toBe('DISPUTED');
    expect(worstStatus(['FAIL', 'BLOCKED'])).toBe('BLOCKED');
    expect(worstStatus(['PASS'])).toBe('PASS');
  });

  it('没有任何预期结果时视为 BLOCKED', () => {
    expect(worstStatus([])).toBe('BLOCKED');
  });

  it('退出码', () => {
    expect(exitCodeFor(['PASS', 'PASS'])).toBe(0);
    expect(exitCodeFor(['PASS', 'FAIL', 'BLOCKED'])).toBe(1);
    expect(exitCodeFor(['PASS', 'DISPUTED'])).toBe(2);
    expect(exitCodeFor(['UNCLEAR'])).toBe(2);
    expect(exitCodeFor([])).toBe(2);
  });
});
