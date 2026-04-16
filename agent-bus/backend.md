# backend

STATUS: CLOSED (v2 전 단계 종료 — team-lead 공식 종료 공지 수신)
PHASE: 2 (v2 구현) — reviewer Phase 4 PASS 확정
REVISION: 5 — 공식 SDK (`@anthropic-ai/sdk` + `openai`) 기반 전환 완료
LAST_UPDATED: 2026-04-16
FINAL: backend/frontend/통합 PASS · Must-fix/Should-fix 없음 · 백로그 #14/#15 비블로킹 이관

---

## architect REVISION 5 반영 내역

### Critical 수정 (C1, C2)
- **C1 (`onMrNew` alias)**: `src/preload.ts` 에 `onMrNew` deprecated alias 추가. ITEM_NEW와 동일 채널 구독. v1 renderer 코드 호환.
- **C2 (delimiter `::` 통일)**: 모든 복합 ID 생성/파싱에서 `:` → `::` 변경 (team-lead 지시 + reviewer Critical). 4-part 포맷 유지:
  `${gitConfigId}::${providerType}::${projectId}::${itemId}`
  - `src/main/providers/git/gitlab-provider.ts` (normalize)
  - `src/main/providers/git/github-provider.ts` (normalize)
  - `src/main/ipc.ts` (COMMENT_POST stub)
  - `src/main/ipc.ts` (orphan pruning 에서 `id.split('::')[0]`)

### Major 수정 (M1, M2, M3, M5)
- **M1 (마이그레이션 이월 로직 제거)**: `src/main/store-migrate.ts` 별도 파일 분리. `isV1Settings` 타입 가드 + `migrateStoreV1ToV2`. `seenMrIds`/`recentMrs` 는 `[]` 로 초기화 (복합키 체계 불호환). `src/main/store.ts` 는 loose schema + clamp 만 담당.
- **M2 (ConnectionTestResult 일원화)**: `GitConnectionTestResult` → `ConnectionTestResult` 로 통합. `GitConnectionTestResult` 는 `@deprecated` alias로 유지.
- **M3 (factory exhaustive default)**: `createGitProvider` / `createAIProvider` 양쪽 `default` 분기에 `const _exhaustive: never = config` 추가 — 신규 variant 추가 시 컴파일 에러.
- **M5 (orphan pruning)**: `GIT_CONNECTIONS_SAVE` 핸들러에서 삭제된 `gitConfigId` 의 `recentItems` + `seenItemIds` 자동 정리.

### 추가 개선 (architect §7.2 IpcDeps 패턴)
- **`rebuildProviders` / `rebuildAIProvider` 콜백 주입**: `IpcDeps` 확장. GIT_CONNECTIONS_SAVE / AI_CONFIG_SAVE / SETTINGS_SAVE 시 각각 호출.
- **Silent pre-seed (`src/main/preseed.ts` 신규)**: v1→v2 마이그레이션 직후 또는 신규 연결 추가 시 `fetchOpenItems()` 1회 수행 → 결과를 seenItemIds 에 선-등록 (알림/렌더러 이벤트 미발송). 대량 재알림 방지.

### 스키마/타입 정정
- `projectPath` → `repoFullName` (architect REVISION 5 §1.3 / §4 일치)
- `CommentPostPayload` 에서 `providerType` 제거 (gitConfigId만으로 provider 조회 가능), `repoFullName` 추가
- `CommentPostResult.id` → `commentId` (architect 명명)
- `V1AppSettings` / `V1StoreSchema` 타입 `shared/types.ts` 에 추가 (store-migrate에서 import)

---

