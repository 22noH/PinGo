# backend

STATUS: DONE
PHASE: 1
REVISION: 2 반영 완료 + Reviewer 1차 Minor 3건 반영
COMPLETED_STEPS: [1, 2, 3, 4, 5, 6, 7, 8, 9]
LAST_UPDATED: 2026-04-15

---

## Architect REVISION 2 브리핑 반영 완료

### 타입 분리
- `MergeRequestSummary` / `MergeRequestWithChanges` 적용
- `MergeRequest` = union alias
- `fetchOpenMrs` → `MergeRequestSummary[]`
- `fetchMrChanges` → `MergeRequestWithChanges`
- `MrFoundCallback` → `(MergeRequestSummary[]) => void`
- `StoreSchema.recentMrs` → `MergeRequestSummary[]`
- `ReviewStartPayload.mr` → `MergeRequestSummary` (main에서 changes lazy fetch)
- `AppSettings.includeMentioned?: boolean` 추가 (v1은 읽기만, 폴링 쿼리에는 미적용)
- `ConnectionTestResult` 추가

### Claude CLI (stream-json)
- `spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose'])`
- 프롬프트 stdin 주입 (`proc.stdin.write` + `end`)
- stdout 라인버퍼 → JSON.parse → `{type:'text', text}` → onChunk
- `{type:'error', error.message}` → onError
- `ENOENT` 매핑: "Claude CLI가 설치되지 않았습니다. `claude` 명령이 PATH에 있는지 확인하세요."

### IPC 신규
- `SETTINGS_TEST = 'settings:test'` 상수 추가
- `ipc.ts` `handleSettingsTest` → `fetchCurrentUser` (`GET /api/v4/user`) 호출 → `ConnectionTestResult`
- `preload.ts` `testConnection(): Promise<ConnectionTestResult>` 노출

### 보안 마스킹
- `poller.ts` `makeClient`: axios response interceptor에서 `PRIVATE-TOKEN`/`Authorization` → `[REDACTED]` 후 electron-log 기록
- `main.ts` 최상단: `log.hooks.push(...)` 로 `glpat-*` 패턴 로그 마스킹

### 기타
- `app.requestSingleInstanceLock()` — 실패 시 즉시 `app.quit()`
- `app.on('second-instance', ...)` — 설정 창 포커스
- `store.ts`: `// TODO (v2): token OS keychain 연동 (keytar)` 주석 추가

## 파일 라인수 (전부 300줄 미만, any 0건, console.log 0건)
- main.ts 257, poller.ts 239, review-runner.ts 195, ipc.ts 193, tray.ts 167, preload.ts 120, types.ts 121, notifier.ts 56, constants.ts 58, store.ts 51

## Frontend 협업 주의
- `ReviewStartPayload.mr`은 이제 `MergeRequestSummary` 타입 (changes 미포함).
  Renderer는 리뷰 시작 시 요약만 전달하면 main에서 자동으로 `fetchMrChanges` 수행.
- `onMrNew` 콜백은 `MergeRequestSummary` 타입.
- 신규 API: `window.electronAPI.testConnection(): Promise<ConnectionTestResult>` — 설정창 "테스트" 버튼에 사용.

---

## Reviewer 1차 리뷰 Minor 수정 (2026-04-15)

### 1. store.ts — recentMrs 스키마 보강
- `recentMrs.items: { type: 'object' }` 추가 (손상 데이터 방어)

### 2. main.ts — singleInstanceLock 실패 시 early-exit
- `app.quit()`는 비동기이므로 이후 초기화 로직이 실행될 여지가 있음
- top-level `return`은 TS module 컨텍스트에서 불가 → `process.exit(0)`으로 즉시 차단
- 의도(이후 코드 실행 방지)는 동일하게 달성

### 3. ipc.ts handleCommentPost — 설정 가드
- `settings.token`/`settings.gitlabUrl` 빈값이면 `{ success: false, error: '설정이 완료되지 않았습니다.' }` 조기 반환

### v2 보류
- second-instance 핸들러 UX 개선
- runClaudeReview AbortController 도입
