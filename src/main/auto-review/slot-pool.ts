// main/auto-review/slot-pool.ts — 프로젝트별 클론 슬롯 대여/반납 (순수 로직)
//
// 왜: MR 마다 새로 클론하면 큰 저장소는 1건당 400초가 든다(oneguide 실측 408초).
//     슬롯을 재사용해 브랜치만 갈아끼우면 8~17초다. 40배 차이라 재사용이 전부다.
//
// 정책:
//   - 슬롯은 프로젝트 단위. 슬롯 하나 = 클론 하나(작업 트리 포함)라 디스크를 크게 먹는다
//     (oneguide 기준 7.7GB/슬롯). 개수는 설정값으로 제한한다.
//   - 대여 요청이 오면 노는 슬롯을 준다. 없고 상한 미만이면 새 슬롯을 만든다.
//     상한까지 다 쓰고 있으면 반납될 때까지 기다린다(FIFO).
//   - 이 모듈은 디렉터리 배정만 한다. clone/fetch/checkout 은 호출측(worktree.ts)이 한다.
//
// ponytail: 슬롯 상한이 동시 실행 상한보다 작으면, 같은 프로젝트 리뷰들이 오케스트레이터
//   슬롯을 쥔 채 대기해 다른 프로젝트가 밀릴 수 있다. 프로젝트가 섞여 돌아가는 게
//   문제가 되면 그때 오케스트레이터에 프로젝트별 공평 배분을 넣는다.

export interface SlotLease {
  /** 이 리뷰가 쓸 디렉터리 */
  dir: string;
  /** 이 슬롯이 이번에 처음 만들어졌는지 — true 면 호출측이 clone 해야 한다 */
  fresh: boolean;
  /** 반납. 반드시 finally 에서 호출할 것 — 안 하면 슬롯이 영영 잠긴다. */
  release: () => void;
}

interface Slot {
  dir: string;
  busy: boolean;
  /** 한 번이라도 clone 이 성공했는지 */
  provisioned: boolean;
}

/** 프로젝트 키 → 슬롯 목록 */
const pools = new Map<string, Slot[]>();
/** 프로젝트 키 → 빈 슬롯을 기다리는 요청들 (FIFO) */
const waiters = new Map<string, Array<(slot: Slot) => void>>();

/** 슬롯 디렉터리 이름 — `<baseDir>/<key>/slot-N` */
function slotDir(baseDir: string, key: string, index: number, sep: string): string {
  return `${baseDir}${sep}${key}${sep}slot-${index}`;
}

function takeFree(slots: Slot[]): Slot | null {
  // provisioned 된 슬롯을 우선 준다 — clone 을 다시 하지 않기 위해
  const ready = slots.find((s) => !s.busy && s.provisioned);
  if (ready) return ready;
  return slots.find((s) => !s.busy) ?? null;
}

/**
 * 프로젝트 슬롯을 빌린다. 노는 슬롯이 없고 상한에 도달했으면 반납될 때까지 기다린다.
 * @param key      프로젝트 식별자 (gitConfigId + projectId 조합 권장 — 서버가 달라도 안 겹치게)
 * @param baseDir  슬롯들이 놓일 최상위 폴더
 * @param maxSlots 프로젝트당 슬롯 상한 (1 미만이면 1로 강제)
 * @param sep      경로 구분자 (기본 '/', Windows 는 호출측에서 path.sep 전달)
 */
export function leaseSlot(
  key: string,
  baseDir: string,
  maxSlots: number,
  sep = '/',
): Promise<SlotLease> {
  const max = Math.max(1, Math.floor(maxSlots));
  const slots = pools.get(key) ?? [];
  if (!pools.has(key)) pools.set(key, slots);

  const lease = (slot: Slot): SlotLease => {
    slot.busy = true;
    const fresh = !slot.provisioned;
    let released = false;
    return {
      dir: slot.dir,
      fresh,
      release: (): void => {
        if (released) return; // 이중 반납 방지 — 두 번 풀면 한 슬롯을 둘이 쓴다
        released = true;
        slot.busy = false;
        const queue = waiters.get(key);
        const next = queue?.shift();
        if (next) next(slot);
      },
    };
  };

  const free = takeFree(slots);
  if (free) return Promise.resolve(lease(free));

  if (slots.length < max) {
    const slot: Slot = { dir: slotDir(baseDir, key, slots.length, sep), busy: false, provisioned: false };
    slots.push(slot);
    return Promise.resolve(lease(slot));
  }

  // 상한까지 사용 중 — 반납을 기다린다
  return new Promise<SlotLease>((resolve) => {
    const queue = waiters.get(key) ?? [];
    if (!waiters.has(key)) waiters.set(key, queue);
    queue.push((slot: Slot) => resolve(lease(slot)));
  });
}

/** clone 성공 표시 — 다음 대여부터는 fetch/checkout 만 하면 된다 */
export function markProvisioned(key: string, dir: string): void {
  const slot = pools.get(key)?.find((s) => s.dir === dir);
  if (slot) slot.provisioned = true;
}

/** clone 실패 표시 — 다음 대여 때 다시 clone 하도록 되돌린다 */
export function markBroken(key: string, dir: string): void {
  const slot = pools.get(key)?.find((s) => s.dir === dir);
  if (slot) slot.provisioned = false;
}

/** 진단/테스트용 */
export function poolStatus(key: string): { total: number; busy: number; waiting: number } {
  const slots = pools.get(key) ?? [];
  return {
    total: slots.length,
    busy: slots.filter((s) => s.busy).length,
    waiting: waiters.get(key)?.length ?? 0,
  };
}

/** 테스트용 초기화 */
export function resetPools(): void {
  pools.clear();
  waiters.clear();
}