## 파일 라인 수 (모두 300줄 미만)
```
main/
  main.ts            295   ← silent pre-seed는 preseed.ts로 분리
  ipc.ts             264
  ipc-review.ts      101
  poller.ts          167
  review-runner.ts    91
  store.ts            43   ← migrate 로직은 store-migrate.ts로 분리
  store-migrate.ts    87
  preseed.ts          39
  tray.ts            191
  notifier.ts         56
  windows.ts          33
providers/git/
  git-provider.ts     36   ← exhaustive default 추가
  gitlab-provider.ts 174
  github-provider.ts 284
providers/ai/
  ai-provider.ts      48   ← exhaustive default 추가
  claude-cli.ts      148
  codex-cli.ts       111
  anthropic-api.ts    92   ← @anthropic-ai/sdk 로 SSE 직접 파싱 제거
  openai-api.ts       98   ← openai SDK 로 SSE 직접 파싱 제거
  ollama.ts          207
shared/
  types.ts           282
  constants.ts       111
preload.ts           191   ← onMrNew alias 추가
```

## 품질 체크
- `npx tsc -p tsconfig.json --noEmit` → 에러 0건
- `npx tsc -p tsconfig.json` (full emit) → 에러 0건
- any 타입: 0건
- console.log: 0건
- 파일 300줄 제한: 100% 준수

## Frontend 협업 주의 (v2 최종)
1. **타입 rename**: `MergeRequest*` → `ReviewItem*` (deprecated alias 유지)
2. **필드 rename 확정 리스트**:
   - `mr.iid` → `item.itemId`
   - `mr.web_url` → `item.webUrl`
   - `mr.source_branch` → `item.sourceBranch`
   - `mr.target_branch` → `item.targetBranch`
   - `mr.project_id` → `item.projectId`
   - GitHub 아이템은 `item.repoFullName` ("owner/repo")
3. **ReviewStartPayload**: `{ mr }` → `{ item }`
4. **CommentPostPayload**: `gitConfigId`, `itemId`, `projectId`, `body` (+ GitHub 는 `repoFullName` 필수)
5. **CommentPostResult**: `id` → `commentId`
6. **`onMrNew`** 는 v1 alias로 유지 (실제 채널 ITEM_NEW). 신규 코드는 `onItemNew` 권장.
7. **ConnectionTestResult** 단일 타입. GitLab → `userId`, GitHub → `username`. 호출측이 `config.type`으로 분기.

## 테스트 시나리오
- v1 → v2 마이그레이션: `seenMrIds`/`recentMrs` 초기화 + silent pre-seed 로 첫 폴링 조용
- Git 연결 추가 후 삭제: orphan pruning 으로 `recentItems`/`seenItemIds` 자동 정리
- AI 설정 변경: `rebuildAIProvider` 콜백 — 다음 REVIEW_START 부터 신 provider 사용

## Reviewer 2차 리뷰 준비 완료
architect REVISION 5 전 지시사항 반영. tsc 클린. Reviewer 검증 대기.

---

## REVISION 5 추가 — 공식 SDK 전환 (team-lead 지시, 2026-04-16)

### 변경
- `npm install @anthropic-ai/sdk openai` — package.json dependencies 에 `@anthropic-ai/sdk ^0.89.0`, `openai ^6.34.0` 추가.
- `src/main/providers/ai/anthropic-api.ts` — native https SSE 파싱 완전 제거, `client.messages.stream()` 이벤트(`text`/`end`/`error`) 중계. abort 는 `stream.controller.abort()`.
- `src/main/providers/ai/openai-api.ts` — native https/http SSE 파싱 완전 제거, `client.chat.completions.create({stream:true})` `AsyncIterable<ChatCompletionChunk>` 순회. abort 는 전달한 `AbortController.abort()`. `baseURL` 지정으로 Azure/OpenRouter/Groq 호환 유지.
- `testAvailability` 는 SDK 의 `models.list()` / `messages.create({max_tokens:1})` 로 간소화.

### 효과
- SSE 파서/HTTP 레벨 로직 제거 → anthropic-api.ts 188 → 92 줄, openai-api.ts 188 → 98 줄.
- SDK 가 재시도/타임아웃/에러 매핑을 제공 → 장기 유지보수성 향상.
- `AbortController` 표준 사용 → 중단 처리 신뢰성 개선.

### 타입체크
`npx tsc -p tsconfig.json --noEmit` → 0 errors.
