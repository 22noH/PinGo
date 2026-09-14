// main/poller-unavailable.ts — 폴링 부가 조회(승인/파이프라인)의 404 기억 (순수 로직)
//
// 승인 상태 endpoint 가 404 면 그 프로젝트/티어에 기능이 없는 것이라 영구적이다.
// 매 tick 다시 물어보면 30초마다 같은 경고가 로그를 채워 정작 필요한 줄이 안 보인다
// (main.log 1.3MB 의 99% 가 이 반복이었다, 20260914). 한 번 404 면 기억하고 건너뛴다.
// 앱을 재시작하면 잊는다 — 기능이 나중에 켜졌을 수도 있으니 그 정도 재시도는 적당하다.

const MAX_SUMMARY_CHARS = 200;

/** axios 류 오류에서 HTTP 상태 코드를 꺼낸다. 없으면 undefined. */
export function httpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as { response?: { status?: unknown } }).response?.status;
  return typeof status === 'number' ? status : undefined;
}

/** 로그용 한 줄 요약 — 메시지만. 객체를 통째로 찍으면 헤더/스택까지 딸려온다. */
export function errorSummary(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, MAX_SUMMARY_CHARS);
}

export interface UnavailableTracker {
  /** 이 key 가 404 로 기억돼 있는지 — true 면 조회를 건너뛴다 */
  has(key: string): boolean;
  /**
   * 오류가 404 면 key 를 기억한다.
   * @returns 이번에 처음 기억했으면 true(로그 1회용). 이미 기억됐거나 404 가 아니면 false.
   */
  markIfNotFound(key: string, err: unknown): boolean;
}

export function createUnavailableTracker(): UnavailableTracker {
  const keys = new Set<string>();
  return {
    has: (key) => keys.has(key),
    markIfNotFound: (key, err) => {
      if (httpStatus(err) !== 404 || keys.has(key)) return false;
      keys.add(key);
      return true;
    },
  };
}
