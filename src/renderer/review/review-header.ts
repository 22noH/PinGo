// review-header.ts — MR/PR 헤더 렌더링 (review.ts 보조)
// strict mode — no `any`, no console.log
import type { ReviewItemSummary, ReviewItemWithChanges } from '../../shared/types';
import { PROVIDER_SHORT_LABEL, PROVIDER_DISPLAY_NAME } from '../../shared/constants';

type AnyItem = ReviewItemSummary | ReviewItemWithChanges;

export interface HeaderRefs {
  mrIid: HTMLElement;
  mrTitle: HTMLElement;
  mrBranch: HTMLElement;
  mrAuthor: HTMLElement;
  mrLink: HTMLAnchorElement;
}

export function renderHeader(refs: HeaderRefs, item: AnyItem | null): void {
  if (!item) {
    refs.mrIid.textContent = 'MR #—';
    refs.mrTitle.textContent = '로딩 중…';
    refs.mrBranch.textContent = '— → —';
    refs.mrAuthor.textContent = '—';
    refs.mrLink.href = '#';
    refs.mrLink.textContent = 'GitLab에서 열기';
    document.title = 'Pingo — AI Review';
    return;
  }
  refs.mrIid.innerHTML = '';
  const badge = document.createElement('span');
  badge.className = `provider-badge is-${item.providerType}`;
  badge.textContent = PROVIDER_SHORT_LABEL[item.providerType] || item.providerLabel || '';
  badge.style.marginRight = '6px';
  refs.mrIid.appendChild(badge);
  const label = document.createElement('span');
  label.textContent = `${item.providerType === 'github' ? 'PR' : 'MR'} #${item.itemId}`;
  refs.mrIid.appendChild(label);

  refs.mrTitle.textContent  = item.title;
  refs.mrBranch.textContent = `${item.sourceBranch} → ${item.targetBranch}`;
  refs.mrAuthor.textContent = `@${item.author.username}`;
  refs.mrLink.href          = item.webUrl;
  refs.mrLink.textContent   = `${PROVIDER_DISPLAY_NAME[item.providerType]}에서 열기`;
  document.title = `${item.providerType === 'github' ? 'PR' : 'MR'} #${item.itemId} — ${item.title}`;
}
