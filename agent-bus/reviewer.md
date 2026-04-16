# reviewer

STATUS: DONE
PHASE: 5 — task #22 — 1차 backend 최종 리뷰 (main/, shared/, preload.ts)
RESULT: **PASS (머지 승인)**
LAST_UPDATED: 2026-04-16 (task #22)

---

## 1차 backend 최종 리뷰 (task #22) — 실측 체크리스트

### 정책 준수 (금지사항)
| 항목 | 결과 |
|---|---|
| `any` 타입 | ✓ 0건 (src 내 5개 매치는 전부 주석 내 "no `any` allowed" 설명 문구) |
| `console.log/info/warn/error/debug` | ✓ main/ 0건 (electron-log 전용) |
| `innerHTML` XSS | ✓ main/ 0건 |
| `nodeIntegration:false` + `contextIsolation:true` + `sandbox:true` | ✓ `src/main/windows.ts:25-27` |
| 파일 300줄 제한 | ✓ 100% (최대 295줄 — main.ts) |
| 하드코딩 | ✓ 전부 `shared/constants.ts` |
| 토큰/헤더 마스킹 | ✓ `main.ts:36-50` log hook + 각 provider axios interceptor |

### v2 IPC 계약 일치
- `preload.ts:85` `onItemNew` 정식 / `:87,174` `onMrNew` deprecated alias (동일 채널) ✓
- `ipc.ts:74` ``${cfg.id}::${cfg.type}::${payload.projectId}::${payload.itemId}`` 4-part id 생성 ✓
- `ipc.ts:197` `const [gitConfigId] = id.split('::')` orphan pruning 파싱 일치 ✓
- `ipc.ts:86` `repoFullName: payload.repoFullName` 패스스루 ✓ (`projectPath` 잔존 0건)
- 10개 v2 IPC 핸들러 모두 등록 + unregister 대칭 (`ipc.ts:245-264`) ✓
- `types.ts:109,172` `repoFullName?: string` 일관 ✓

### 파일 라인 수 (300줄 제약 준수)
| 파일 | 줄 |
|---|---|
| main/main.ts | 295 |
| main/providers/git/github-provider.ts | 284 |
| shared/types.ts | 282 |
| main/ipc.ts | 264 |
| main/providers/ai/ollama.ts | 207 |
| preload.ts | 191 |
| main/tray.ts | 191 |
| main/providers/git/gitlab-provider.ts | 174 |
| main/poller.ts | 167 |
| main/providers/ai/claude-cli.ts | 148 |
| main/providers/ai/codex-cli.ts | 111 |
| shared/constants.ts | 111 |
| main/ipc-review.ts | 101 |
| main/providers/ai/openai-api.ts | 98 |
| main/providers/ai/anthropic-api.ts | 92 |
| main/review-runner.ts | 91 |
| main/store-migrate.ts | 87 |
| main/notifier.ts | 56 |
| main/providers/ai/ai-provider.ts | 48 |
| main/store.ts | 43 |
| main/preseed.ts | 39 |
| main/windows.ts | 33 |

### 아키텍처 정합성
- **factory exhaustive never**: `git-provider.ts:32`, `ai-provider.ts:44` ✓
- **poller**: `Promise.allSettled` 병렬 + `AbortController` 재시작 시 취소 (`poller.ts:44-52,69,154-158`); axios isCancel 관대 처리 ✓
- **store-migrate**: `[]` 초기화 + legacy `seenMrIds`/`recentMrs` delete (`store-migrate.ts:78-82`) ✓
- **silent pre-seed (M6, 비블로킹)**: `main.ts:234` (GIT_CONNECTIONS_SAVE 변경 시) + `:258` (최초 기동) 양쪽 적용, `preseed.ts:17-39` ✓
- **orphan pruning**: `ipc.ts:189-200` id split 기반 ✓
- **AI stream handle**: 5개 provider 전부 `AIStreamHandle` 일관 (aborted/errored 가드, 이중 호출 방지)
- **review-runner**: previous abort 후 새 run (`ipc-review.ts:59-62`) — 이중 스트림 방지 ✓

### tsc
```
npx tsc -p tsconfig.json --noEmit
# exit=0, 0 errors
```

---

## 비블로킹 관찰 (기능 정상, 액션 불요)

1. **`github-provider.ts:260` projectId fallback**: `detail.base.repo.id` 없을 때 `search.id` (issue DB id) 사용. 실제 API 호출은 `repoFullName` 기반이므로 기능 영향 없음.
2. **`ipc.ts:77` providerLabel 하드코딩**: `cfg.type === 'gitlab' ? 'GL' : 'GH'` 대신 `PROVIDER_SHORT_LABEL[cfg.type]` 이면 constants 일관성 좋음. stub 객체라 기능 영향 없음.
3. **Ollama `req.destroy()`**: 명시적 cancel() 없이 OK — http 모듈 표준.

---

## 최종 판정

# PASS

- backend: **PASS** (main/, shared/, preload.ts 전수)
- Must-fix: 없음
- Should-fix: 없음
- 비블로킹 관찰 3건: 기능 정상, 추후 리팩터링 여지만 있음

**머지 승인 가능. 즉시 반영 가능.**

---

## 과거 결과 (참고 보존)
- Phase 1 (v1): PASS
- Phase 2 (v2 1차): CONDITIONAL PASS (C-NEW-1 외 7건)
- Phase 3 (v2 재리뷰): PASS (C-NEW-1 해결 확인)
- Phase 4 (SDK 교체 포함): PASS
- **Phase 5 (task #22, 1차 backend 최종 리뷰): PASS**
