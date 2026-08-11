// main/auto-review/orchestrator.ts — 자동 리뷰 동시성/대기열/LRU 오케스트레이션 (순수 로직)
//
// 정책:
//   - 동시 실행 최대 N개(설정 autoReviewConcurrency, 기본 5). 초과는 대기열로.
//   - 대기열은 FIFO 로 하나씩 꺼내 빈 슬롯을 채운다(순차 처리).
//   - 대기열은 무제한 — key(MR id) dedup 덕에 크기가 열린 MR 수를 못 넘는다.
//     상한을 두고 오래된 항목을 버리면 리뷰/검증이 조용히 유실된다(트리거는 일회성이라
//     seenUpdatedAt 갱신 후 버려지면 MR 에 다른 변화가 올 때까지 재시도가 없다).
//     이미 대기/실행 중인 동일 key 재요청은 무시(중복 방지, 대기 항목은 최신 payload 로 교체).
//   - 리뷰 완료 즉시 postResult 로 대상(PR/스레드)에 댓글 게시.
import type { AppSettings, Discussion } from '../../shared/types';
import { DEFAULT_AUTO_REVIEW_CONCURRENCY } from '../../shared/constants';

export interface AutoReviewRequest<T = unknown> {
  /** 중복 방지 key — 보통 item.id */
  key: string;
  payload: T;
}

export interface OrchestratorDeps<T = unknown, R = unknown> {
  /** 동시 실행 상한 (설정에서 주입). < 1 이면 1로 강제. */
  maxConcurrent: number;
  /** 리뷰 1건 실행 (worktree clone + resolved 필터 + AI). */
  runReview: (req: AutoReviewRequest<T>, signal: AbortSignal) => Promise<R>;
  /** 완료 즉시 대상 PR/스레드에 결과 댓글 게시. */
  postResult: (req: AutoReviewRequest<T>, result: R) => Promise<void>;
  /** 에러 로깅 (선택). */
  logError?: (msg: string, req: AutoReviewRequest<T>) => void;
}

interface ActiveEntry<T> {
  req: AutoReviewRequest<T>;
  controller: AbortController;
}

export class AutoReviewOrchestrator<T = unknown, R = unknown> {
  private readonly max: number;
  private readonly deps: OrchestratorDeps<T, R>;
  // active/queue 모두 key 로 dedup. queue 는 삽입순 = LRU(오래된 것이 head).
  private readonly active = new Map<string, ActiveEntry<T>>();
  private queue: AutoReviewRequest<T>[] = [];

  constructor(deps: OrchestratorDeps<T, R>) {
    this.deps = deps;
    this.max = Math.max(1, Math.floor(deps.maxConcurrent));
  }

  get activeCount(): number {
    return this.active.size;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** 신규 리뷰 요청. 중복이면 무시, 슬롯이 비면 즉시 실행, 아니면 대기열에 넣는다(유실 없음). */
  submit(req: AutoReviewRequest<T>): void {
    if (this.active.has(req.key)) return; // 이미 실행 중 — 중복 무시
    const queuedIdx = this.queue.findIndex((q) => q.key === req.key);
    if (queuedIdx !== -1) {
      // 대기 중 재요청 — 순번은 유지하고 payload 만 최신으로 교체
      this.queue[queuedIdx] = req;
      return;
    }
    if (this.active.size < this.max) {
      this.start(req);
      return;
    }
    this.queue.push(req);
  }

  private start(req: AutoReviewRequest<T>): void {
    const controller = new AbortController();
    this.active.set(req.key, { req, controller });
    void this.deps
      .runReview(req, controller.signal)
      .then((result) => this.deps.postResult(req, result)) // 완료 즉시 댓글 게시
      .catch((err: unknown) => {
        this.deps.logError?.(err instanceof Error ? err.message : String(err), req);
      })
      .finally(() => {
        this.active.delete(req.key);
        this.drain();
      });
  }

  private drain(): void {
    while (this.active.size < this.max && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) this.start(next);
    }
  }
}

/**
 * 설정에서 자동 리뷰 동시 상한을 읽는다. 미설정/비정상값이면 기본값.
 * 설정 UI 변경 → 저장 → 이 함수 → 오케스트레이터 maxConcurrent 로 전달되는 배선의 접점.
 */
export function resolveAutoReviewConcurrency(
  settings: Pick<AppSettings, 'autoReviewConcurrency'>,
): number {
  const n = settings.autoReviewConcurrency;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1
    ? Math.floor(n)
    : DEFAULT_AUTO_REVIEW_CONCURRENCY;
}

/** 저장된 설정값을 동시 상한으로 반영해 오케스트레이터를 생성한다(백엔드 진입점). */
export function createAutoReviewOrchestrator<T = unknown, R = unknown>(
  settings: Pick<AppSettings, 'autoReviewConcurrency'>,
  deps: Omit<OrchestratorDeps<T, R>, 'maxConcurrent'>,
): AutoReviewOrchestrator<T, R> {
  return new AutoReviewOrchestrator<T, R>({
    ...deps,
    maxConcurrent: resolveAutoReviewConcurrency(settings),
  });
}

/** resolved(해결됨) 스레드 판별 — resolved === true 인 것만 해결로 본다(undefined=일반 코멘트는 미해결 취급). */
export function isResolved(d: Discussion): boolean {
  return d.resolved === true;
}

/**
 * 리뷰 대상에 포함할 스레드만 남긴다(B안).
 * resolved 스레드는 제외 → 중복/재리뷰 댓글 방지. 미해결/일반 코멘트는 포함.
 */
export function reviewableDiscussions(discussions: Discussion[]): Discussion[] {
  return discussions.filter((d) => !isResolved(d));
}
