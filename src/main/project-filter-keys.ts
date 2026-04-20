// main/project-filter-keys.ts — ProjectFilter 키 유틸 (§20.13.I3)
//
// 키공간:
//   Git:  `${gitConfigId}::${providerType}::${projectId}`  (3-part)
//   Jira: `${jiraConfigId}::jira::${projectKey}`           (3-part, 중간 segment='jira')
//
// 판별: `key.split('::')[1] === 'jira'` 이면 Jira filter, 그 외는 Git filter.
// ReviewItemSummary.id (4-part) 와 섞이지 않도록 주의.

import type {
  JiraIssueSummary,
  ProjectFilter,
  ReviewItemSummary,
} from '../shared/types';

/** key 가 Jira 키인지 판별 — 공통 소비측(notifier/tray)에서 사용. */
export function isJiraFilterKey(key: string): boolean {
  return key.split('::')[1] === 'jira';
}

/** Git ReviewItem → 3-part Git key */
export function gitFilterKeyFromItem(item: ReviewItemSummary): string {
  return `${item.gitConfigId}::${item.providerType}::${item.projectId}`;
}

/** Jira issue → 3-part Jira key */
export function jiraFilterKeyFromIssue(issue: JiraIssueSummary): string {
  return `${issue.jiraConfigId}::jira::${issue.projectKey}`;
}

/** 명시 인자로 Jira 키 조립 */
export function jiraFilterKey(jiraConfigId: string, projectKey: string): string {
  return `${jiraConfigId}::jira::${projectKey}`;
}

/** 명시 인자로 Git 키 조립 */
export function gitFilterKey(
  gitConfigId: string,
  providerType: 'gitlab' | 'github',
  projectId: number | string,
): string {
  return `${gitConfigId}::${providerType}::${projectId}`;
}

/**
 * notifier 에서 뮤트 여부 질의용 — filters 가 비어있거나 해당 키의 muted===true 가 아니면 false.
 * O(n) 선형 탐색이지만 projectFilters 는 실사용에서 수십 개 이하 가정.
 */
export function isProjectMuted(filters: ProjectFilter[], key: string): boolean {
  for (const f of filters) {
    if (f.projectKey === key) return f.muted;
  }
  return false;
}

/** Git 아이템 뮤트 여부 */
export function isGitItemMuted(filters: ProjectFilter[], item: ReviewItemSummary): boolean {
  return isProjectMuted(filters, gitFilterKeyFromItem(item));
}

/** Jira 이슈 뮤트 여부 */
export function isJiraIssueMuted(filters: ProjectFilter[], issue: JiraIssueSummary): boolean {
  return isProjectMuted(filters, jiraFilterKeyFromIssue(issue));
}

/**
 * 손상 레코드 필터 — 키가 `::` 2개 포함(3-part) 아닌 것은 버림.
 * store-migrate 후 외부 편집 방어.
 */
export function sanitizeProjectFilters(raw: unknown): ProjectFilter[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectFilter[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const obj = e as { projectKey?: unknown; muted?: unknown; displayLabel?: unknown };
    if (typeof obj.projectKey !== 'string') continue;
    if (obj.projectKey.split('::').length !== 3) continue;
    out.push({
      projectKey: obj.projectKey,
      muted: Boolean(obj.muted),
      displayLabel: typeof obj.displayLabel === 'string' ? obj.displayLabel : undefined,
    });
  }
  return out;
}
