// branch-utils.ts — 브랜치명 생성/검증 유틸 (branch-modal 보조)
// §20.7 규칙 구현. strict mode — no `any`, no console.log
import { BRANCH_NAME_MAX_SLUG_LEN, BRANCH_NAME_MAX_TOTAL_LEN } from '../../shared/constants';

/**
 * slugify: NFKD 정규화 → ascii → 소문자 → `[a-z0-9]` + `-` 외 치환 →
 *          연속 `-` 축약 → 앞뒤 트림 → 최대 40자 (단어 경계 절단).
 */
export function slugify(title: string): string {
  const ascii = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const lower = ascii.toLowerCase();
  let s = lower.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  if (s.length > BRANCH_NAME_MAX_SLUG_LEN) {
    s = s.slice(0, BRANCH_NAME_MAX_SLUG_LEN);
    const idx = s.lastIndexOf('-');
    if (idx >= Math.floor(BRANCH_NAME_MAX_SLUG_LEN * 0.6)) s = s.slice(0, idx);
    s = s.replace(/-+$/g, '');
  }
  return s;
}

/** 브랜치명 검증 — 유효하면 null, 문제가 있으면 에러 메시지 */
export function validateBranchName(name: string): string | null {
  if (!name) return '브랜치명이 비어 있습니다.';
  if (/\s/.test(name)) return '공백 문자는 허용되지 않습니다.';
  if (/[~^:?*\[\\]/.test(name)) return '금칙 문자 (~ ^ : ? * [ \\) 가 포함되어 있습니다.';
  if (name.startsWith('-')) return '브랜치명은 \'-\' 로 시작할 수 없습니다.';
  if (name.includes('..')) return '연속된 점(..) 은 허용되지 않습니다.';
  if (name.includes('.lock')) return '.lock 문자열은 허용되지 않습니다.';
  if (name.length > BRANCH_NAME_MAX_TOTAL_LEN) return `브랜치명이 너무 깁니다 (${BRANCH_NAME_MAX_TOTAL_LEN}자 초과).`;
  return null;
}
