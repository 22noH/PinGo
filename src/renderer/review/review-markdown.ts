// review-markdown.ts — marked.js 파셜 마크다운 렌더링 유틸
// 스트리밍 중 미완성 코드블록/인라인 백틱을 안전하게 렌더링한다.

interface MarkedLike {
  parse: (src: string) => string;
  setOptions?: (opts: { breaks?: boolean; gfm?: boolean }) => void;
}

declare global {
  interface Window {
    marked?: MarkedLike;
  }
}

/**
 * marked 초기화 — CDN 스크립트가 로드된 후 호출.
 * 로드 전에 호출되면 false 반환.
 */
export function initMarked(): boolean {
  if (!window.marked) return false;
  window.marked.setOptions?.({ breaks: true, gfm: true });
  return true;
}

/**
 * 스트리밍 중인 텍스트를 안전하게 마크다운으로 변환.
 * 미닫힌 ``` 코드블록을 임시로 닫아 렌더링 깨짐을 방지.
 */
export function renderPartial(text: string): string {
  if (!window.marked) {
    return escapeHtml(text);
  }
  const safe = closeOpenFences(text);
  return window.marked.parse(safe);
}

/**
 * 백틱 3개 펜스가 홀수 개면(= 열린 블록이 있으면) 끝에 닫기 펜스 추가.
 * 인라인 백틱도 홀수면 닫아준다.
 */
function closeOpenFences(src: string): string {
  let out = src;
  const fenceCount = (out.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 === 1) {
    out += '\n```';
  }
  const inlineTicks = (out.match(/(?<!`)`(?!`)/g) ?? []).length;
  if (inlineTicks % 2 === 1) {
    out += '`';
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}
