// review-actions.ts — 파이프라인 실행 버튼 + AI 충돌 머지 모달
import type {
  ItemChange,
  MergeResolvedFile,
  ReviewItemSummary,
  ReviewItemWithChanges,
} from '../../shared/types';
import { openDiffModal } from './review-diff-modal';

type AnyItem = ReviewItemSummary | ReviewItemWithChanges;

/** IPC로 보내기 전 changes 제거 — summary 필드만 필요 */
function toSummary(it: AnyItem): ReviewItemSummary {
  if ('changes' in it) {
    const { changes: _c, discussions: _d, ...rest } = it as ReviewItemWithChanges;
    void _c; void _d;
    return rest;
  }
  return it;
}

function initPipelineButton(getItem: () => AnyItem | null): void {
  const btn = document.getElementById('btn-pipeline') as HTMLButtonElement | null;
  if (!btn) return;
  const originalHtml = btn.innerHTML;
  const flash = (text: string, ms: number): void => {
    btn.textContent = text;
    window.setTimeout(() => { btn.innerHTML = originalHtml; btn.disabled = false; }, ms);
  };
  btn.addEventListener('click', () => {
    const item = getItem();
    if (!item || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '실행 중…';
    void window.electronAPI.runPipeline(toSummary(item)).then((res) => {
      if (res.success) {
        btn.title = '';
        flash('✓ 파이프라인 시작됨', 3000);
      } else {
        btn.title = res.error ?? '실패';
        flash('✗ 실패', 4000);
      }
    });
  });
}

// ── AI 머지 모달 ─────────────────────────────────────────────
function resolvedFileToChange(f: MergeResolvedFile): ItemChange {
  return {
    old_path: f.path,
    new_path: f.path,
    diff: f.diff,
    new_file: false,
    deleted_file: false,
    renamed_file: false,
  };
}

function openMergeModal(item: ReviewItemSummary): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.style.maxWidth = '560px';

  modal.innerHTML = `
    <header class="modal-header">
      <div class="col" style="gap: 2px; min-width: 0; flex: 1;">
        <strong>AI 충돌 해결 머지</strong>
        <span class="text-muted" style="font-size: var(--fs-xs);">
          ${item.targetBranch} → ${item.sourceBranch} 머지 · push 전까지 원격에 아무것도 반영되지 않습니다
        </span>
      </div>
      <button class="modal-close" aria-label="닫기" type="button">✕</button>
    </header>
    <div class="modal-body" style="display: flex; flex-direction: column; gap: var(--space-3);">
      <pre id="merge-progress" class="text-mono text-secondary"
           style="margin: 0; max-height: 180px; overflow-y: auto; white-space: pre-wrap; font-size: var(--fs-sm);"></pre>
      <ul id="merge-files" class="file-list" style="display: none;"></ul>
      <div class="row" style="justify-content: flex-end; gap: var(--space-2);">
        <button id="merge-push" class="btn btn-primary" type="button" style="display: none;">
          MR 브랜치에 Push
        </button>
      </div>
    </div>
  `;

  const progressEl = modal.querySelector<HTMLPreElement>('#merge-progress');
  const filesEl = modal.querySelector<HTMLUListElement>('#merge-files');
  const pushBtn = modal.querySelector<HTMLButtonElement>('#merge-push');

  const appendLine = (line: string): void => {
    if (!progressEl) return;
    progressEl.textContent = `${progressEl.textContent ?? ''}${line}\n`;
    progressEl.scrollTop = progressEl.scrollHeight;
  };

  const unsubscribe = window.electronAPI.onAiMergeProgress(({ line }) => appendLine(line));
  const close = (): void => {
    unsubscribe();
    backdrop.remove();
  };
  modal.querySelector('.modal-close')?.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  void window.electronAPI.startAiMerge(item).then((res) => {
    if (!res.success) {
      appendLine(`❌ ${res.error ?? '알 수 없는 오류'}`);
      return;
    }
    if (res.upToDate) return; // progress 라인으로 이미 안내됨
    const files = res.resolvedFiles ?? [];
    if (files.length > 0 && filesEl) {
      filesEl.style.display = '';
      for (const f of files) {
        const li = document.createElement('li');
        li.className = 'file-item';
        li.textContent = f.path;
        li.style.cursor = 'pointer';
        li.title = '클릭하여 AI 해결 결과 diff 보기';
        li.addEventListener('click', () => openDiffModal(resolvedFileToChange(f)));
        filesEl.appendChild(li);
      }
      appendLine('각 파일을 클릭해 AI 해결 결과를 확인한 뒤 push 하세요.');
    }
    if (pushBtn) {
      pushBtn.style.display = '';
      pushBtn.addEventListener('click', () => {
        pushBtn.disabled = true;
        pushBtn.textContent = 'Push 중…';
        void window.electronAPI.pushAiMerge().then((pr) => {
          if (pr.success) {
            appendLine('🚀 push 완료 — MR 브랜치에 머지 커밋이 반영되었습니다.');
            pushBtn.textContent = '완료';
          } else {
            appendLine(`❌ push 실패: ${pr.error ?? ''}`);
            pushBtn.disabled = false;
            pushBtn.textContent = 'MR 브랜치에 Push';
          }
        });
      });
    }
  });
}

function initMergeButton(getItem: () => AnyItem | null): void {
  const btn = document.getElementById('btn-ai-merge') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', () => {
    const item = getItem();
    if (!item) return;
    openMergeModal(toSummary(item));
  });
}

export function initReviewActions(getItem: () => AnyItem | null): void {
  initPipelineButton(getItem);
  initMergeButton(getItem);
}
