import type { Decision, Judgement } from '@crosscheck/core';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useContext, useRef, useState } from 'react';
import { Footer, List, ReviewDetails, clampIndex, moveIndex } from '../components';
import { ActionContext, useReview } from '../context';
import { useAction, useLoader } from '../hooks';
import { navKey, type Nav } from '../routes';
import { DECISION_LABELS, exportEvidence, loadResultRows, recordDisposition, type ResultRow } from '../state/results';

type Target = Pick<ResultRow, 'caseId' | 'expectationId'>;
type Mode =
  | { kind: 'list' }
  | { kind: 'clause'; target: Target; options: string[]; index: number; number: string; invalid?: boolean }
  | { kind: 'note'; target: Target; decision: Decision; clauseId?: string; text: string };

// Ink 可能在一次 React 提交前交付连续按键，引用必须与输入同步更新。
function useInputState<T>(initial: T) {
  const [value, update] = useState(initial);
  const ref = useRef(value);
  const set = (next: T) => { ref.current = next; update(next); };
  return [value, set, ref] as const;
}

const singleLine = (text: string) => text.replace(/\s+/g, ' ');
const label = (row: Target) => `${row.caseId}/${row.expectationId}`;
const removeLast = (text: string) => Array.from(text).slice(0, -1).join('');
function judgementLines(title: string, judgement: Judgement | null): string[] {
  return judgement ? [title, `判定：${judgement.verdict}`, `引用证据：${judgement.evidenceIds.join(', ') || '无'}`, `理由：${judgement.reasoning}`] : [`${title}：判定无效或缺失`];
}
function resultDetails(row: ResultRow): string[] {
  return [
    `${label(row)} ${row.status} · 尝试 ${row.attempt}`, `预期：${row.expectationText}`, `覆盖条款：${row.covers.join(', ') || '无'}`,
    ...judgementLines('执行方 executor', row.executor), ...judgementLines('复核方 reviewer', row.reviewer),
    '全部证据（返回列表后 Tab 选择，o 请求打开）',
    ...(row.evidence.length ? row.evidence.flatMap((e, i) => [
      `${i + 1}) ${e.id} ${e.type}`, `摘要：${e.summary ?? '无'}`,
      `阶段：${e.phase} · 时间：${e.time} · MIME：${e.mime} · 已遮蔽：${e.redacted ? '是' : '否'}`,
      `路径：${e.path}`, `摘要校验：${e.digest}`,
    ]) : ['无证据']),
    ...(row.disposition ? [
      `人工裁决：${DECISION_LABELS[row.disposition.decision]}`, `条款：${row.disposition.clauseId ?? '无'}`,
      `确认人：${row.disposition.by} · 时间：${row.disposition.at}`, `备注：${row.disposition.note || '无'}`,
    ] : ['人工裁决：未记录']),
  ];
}

function JudgementPanel({ title, judgement }: { title: string; judgement: Judgement | null }) {
  return (
    <Box width="50%" flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold wrap="truncate-end">{title} · {judgement?.verdict ?? '判定无效或缺失'}</Text>
      {judgement && <>
        <Text wrap="truncate-end">引用证据：{judgement.evidenceIds.join(', ') || '无'}</Text>
        <Text wrap="truncate-end">理由：{singleLine(judgement.reasoning)}</Text>
      </>}
    </Box>
  );
}

