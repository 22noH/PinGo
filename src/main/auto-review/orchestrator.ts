// main/auto-review/orchestrator.ts — 자동 리뷰 동시성/대기열/진행 상황 오케스트레이션 (순수 로직)
//
// 정책:
//   - 동시 실행 최대 N개(설정 autoReviewConcurrency, 기본 5). 초과는 대기열로.
//   - 대기열은 FIFO 로 하나씩 꺼내 빈 슬롯을 채운다(순차 처리).
//   - 대기열은 무제한 — key dedup 덕에 크기가 열린 MR 수를 못 넘는다.
//     상한을 두고 오래된 항목을 버리면 리뷰/검증이 조용히 유실된다.
//     이미 실행 중인 동일 key 재요청은 무시(중복 방지), 대기 항목은 최신 payload 로 교체.
//   - 리뷰 완료 즉시 postResult 로 대상(PR/스레드)에 댓글 게시.
//   - 진행 상황(단계·시작 시각)과 최근 결과 이력을 들고 있다 — 백그라운드 작업이라
//     이게 없으면 "돌긴 하는데 뭘 하는지 모른다" 가 된다(트레이 메뉴가 snapshot 을 읽는다).
import type { AppSettings, Discussion } from '../../shared/types';
import { DEFAULT_AUTO_REVIEW_CONCURRENCY } from '../../shared/constants';

export interface AutoReviewRequest<T = unknown> {
  /** 중복 방지 key — 전체 리뷰는 item.id, 해결 검증은 `${item.id}#verify` */
  key: string;
  payload: T;
}

/** 실행 중 요청의 단계 갱신 — runReview 가 clone/AI 등 단계 전환마다 부른다 */
export type SetPhase = (phase: string) => void;

export interface OrchestratorDeps<T = unknown, R = unknown> {
  /** 동시 실행 상한 (설정에서 주입). < 1 이면 1로 강제. */
  maxConcurrent: number;
  /** 리뷰 1건 실행 (worktree clone + resolved 필터 + AI). */
  runReview: (req: AutoReviewRequest<T>, signal: AbortSignal, setPhase: SetPhase) => Promise<R>;
  /** 완료 즉시 대상 PR/스레드에 결과 댓글 게시. 반환 문자열은 이력 요약("댓글 게시" 등). */
  postResult: (req: AutoReviewRequest<T>, result: R) => Promise<string | void>;
  /** 에러 로깅 (선택). */
  logError?: (msg: string, req: AutoReviewRequest<T>) => void;
  /** 접수·단계·완료 등 상태가 바뀔 때마다 (트레이 메뉴 갱신용, 선택) */
  onChange?: () => void;
}

interface ActiveEntry<T> {
  req: AutoReviewRequest<T>;
  controller: AbortController;
  phase: string;
  startedAt: number;
}

export interface ActiveSnapshot<T> { key: string; payload: T; phase: string; startedAt: number }
export interface QueuedSnapshot<T> { key: string; payload: T }
export interface RecentSnapshot<T> { key: string; payload: T; ok: boolean; summary: string; at: number }

export interface OrchestratorSnapshot<T> {
  active: ActiveSnapshot<T>[];
  queued: QueuedSnapshot<T>[];
  /** 최근 완료/실패 — 최신이 앞 */
  recent: RecentSnapshot<T>[];
}

export const MAX_RECENT_RESULTS = 20;
const PHASE_POSTING = '결과 게시';

export class AutoReviewOrchestrator<T = unknown, R = unknown> {
  private max: number;
  private readonly deps: OrchestratorDeps<T, R>;
  // active/queue 모두 key 로 dedup. queue 는 삽입순 = LRU(오래된 것이 head).
  private readonly active = new Map<string, ActiveEntry<T>>();
  private queue: AutoReviewRequest<T>[] = [];
  private recent: RecentSnapshot<T>[] = [];

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

  /** 실행 중이거나 대기 중인 key 인지 */
  has(key: string): boolean {
    return this.active.has(key) || this.queue.some((q) => q.key === key);
  }

  /** 설정 변경 반영 — 재생성하면 대기열이 날아가므로 제자리에서 바꾼다 */
  setMaxConcurrent(n: number): void {
    this.max = Math.max(1, Math.floor(n));
    this.drain();
    this.deps.onChange?.();
  }

  /** 앱 종료 시 — 실행 중인 요청을 모두 abort(AI/git 자식 정리 신호)하고 대기열을 비운다 */
  abortAll(): void {
    this.queue = [];
    for (const e of this.active.values()) e.controller.abort();
    this.deps.onChange?.();
  }

  /** 트레이 메뉴용 현황 */
  snapshot(): OrchestratorSnapshot<T> {
    return {
      active: [...this.active.values()].map((e) => ({
        key: e.req.key, payload: e.req.payload, phase: e.phase, startedAt: e.startedAt,
      })),
      queued: this.queue.map((q) => ({ key: q.key, payload: q.payload })),
      recent: [...this.recent],
    };
  }

  /**
   * 신규 리뷰 요청. 슬롯이 비면 즉시 실행, 아니면 대기열에 넣는다(유실 없음).
   * @returns 접수됐으면 true. 이미 실행 중인 key 의 중복 요청은 버리고 false.
   */
  submit(req: AutoReviewRequest<T>): boolean {
    if (this.active.has(req.key)) return false; // 이미 실행 중 — 중복 무시
    const queuedIdx = this.queue.findIndex((q) => q.key === req.key);
    if (queuedIdx !== -1) {
      // 대기 중 재요청 — 순번은 유지하고 payload 만 최신으로 교체
      this.queue[queuedIdx] = req;
      return true;
    }
    if (this.active.size < this.max) {
      this.start(req);
    } else {
      this.queue.push(req);
    }
    this.deps.onChange?.();
    return true;
  }

  private start(req: AutoReviewRequest<T>): void {
    const controller = new AbortController();
    const entry: ActiveEntry<T> = { req, controller, phase: '시작', startedAt: Date.now() };
    this.active.set(req.key, entry);
    const setPhase: SetPhase = (phase) => {
      entry.phase = phase;
      this.deps.onChange?.();
    };
    void this.deps
      .runReview(req, controller.signal, setPhase)
      .then((result) => {
        setPhase(PHASE_POSTING);
        return this.deps.postResult(req, result); // 완료 즉시 댓글 게시
      })
      .then((summary) => this.record(req, true, summary || '완료'))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.logError?.(msg, req);
        this.record(req, false, msg);
      })
      .finally(() => {
        this.active.delete(req.key);
        this.drain();
        this.deps.onChange?.();
      });
  }

  private record(req: AutoReviewRequest<T>, ok: boolean, summary: string): void {
    this.recent.unshift({ key: req.key, payload: req.payload, ok, summary, at: Date.now() });
    if (this.recent.length > MAX_RECENT_RESULTS) this.recent.length = MAX_RECENT_RESULTS;
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
 * 설정 UI 변경 → 저장 → 이 함수 → 오케스트레이터 setMaxConcurrent 로 전달되는 배선의 접점.
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
