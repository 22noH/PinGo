// review-diff-modal.ts — 파일 diff 모달 다이얼로그 (v2 ItemChange)
import type { ItemChange } from '../../shared/types';

export function openDiffModal(change: ItemChange): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.tabIndex = -1;

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const path = change.new_path || change.old_path;
  const status = change.new_file ? 'new'
    : change.deleted_file ? 'deleted'
    : change.renamed_file ? 'renamed' : 'modified';

  modal.innerHTML = `
    <header class="modal-header">
      <div class="col" style="gap: 2px; min-width: 0;">
        <div class="modal-title truncate">${escapeHtml(path)}</div>
        <div class="row" style="gap: var(--space-2); font-size: var(--fs-xs);">
          <span class="badge badge-muted">${status}</span>
          ${change.renamed_file ? `<span class="text-muted text-mono">← ${escapeHtml(change.old_path)}</span>` : ''}
        </div>
      </div>
      <button class="modal-close" aria-label="닫기" type="button">✕</button>
    </header>
    <div class="modal-body" style="padding: 0;">
      <div class="diff" id="diff-content"></div>
    </div>
  `;

  const diffEl = modal.querySelector<HTMLElement>('#diff-content');
  if (diffEl) renderDiff(diffEl, change.diff);

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

function renderDiff(host: HTMLElement, rawDiff: string): void {
  host.innerHTML = '';
  for (const line of rawDiff.split('\n')) {
    const div = document.createElement('div');
    div.className = 'diff-line ' + diffLineClass(line);
    div.textContent = line || ' ';
    host.appendChild(div);
  }
}

function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'is-hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'is-ctx';
  if (line.startsWith('+')) return 'is-add';
  if (line.startsWith('-')) return 'is-del';
  return 'is-ctx';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}
