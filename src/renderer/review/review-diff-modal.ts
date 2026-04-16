// review-diff-modal.ts — 파일 diff 모달 (줄 번호 + 통계 개선판)
import type { ItemChange } from '../../shared/types';

export function openDiffModal(change: ItemChange): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.tabIndex = -1;

  const modal = document.createElement('div');
  modal.className = 'modal diff-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const filePath = change.new_path || change.old_path;
  const status = change.new_file ? 'new'
    : change.deleted_file ? 'deleted'
    : change.renamed_file ? 'renamed' : 'modified';

  const statusClass = { new: 'badge-add', deleted: 'badge-del', renamed: 'badge-info', modified: 'badge-muted' }[status];
  const stats = calcStats(change.diff);

  modal.innerHTML = `
    <header class="modal-header">
      <div class="col" style="gap: 4px; min-width: 0; flex: 1;">
        <div class="diff-modal-path truncate">${escapeHtml(filePath)}</div>
        ${change.renamed_file
          ? `<div class="text-muted text-mono" style="font-size:var(--fs-xs);">← ${escapeHtml(change.old_path)}</div>`
          : ''}
      </div>
      <div class="row shrink0" style="gap: var(--space-2); align-items: center;">
        <span class="badge ${statusClass}">${status}</span>
        <span class="diff-stat-add">+${stats.add}</span>
        <span class="diff-stat-del">-${stats.del}</span>
        <button class="modal-close" aria-label="닫기" type="button">✕</button>
      </div>
    </header>
    <div class="modal-body diff-modal-body">
      <table class="diff-table" cellspacing="0" cellpadding="0">
        <colgroup>
          <col class="dc-col-gutter">
          <col class="dc-col-gutter">
          <col class="dc-col-code">
        </colgroup>
        <tbody id="diff-tbody"></tbody>
      </table>
    </div>
  `;

  const tbody = modal.querySelector<HTMLElement>('#diff-tbody');
  if (tbody) renderDiffTable(tbody, change.diff);

  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  modal.querySelector('.modal-close')?.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  modal.querySelector<HTMLButtonElement>('.modal-close')?.focus();
}

interface DiffRow {
  type: 'add' | 'del' | 'ctx' | 'hunk';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

function parseDiff(raw: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of raw.split('\n')) {
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      rows.push({ type: 'hunk', oldNo: null, newNo: null, text: line });
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      continue; // 파일 헤더 라인 생략
    }
    if (line.startsWith('+')) {
      rows.push({ type: 'add', oldNo: null, newNo: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith('-')) {
      rows.push({ type: 'del', oldNo: oldLine, newNo: null, text: line.slice(1) });
      oldLine++;
    } else {
      rows.push({ type: 'ctx', oldNo: oldLine, newNo: newLine, text: line.startsWith(' ') ? line.slice(1) : line });
      oldLine++;
      newLine++;
    }
  }
  return rows;
}

function renderDiffTable(tbody: HTMLElement, raw: string): void {
  const rows = parseDiff(raw);
  const frag = document.createDocumentFragment();

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = `dr-${row.type}`;

    if (row.type === 'hunk') {
      const td = document.createElement('td');
      td.colSpan = 3;
      td.className = 'dc-hunk';
      td.textContent = row.text;
      tr.appendChild(td);
    } else {
      const tdOld = document.createElement('td');
      tdOld.className = 'dc-gutter';
      tdOld.textContent = row.oldNo !== null ? String(row.oldNo) : '';

      const tdNew = document.createElement('td');
      tdNew.className = 'dc-gutter';
      tdNew.textContent = row.newNo !== null ? String(row.newNo) : '';

      const tdCode = document.createElement('td');
      tdCode.className = 'dc-code';
      tdCode.textContent = row.text || ' ';

      tr.appendChild(tdOld);
      tr.appendChild(tdNew);
      tr.appendChild(tdCode);
    }
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

function calcStats(raw: string): { add: number; del: number } {
  let add = 0; let del = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++;
    else if (line.startsWith('-') && !line.startsWith('---')) del++;
  }
  return { add, del };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}
