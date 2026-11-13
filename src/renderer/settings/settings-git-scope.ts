// settings-git-scope.ts — GitLab 연결의 "볼 프로젝트" 범위 UI (폼의 선택 영역 + 카드의 요약 줄)
// 프로젝트 토큰은 그 프로젝트로 고정(선택 불가), 개인 토큰은 멤버 / 직접 고르기 / 보이는 전체 중 선택.
// strict mode — no `any`, no console.log, XSS 방지(textContent 만 사용)
import type {
  ConnectionTestResult, GitLabConfig, GitProjectScopeMode, GitScopeProject,
} from '../../shared/types';

const CHIP_PREVIEW_MAX = 6;

const MODE_LABEL: Record<GitProjectScopeMode, string> = {
  member: '내가 멤버인 프로젝트',
  selected: '직접 고르기',
  all: '보이는 전체',
};

export interface ScopeControl {
  el: HTMLElement;
  /** 연결 테스트 결과 반영 */
  apply(result: ConnectionTestResult): void;
  /** 저장할 값 — 프로젝트 토큰이면 둘 다 undefined (범위는 토큰이 정한다) */
  value(): { projectScope?: GitProjectScopeMode; selectedProjectIds?: number[] };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chips(projects: GitScopeProject[]): HTMLElement {
  const wrap = el('div', 'scope-chips');
  if (projects.length === 0) {
    wrap.appendChild(el('span', 'field-hint', '멤버인 프로젝트가 없습니다.'));
    return wrap;
  }
  for (const p of projects.slice(0, CHIP_PREVIEW_MAX)) wrap.appendChild(el('span', 'scope-chip text-mono', p.path));
  const rest = projects.length - CHIP_PREVIEW_MAX;
  if (rest > 0) wrap.appendChild(el('span', 'scope-chip is-more', `외 ${rest}개`));
  return wrap;
}

export function createScopeControl(existing: GitLabConfig | null): ScopeControl {
  const root = el('div', 'field');
  root.appendChild(el('span', 'field-label', '볼 프로젝트'));
  const body = el('div', 'col');
  body.style.gap = 'var(--space-2)';
  root.appendChild(body);

  let tokenKind: ConnectionTestResult['tokenKind'];
  let member: GitScopeProject[] = [];
  let mode: GitProjectScopeMode = existing?.projectScope ?? 'member';
  const selected = new Set<number>(existing?.selectedProjectIds ?? []);

  function render(): void {
    body.innerHTML = '';
    if (!tokenKind) {
      body.appendChild(el('span', 'field-hint', '연결 테스트를 하면 이 토큰으로 볼 프로젝트가 표시됩니다.'));
      return;
    }
    if (tokenKind === 'project') {
      body.appendChild(el('span', 'badge badge-new badge-scope-locked', '프로젝트 토큰'));
      body.appendChild(el('span', 'field-hint',
        '이 토큰의 프로젝트에만 연결됩니다. 목록·알림·자동 리뷰가 모두 여기로 한정되며 바꿀 수 없습니다.'));
      body.appendChild(chips(member));
      return;
    }
    const radios = el('div', 'scope-modes');
    for (const m of ['member', 'selected', 'all'] as const) {
      const label = el('label', 'checkbox-row');
      const input = el('input');
      input.type = 'radio';
      input.name = 'form-project-scope';
      input.checked = mode === m;
      input.addEventListener('change', (): void => { mode = m; render(); });
      label.appendChild(input);
      label.appendChild(el('span', 'checkbox-label', MODE_LABEL[m]));
      radios.appendChild(label);
    }
    body.appendChild(radios);
    if (mode === 'member') body.appendChild(chips(member));
    if (mode === 'all') {
      body.appendChild(el('span', 'field-hint',
        '멤버가 아니어도 토큰으로 보이는 internal/public 프로젝트의 MR 까지 전부 가져옵니다.'));
    }
    if (mode === 'selected') body.appendChild(renderPicker());
  }

  function renderPicker(): HTMLElement {
    const list = el('div', 'scope-picker');
    if (member.length === 0) list.appendChild(el('span', 'field-hint', '멤버인 프로젝트가 없습니다.'));
    for (const p of member) {
      const label = el('label', 'checkbox-row');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = selected.has(p.id);
      input.addEventListener('change', (): void => {
        if (input.checked) selected.add(p.id);
        else selected.delete(p.id);
      });
      label.appendChild(input);
      label.appendChild(el('span', 'checkbox-label text-mono', p.path));
      list.appendChild(label);
    }
    return list;
  }

  render();
  return {
    el: root,
    apply(result: ConnectionTestResult): void {
      tokenKind = result.tokenKind;
      member = result.memberProjects ?? [];
      render();
    },
    value(): { projectScope?: GitProjectScopeMode; selectedProjectIds?: number[] } {
      if (tokenKind === 'project') return {};
      // 테스트 전(종류 모름)이면 기존 값을 그대로 유지한다
      if (!tokenKind) return { projectScope: existing?.projectScope, selectedProjectIds: existing?.selectedProjectIds };
      return {
        projectScope: mode,
        selectedProjectIds: mode === 'selected' ? [...selected] : undefined,
      };
    },
  };
}

/** 카드 요약 한 줄 — "프로젝트 토큰 · g/p 에만 연결" / "개인 토큰 @me · 멤버 프로젝트 6개" */
export function summarizeScope(cfg: GitLabConfig, r: ConnectionTestResult): string {
  if (!r.success) return `연결 확인 실패 — ${r.error ?? '알 수 없는 오류'}`;
  const member = r.memberProjects ?? [];
  if (r.tokenKind === 'project') {
    const names = member.slice(0, 2).map((p) => p.path).join(', ');
    const more = member.length > 2 ? ` 외 ${member.length - 2}개` : '';
    return `프로젝트 토큰 · ${names || '프로젝트 없음'}${more} 에만 연결`;
  }
  const who = r.username ? `개인 토큰 @${r.username}` : '개인 토큰';
  const mode = cfg.projectScope ?? 'member';
  if (mode === 'all') return `${who} · 보이는 전체 프로젝트`;
  if (mode === 'selected') return `${who} · 고른 프로젝트 ${(cfg.selectedProjectIds ?? []).length}개`;
  return `${who} · 멤버 프로젝트 ${member.length}개`;
}

/** 카드에 범위 요약을 비동기로 채운다 — 실패해도 카드는 그대로 쓸 수 있다 */
export function fillCardScope(target: HTMLElement, cfg: GitLabConfig): void {
  target.textContent = '범위 확인 중…';
  void (async (): Promise<void> => {
    try {
      const r = await window.electronAPI.testGitConnection({ config: cfg });
      target.textContent = summarizeScope(cfg, r);
      target.classList.toggle('is-locked', r.success && r.tokenKind === 'project');
      target.classList.toggle('is-error', !r.success);
    } catch {
      target.textContent = '범위를 확인하지 못했습니다.';
    }
  })();
}