export function ResultsView({ nav, runId }: { nav: Nav; runId: string }) {
  const { session, open } = useReview();
  const actions = useContext(ActionContext);
  const { rows: terminalRows, columns } = useWindowSize();
  const wide = columns >= 100 && terminalRows >= 24;
  const short = terminalRows < 14;
  const { data, error, reload } = useLoader(() => loadResultRows(session, runId), [session, runId]);
  const { status, setStatus, run } = useAction();
  const [index, setIndex, indexRef] = useInputState(0);
  const [evidenceIndex, setEvidenceIndex, evidenceRef] = useInputState(0);
  const [mode, setMode, modeRef] = useInputState<Mode>({ kind: 'list' });
  const [details, setDetails, detailsRef] = useInputState<{ title: string; lines: string[] } | undefined>(undefined);
  const loading = !data && !error;
  const rows = data ?? [];
  const current = clampIndex(index, rows.length);
  const row = rows[current];
  const evidence = row?.evidence ?? [];
  const currentEvidence = clampIndex(evidenceIndex, evidence.length);
  const selected = evidence[currentEvidence];
  const cancel = () => { setMode({ kind: 'list' }); setStatus({ kind: 'info', text: '已取消裁决' }); };

  useInput((input, key) => {
    // Ctrl+C 只交给 App 的中断处理；不得进入备注或条款选择分支。
    if (key.ctrl || detailsRef.current) return;
    if (loading && (key.escape || input === 'q')) {
      setStatus({ kind: 'info', text: '请等待结果加载完成，避免重复获取运行锁' });
      return;
    }
    if (actions?.busy.current) { setStatus({ kind: 'error', text: '请等待当前操作完成' }); return; }
    const mode = modeRef.current;
    const current = clampIndex(indexRef.current, rows.length);
    const row = rows[current];
    const evidence = row?.evidence ?? [];
    const currentEvidence = clampIndex(evidenceRef.current, evidence.length);
    const selected = evidence[currentEvidence];
    if (mode.kind === 'note') {
      if (key.escape) { cancel(); return; }
      if (key.return) {
        const { target, decision, clauseId, text } = mode;
        setMode({ kind: 'list' });
        void run(async () => {
          try { return await recordDisposition(session, runId, { ...target, decision, clauseId, note: text }); }
          finally { reload(); }
        });
        return;
      }
      if (key.backspace || key.delete) { setMode({ ...mode, text: removeLast(mode.text) }); return; }
      if (input && !key.meta && !key.tab && !key.upArrow && !key.downArrow) setMode({ ...mode, text: mode.text + input.replace(/[\x00-\x1f\x7f]/g, '') });
      return;
    }
    if (mode.kind === 'clause') {
      if (key.escape) { cancel(); return; }
      if (key.upArrow || key.downArrow) {
        setMode({ ...mode, index: moveIndex(mode.index, mode.options.length, key), number: '', invalid: false });
        return;
      }
      if (key.backspace || key.delete) { setMode({ ...mode, number: mode.number.slice(0, -1), invalid: false }); return; }
      if (key.return) {
        const choice = mode.options[mode.number ? Number(mode.number) - 1 : mode.index];
        if (!choice) setMode({ ...mode, invalid: true });
        else setMode({ kind: 'note', target: mode.target, decision: 'clause_issue', clauseId: choice, text: '' });
        return;
      }
      if (/^\d+$/.test(input)) setMode({ ...mode, number: mode.number + input, invalid: false });
      return;
    }
    if (navKey(input, key, nav)) return;
    if (input === 's' && (status || error)) {
      setDetails({ title: '操作状态', lines: [status?.text ?? '', ...(error ? [`加载错误：${error}`] : [])] });
      return;
    }
    if (key.upArrow || key.downArrow) { setIndex(moveIndex(current, rows.length, key)); setEvidenceIndex(0); return; }
    if (!row) return;
    if (key.return) { setDetails({ title: label(row), lines: resultDetails(row) }); return; }
    if (key.tab) { setEvidenceIndex(evidence.length ? (currentEvidence + 1) % evidence.length : 0); return; }
    if (input === 'o' && selected) {
      void run(async () => {
        await open(await exportEvidence(session, runId, row, selected.id));
        return `已请求打开 ${selected.id}（仅保证启动请求，不保证已显示）`;
      });
      return;
    }
    // 在开始裁决时固定目标，后续备注提交不读取可能变化的当前行。
    const target = { caseId: row.caseId, expectationId: row.expectationId };
    if (input === 'b' || input === 'f') setMode({ kind: 'note', target, decision: input === 'b' ? 'confirmed_bug' : 'false_positive', text: '' });
    if (input === 'c') {
      if (!row.covers.length) setStatus({ kind: 'error', text: '该历史用例没有覆盖条款，不能记录条款问题' });
      else if (row.covers.length === 1) setMode({ kind: 'note', target, decision: 'clause_issue', clauseId: row.covers[0], text: '' });
      else setMode({ kind: 'clause', target, options: [...row.covers], index: 0, number: '' });
    }
  }, { isActive: !details });

  // 详情持有独立快照，是否挂载与列表监听的互斥条件保持完全一致。
  if (details) return <ReviewDetails title={details.title} lines={details.lines} close={() => setDetails(undefined)} quit={nav.quit} />;
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">结果审核 · {runId}</Text>
      {!(short && mode.kind !== 'list') && <List items={rows.map((r) => ({
        key: label(r), label: `${label(r)} ${r.status}${r.disposition ? ` · ${DECISION_LABELS[r.disposition.decision]}` : ''}`,
        color: r.status === 'FAIL' ? 'red' : 'yellow',
      }))} index={current} maxRows={mode.kind === 'list' ? Math.max(2, Math.min(6, terminalRows - (wide ? 15 : 12))) : 2} />}
      {!data && !error && <Text dimColor>加载中…</Text>}
      {data && !rows.length && <Text dimColor>本次运行没有 FAIL 或 DISPUTED 的预期</Text>}
      {mode.kind === 'list' && row && !short && <Box flexDirection="column" flexShrink={0}>
        <Text wrap="truncate-end">预期：{singleLine(row.expectationText)}</Text>
        {wide ? <Box flexDirection="row">
          <JudgementPanel title="执行方 executor" judgement={row.executor} />
          <JudgementPanel title="复核方 reviewer" judgement={row.reviewer} />
        </Box> : <>
          <Text wrap="truncate-end">执行方 {row.executor ? `${row.executor.verdict} · ${singleLine(row.executor.reasoning)}` : '判定无效或缺失'}</Text>
          <Text wrap="truncate-end">复核方 {row.reviewer ? `${row.reviewer.verdict} · ${singleLine(row.reviewer.reasoning)}` : '判定无效或缺失'}</Text>
        </>}
        <Text wrap="truncate-end">{selected ? `证据 ${currentEvidence + 1}/${evidence.length} ${selected.type} ${selected.id} ${singleLine(selected.summary ?? '')}` : '无证据'}</Text>
      </Box>}
      {mode.kind === 'clause' && <>
        <Text color="yellow" wrap="truncate-end">选择有问题的条款 · {label(mode.target)}</Text>
        <List items={mode.options.map((id, i) => ({ key: id, label: `${i + 1}) ${id}` }))} index={mode.index} maxRows={Math.max(2, terminalRows - 11)} />
        <Text color={mode.invalid ? 'red' : 'yellow'} wrap="truncate-end">{mode.invalid ? '编号无效，请重新输入：' : '编号：'}{mode.number || '（方向键选择）'}</Text>
      </>}
      {mode.kind === 'note' && <>
        <Text color="yellow" wrap="truncate-end">{DECISION_LABELS[mode.decision]} · {label(mode.target)}{mode.clauseId ? ` · ${mode.clauseId}` : ''}</Text>
        <Text color="yellow" wrap="truncate-start">备注：{singleLine(mode.text) || '（可留空）'}</Text>
      </>}
      {error && <Text color="red" wrap="truncate-end">{singleLine(error)}</Text>}
      {status && <Text color={status.kind === 'error' ? 'red' : 'green'} wrap="truncate-end">{singleLine(status.text)}</Text>}
      <Footer keys={mode.kind === 'list'
        ? 'Enter 详情 · ↑↓ 选择 · Tab 证据 · o 打开\nb bug · f 误报 · c 条款 · s 状态详情\nEsc/q 返回/退出'
        : mode.kind === 'clause' ? '↑↓ 或完整编号 · Enter 选择\nEsc 取消 · Ctrl+C 中断' : 'Enter 提交备注 · Esc 取消\nCtrl+C 中断'} />
    </Box>
  );
}
